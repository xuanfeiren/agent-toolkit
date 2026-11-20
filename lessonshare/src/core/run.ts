import * as fs from 'node:fs'
import * as path from 'node:path'
import { effectiveSettings } from './config'
import type { Config } from './config'
import { type EvalFn, type EvalOutcome, type EvalStatus, interpretPrecheck } from './evalcmd'
import { COPY_MESSAGE, type Evidence, type Verdict, copiedSpan, explainReject, lessonHeader, validateLessonText, verdictHeader } from './lesson'
import { ArgError, type Clock, Deferred, HostError, appendLineSync, copyDir, hashBlobs, hashDir, matchFiles, median, readBlobs, readJson, readJsonl, repairJsonl, round, writeBlobs, writeJson } from './util'
import { buildReport, renderReportMd } from './report'

export interface Baseline {
  status: EvalStatus | 'none'
  metric: number | null
  noise: number | null
  runs: Array<{ status: EvalStatus; metric: number | null }>
}
export interface RunFile {
  run_id: string
  created: string
  project_dir: string
  config: Config
  baseline: Baseline
  writers: string[]
}
interface SessionState {
  counted: number
  submitted: number
  pending: number
}
interface WriterState {
  id: string
  best: { cand_id: string; metric: number } | null
  hashes: Map<string, string>
  candCount: number
  pending: Set<string>
  sessions: Map<number, SessionState>
  current: number
  delivered: Set<string>
  bestSeen: number | null
  lessonTexts: Set<string>
  stampMissing: Set<number>
}
export interface Cand {
  cand_id: string
  writer_id: string
  session: number
  hash: string
  note: string
  status: 'pending' | EvalStatus
  metric: number | null
  detail: string
  reference: number | null
  gain: number | null
  verified_gain: boolean
  is_own_best: boolean
  is_team_best: boolean
  reached_target: boolean
  counted: boolean
  queue_wait_s: number
  eval_s: number
  lessons: number
}
export interface Lesson {
  lesson_id: string
  seq: number
  writer_id: string
  cand_id: string
  minute: number
  evidence: Evidence
  header: string
  text: string
  pushed: boolean
  /** Board order. Equals seq when an evaluator gates lessons; assigned at verdict time under agent verification. */
  bseq: number | null
  /** Agent verification only; null when an evaluation command gates lessons. */
  verdict: Verdict | null
  verdict_note: string
  /** The lesson this one corrects or retracts (its author's own, or a teammate's it received). */
  corrects?: string | null
  /** Run minute at which the lesson became eligible for delivery. Kept in memory only. */
  pushed_minute?: number | null
}

const pad = (n: number, w = 4) => String(n).padStart(w, '0')

const agentModeInstructions = (verifierOn: boolean) =>
  'This run has no automatic evaluator. Your result is your LAST CHECKPOINT when the run closes: edits to work_dir that you did not checkpoint are not part of it. A judge then ranks every writer against the goal and criteria. ' +
  'evaluate saves a checkpoint of work_dir (status "recorded", no metric). It executes nothing and tests nothing: a checkpoint is a saved version, not a passed check. Call it whenever your result has moved forward. Checkpoints count toward the session quota, anchor your lessons, and carry lessons pushed by teammates back to you. ' +
  (verifierOn
    ? 'A verifier agent checks every lesson against your checkpoint before anyone else sees it: verified lessons are pushed to the team, and so are partly verified ones, with the verifier\'s correction in the header; unverified or refuted ones appear on the board with that label; a lesson that hands over your result instead of an insight is withheld. '
    : 'Nobody checks lessons in this run: they appear on the board at once, labelled "not checked". Treat every lesson as an untested claim and say in yours how you checked it. ') +
  'When your result looks complete, do not return. Attack it: look for a better one, try to prove or disprove that it is the best possible, test teammates\' lessons on your own work, and checkpoint each step. Returning early ends nothing; the host only starts another session for you. ' +
  'There is no verified_gain signal: post a lesson when you establish something a teammate could reuse, and say how you checked it. ' +
  'If a lesson of yours, or one you received, turns out to be wrong, post the correction with corrects set to that lesson id: it goes first to everyone who got the original. ' +
  'When a checkpoint builds on a teammate\'s lesson, name it in used_lessons on that evaluate call.'

function safeBlobs(dir: string, globs: string[]): string[] {
  try {
    return readBlobs(dir, matchFiles(dir, globs)).map((b) => b.data.toString('utf8'))
  } catch {
    return []
  }
}

export class Run {
  readonly id: string
  readonly cfg: Config
  readonly baseline: Baseline
  readonly writerIds: string[]
  state: 'open' | 'closed' = 'open'
  closedReason: string | null = null
  startMs = 0
  deadlineMs = 0
  evalsLimit: number | null
  counted = 0
  teamBest: { cand_id: string; writer_id: string; metric: number } | null = null
  confirmed = false
  /** Result round: 0 for the first search, +1 each time the run is reopened. Finals and reports are kept per round. */
  generation = 0
  private damage = { events_torn_bytes: 0, events_bad_lines: 0, lessons_torn_bytes: 0, lessons_bad_lines: 0 }
  private uses = new Set<string>()
  private correctedBy = new Map<string, string[]>()
  writers = new Map<string, WriterState>()
  cands = new Map<string, Cand>()
  lessons: Lesson[] = []
  agents = new Map<string, string>()
  private candSeq = 0
  private lessonStore = new Map<string, Lesson>()
  // queue (in-process; one board server per session, verified by spike S2)
  private queues = new Map<string, string[]>()
  private lastServed = -1
  private running = 0
  private prechecking = 0
  private precheckWait: Array<() => void> = []
  private submitMs = new Map<string, number>()
  private waiters = new Map<string, Deferred<void>>()
  private idleWaiters: Array<() => void> = []
  private slotWaiters: Array<() => void> = []
  private confirming: Promise<any> | null = null
  readonly agentMode: boolean
  /** True when a verifier agent gates lessons (no evaluator, verifier enabled). */
  readonly verifierOn: boolean
  private bseqMax = 0
  private verifierSessions = new Map<number, { verdicts: number }>()
  private verifierCurrent = -1
  verifierAgents = new Set<string>()
  private assigned = new Map<string, number>()
  private lessonWaiters: Array<() => void> = []

  constructor(
    readonly dir: string,
    readonly file: RunFile,
    private clock: Clock,
    private evalFn: EvalFn,
  ) {
    this.id = file.run_id
    this.cfg = file.config
    this.baseline = file.baseline
    this.writerIds = file.writers
    this.evalsLimit = this.cfg.budget.evals
    this.agentMode = this.cfg.verify.kind === 'agent'
    this.verifierOn = this.agentMode && this.cfg.verifier.enabled
    for (const id of this.writerIds) {
      this.writers.set(id, { id, best: null, hashes: new Map(), candCount: 0, pending: new Set(), sessions: new Map(), current: -1, delivered: new Set(), bestSeen: null, lessonTexts: new Set(), stampMissing: new Set() })
      this.queues.set(id, [])
    }
  }

  // ---------- paths ----------
  get eventsPath() {
    return path.join(this.dir, 'events.jsonl')
  }
  get lessonsPath() {
    return path.join(this.dir, 'lessons.jsonl')
  }
  candDir(id: string) {
    return path.join(this.dir, 'candidates', id)
  }
  writerDir(id: string) {
    return path.join(this.dir, 'writers', id)
  }
  workDir(id: string) {
    return path.join(this.writerDir(id), 'work')
  }
  get sharedDir() {
    return path.join(this.dir, 'shared')
  }
  log(msg: string) {
    try {
      fs.appendFileSync(path.join(this.dir, 'server.log'), `${new Date(this.clock.now()).toISOString()} pid=${process.pid} ${msg}\n`)
    } catch {
      /* logging must never break the run */
    }
  }

  // ---------- event log: the single source of truth ----------
  private emit(type: string, fields: Record<string, unknown> = {}): any {
    const now = this.clock.now()
    const ev = { t: new Date(now).toISOString(), minute: this.startMs ? round((now - this.startMs) / 60000, 2) : 0, type, ...fields }
    appendLineSync(this.eventsPath, ev)
    this.apply(ev)
    return ev
  }

  /** Reducer. Every state change goes through here, live and during recovery. */
  private apply(ev: any): void {
    const tMs = Date.parse(ev.t)
    switch (ev.type) {
      case 'run_init':
        this.startMs = tMs
        this.deadlineMs = tMs + this.cfg.budget.minutes * 60000
        break
      case 'run_reopened':
        this.state = 'open'
        this.closedReason = null
        this.confirmed = false
        this.generation++
        this.deadlineMs = tMs + ev.minutes_added * 60000
        if (ev.evals_added && this.evalsLimit != null) this.evalsLimit += ev.evals_added
        break
      case 'run_closed':
        this.state = 'closed'
        this.closedReason = ev.reason
        break
      case 'join': {
        const w = this.writers.get(ev.writer_id)!
        if (!w.sessions.has(ev.session)) w.sessions.set(ev.session, { counted: 0, submitted: 0, pending: 0 })
        if (ev.session > w.current) w.current = ev.session
        if (ev.agent_id) this.agents.set(ev.agent_id, ev.writer_id)
        break
      }
      case 'stamp_missing':
        this.writers.get(ev.writer_id)!.stampMissing.add(ev.session)
        break
      case 'eval_submitted': {
        const w = this.writers.get(ev.writer_id)!
        const n = Number(String(ev.cand_id).slice(1))
        if (n > this.candSeq) this.candSeq = n
        this.cands.set(ev.cand_id, { cand_id: ev.cand_id, writer_id: ev.writer_id, session: ev.session, hash: ev.hash, note: ev.note ?? '', status: 'pending', metric: null, detail: '', reference: null, gain: null, verified_gain: false, is_own_best: false, is_team_best: false, reached_target: false, counted: false, queue_wait_s: 0, eval_s: 0, lessons: 0 })
        w.hashes.set(ev.hash, ev.cand_id)
        w.candCount++
        w.pending.add(ev.cand_id)
        const s = this.sessionOf(w, ev.session)
        s.submitted++
        s.pending++
        break
      }
      case 'eval_result': {
        const c = this.cands.get(ev.cand_id)!
        const w = this.writers.get(c.writer_id)!
        Object.assign(c, { status: ev.status, metric: ev.metric, detail: ev.detail ?? '', reference: ev.reference, gain: ev.gain, verified_gain: ev.verified_gain, is_own_best: ev.is_own_best, is_team_best: ev.is_team_best, reached_target: ev.reached_target, counted: ev.counted, queue_wait_s: ev.queue_wait_s, eval_s: ev.eval_s })
        w.pending.delete(c.cand_id)
        const s = this.sessionOf(w, c.session)
        s.pending = Math.max(0, s.pending - 1)
        if (ev.counted) {
          this.counted++
          s.counted++
        }
        if (ev.is_own_best) w.best = { cand_id: c.cand_id, metric: ev.metric }
        if (ev.is_team_best) this.teamBest = { cand_id: c.cand_id, writer_id: c.writer_id, metric: ev.metric }
        break
      }
      case 'lesson_posted': {
        const l = this.lessonStore.get(ev.lesson_id)
        if (!l) break
        this.lessons.push(l)
        if (l.pushed) l.pushed_minute = ev.minute
        if (l.bseq != null) this.noteCorrection(l)
        if (l.bseq != null && l.bseq > this.bseqMax) this.bseqMax = l.bseq
        this.writers.get(l.writer_id)!.lessonTexts.add(l.text)
        const c = this.cands.get(l.cand_id)
        if (c) c.lessons++
        break
      }
      case 'lesson_delivered': {
        const w = this.writers.get(ev.to)!
        w.delivered.add(ev.lesson_id)
        this.noteSeen(w, this.lessonStore.get(ev.lesson_id))
        break
      }
      case 'lessons_read': {
        const w = this.writers.get(ev.writer_id)!
        for (const l of this.lessons) if (l.bseq != null && l.bseq > ev.from_seq && l.bseq <= ev.to_seq && l.writer_id !== w.id) this.noteSeen(w, l)
        break
      }
      case 'verifier_join': {
        if (!this.verifierSessions.has(ev.session)) this.verifierSessions.set(ev.session, { verdicts: 0 })
        if (ev.session > this.verifierCurrent) this.verifierCurrent = ev.session
        if (ev.agent_id) this.verifierAgents.add(ev.agent_id)
        break
      }
      case 'lesson_verdict': {
        const l = this.lessonStore.get(ev.lesson_id)
        if (!l) break
        l.verdict = ev.verdict
        l.verdict_note = ev.note ?? ''
        l.header = ev.header
        l.pushed = !!ev.pushed
        l.pushed_minute = l.pushed ? ev.minute : null
        l.bseq = ev.bseq ?? null
        if (ev.verdict === 'verified' || ev.verdict === 'partly_verified') this.noteCorrection(l)
        if (l.bseq != null && l.bseq > this.bseqMax) this.bseqMax = l.bseq
        this.assigned.delete(l.lesson_id)
        const vs = this.verifierSessions.get(ev.session)
        if (vs) vs.verdicts++
        break
      }
      case 'lessons_used':
        for (const id of ev.lesson_ids ?? []) this.uses.add(`${ev.writer_id}/${id}`)
        break
      case 'run_confirmed':
        this.confirmed = true
        break
    }
  }
  /** A correction that is visible and not itself in doubt marks the lesson it corrects. */
  private noteCorrection(l: Lesson) {
    if (!l.corrects) return
    const list = this.correctedBy.get(l.corrects) ?? []
    if (!list.includes(l.lesson_id)) list.push(l.lesson_id)
    this.correctedBy.set(l.corrects, list)
  }
  /** The header a reader sees: the host's record plus what later lessons say about this one. */
  private headerOf(l: Lesson): string {
    const by = this.correctedBy.get(l.lesson_id)
    const parts = [l.corrects ? `corrects ${l.corrects}` : '', by?.length ? `CORRECTED BY ${by.join(', ')}: read that lesson before using this one` : ''].filter(Boolean)
    return parts.length ? l.header.replace(/\]$/, '') + ' · ' + parts.join(' · ') + ']' : l.header
  }
  private sessionOf(w: WriterState, idx: number): SessionState {
    let s = w.sessions.get(idx)
    if (!s) {
      s = { counted: 0, submitted: 0, pending: 0 }
      w.sessions.set(idx, s)
    }
    return s
  }
  private noteSeen(w: WriterState, l: Lesson | undefined) {
    if (!l || l.evidence.status !== 'ok' || l.evidence.metric == null) return
    if (w.bestSeen == null || this.better(l.evidence.metric, w.bestSeen)) w.bestSeen = l.evidence.metric
  }

  /** Rebuild all in-memory state from disk and re-enqueue evaluations that never produced a result. */
  recover(): void {
    // The caller holds the run lock. A record torn by a crash is set aside before anything is appended, so
    // every event written from now on can be read back on the next recovery.
    const ev = repairJsonl(this.eventsPath)
    const ls = repairJsonl(this.lessonsPath)
    this.damage = { events_torn_bytes: ev.torn_bytes, events_bad_lines: ev.bad_lines, lessons_torn_bytes: ls.torn_bytes, lessons_bad_lines: ls.bad_lines }
    if (ev.torn_bytes || ls.torn_bytes || ev.bad_lines || ls.bad_lines) this.log(`log damage on load: ${JSON.stringify(this.damage)}`)
    for (const l of readJsonl<Lesson>(this.lessonsPath)) this.lessonStore.set(l.lesson_id, l)
    for (const ev of readJsonl(this.eventsPath)) this.apply(ev)
    const pending = [...this.cands.values()].filter((c) => c.status === 'pending').sort((a, b) => a.cand_id.localeCompare(b.cand_id))
    for (const c of pending) {
      this.submitMs.set(c.cand_id, this.clock.now())
      this.waiters.set(c.cand_id, new Deferred())
      this.queues.get(c.writer_id)!.push(c.cand_id)
    }
    if (pending.length) this.log(`recovered ${pending.length} unfinished evaluation(s)`)
    if (ev.torn_bytes || ls.torn_bytes) this.emit('log_repaired', { ...this.damage })
    this.tick()
    this.pump()
  }

  // ---------- helpers ----------
  better(a: number, b: number): boolean {
    return this.cfg.metric.direction === 'min' ? a < b : a > b
  }
  private meetsTarget(m: number): boolean {
    const t = this.cfg.metric.target
    if (t == null) return false
    return this.cfg.metric.direction === 'min' ? m <= t : m >= t
  }
  private writer(id: unknown): WriterState {
    if (typeof id !== 'string') throw new ArgError('writer_id is required')
    const w = this.writers.get(id)
    if (!w) throw new ArgError(`unknown writer_id "${id}"; this run has ${this.writerIds[0]}..${this.writerIds[this.writerIds.length - 1]}`)
    return w
  }
  private budgetView() {
    return {
      run_state: this.state,
      minutes_left: this.state === 'open' ? Math.max(0, round((this.deadlineMs - this.clock.now()) / 60000, 1)) : 0,
      evals_left: this.evalsLimit == null ? null : Math.max(0, this.evalsLimit - this.counted),
    }
  }
  private sessionView(w: WriterState, idx = w.current) {
    const s = w.sessions.get(idx) ?? { counted: 0, submitted: 0, pending: 0 }
    const quota = this.cfg.session.eval_quota
    return { index: idx, evals_used: s.counted, eval_quota: quota, must_hand_off: s.counted >= quota }
  }

  tick(): void {
    if (this.state === 'open' && this.startMs && this.clock.now() >= this.deadlineMs) this.close('time')
  }
  close(reason: string): void {
    if (this.state !== 'open') return
    this.emit('run_closed', { reason })
    this.log(`run closed: ${reason}`)
    for (const r of this.lessonWaiters.splice(0)) r()
  }
  start(): void {
    this.emit('run_init', { run_id: this.id, config: this.cfg, baseline: this.baseline })
  }
  reopen(minutes: number, evals: number | null): void {
    // The report of the round that ends here stays readable under its own name.
    for (const ext of ['json', 'md']) {
      const cur = path.join(this.dir, `report.${ext}`)
      try {
        if (fs.existsSync(cur)) fs.renameSync(cur, path.join(this.dir, `report-g${this.generation}.${ext}`))
      } catch (e) {
        this.log('could not archive report: ' + (e as Error).message)
      }
    }
    this.emit('run_reopened', { minutes_added: minutes, evals_added: evals ?? 0, generation: this.generation + 1 })
  }
  minutesLeft(): number {
    return this.budgetView().minutes_left
  }
  /** Human-readable account of log damage found when this run was loaded; empty when the logs were clean. */
  logDamage(): string[] {
    const d = this.damage
    const out: string[] = []
    if (d.events_torn_bytes || d.lessons_torn_bytes) out.push(`A record cut off by a crash was set aside (${d.events_torn_bytes} bytes of events.jsonl, ${d.lessons_torn_bytes} of lessons.jsonl; kept in the .corrupt file next to each log). The action it recorded is lost; everything before it is intact.`)
    if (d.events_bad_lines || d.lessons_bad_lines) out.push(`Unreadable lines inside the logs were skipped (${d.events_bad_lines} in events.jsonl, ${d.lessons_bad_lines} in lessons.jsonl). State rebuilt from these logs may be incomplete: check server.log.`)
    return out
  }
  maxSession(): number {
    let m = -1
    for (const w of this.writers.values()) if (w.current > m) m = w.current
    return m
  }

  /** Identity checks of section 9.4. Call before any writer-scoped tool. */
  checkIdentity(writerId: string | undefined, agentId: unknown): void {
    if (typeof agentId !== 'string' || !agentId || !writerId) return
    const owner = this.agents.get(agentId)
    if (owner && owner !== writerId) throw new HostError('identity_mismatch', `this agent is registered as ${owner}; it cannot act as ${writerId}`)
  }
  writerOfAgent(agentId: unknown): string | undefined {
    return typeof agentId === 'string' ? this.agents.get(agentId) : undefined
  }

  // ---------- join ----------
  join(a: { writer_id: string; session: number; agent_id?: string | null; agent_type?: string | null }) {
    const w = this.writer(a.writer_id)
    if (!Number.isInteger(a.session) || a.session < 0) throw new ArgError('session must be a non-negative integer')
    this.tick()
    if (this.state === 'closed') return { error: 'run_closed', message: 'The run is closed. Return your structured result now.', budget: this.budgetView() }
    this.checkIdentity(w.id, a.agent_id)
    const known = w.sessions.has(a.session)
    const agentKnown = a.agent_id ? this.agents.get(a.agent_id) === w.id : true
    if (!known || !agentKnown) this.emit('join', { writer_id: w.id, session: a.session, agent_id: a.agent_id ?? null, agent_type: a.agent_type ?? null })
    if (a.agent_id) this.writeAgentMap(a.agent_id, a.agent_type ?? null, w, a.session)
    else if (!w.stampMissing.has(a.session)) this.emit('stamp_missing', { writer_id: w.id, session: a.session })
    const sv = this.sessionView(w, a.session)
    // A session is exhausted when its quota is used up or a later session already took over (replay safety, 7.3).
    const exhausted = sv.evals_used >= sv.eval_quota || w.current > a.session
    const boardOn = this.cfg.board.enabled
    return {
      mode: this.cfg.mode,
      board_enabled: boardOn,
      verify_kind: this.cfg.verify.kind,
      ...(this.agentMode ? { how_this_run_works: agentModeInstructions(this.verifierOn), criteria: this.cfg.criteria } : {}),
      mode_instructions: [
        this.cfg.shared.enabled
          ? `Shared visibility: the directory at shared_dir is readable. It holds every checkpoint or evaluated candidate of every writer under <writer_id>/<cand_id>/, and index.tsv lists writer, candidate, minute, status and metric. You may read teammates' work there. It is read-only.`
          : '',
        !boardOn
          ? 'The lesson board is off in this run: post_lesson and read_lessons return board_disabled.'
          : [
              this.cfg.push.policy === 'none' ? 'Lessons are not pushed in this run: nothing arrives with your results, so page through the board with read_lessons yourself.' : this.cfg.push.policy === 'all' ? 'Every lesson is pushed in this run, checked or not: read the header of each one.' : '',
              !this.cfg.board.pull ? 'read_lessons is off in this run: you only receive pushed lessons.' : this.cfg.board.show === 'verified' ? 'The board shows verified lessons only.' : '',
            ].filter(Boolean).join(' '),
      ].filter(Boolean).join(' '),
      settings: effectiveSettings(this.cfg),
      goal: this.cfg.goal,
      work_dir: this.workDir(w.id),
      notes_path: path.join(this.writerDir(w.id), 'NOTES.md'),
      context_files: this.contextPaths(w.id),
      candidate_files: this.cfg.candidate.files,
      ...(this.cfg.shared.enabled ? { shared_dir: this.sharedDir } : {}),
      metric: { name: this.cfg.metric.name, direction: this.cfg.metric.direction, target: this.cfg.metric.target },
      baseline: this.baseline.metric,
      own_best: w.best,
      budget: this.budgetView(),
      session: { index: a.session, evals_used: sv.evals_used, eval_quota: sv.eval_quota, exhausted },
      lessons_unread: boardOn && this.cfg.board.pull ? this.board().filter((l) => l.writer_id !== w.id && !w.delivered.has(l.lesson_id)).length : 0,
    }
  }
  /** Context files are copied next to the writer's work dir at init, so every path a writer needs shares one prefix. */
  private contextPaths(writerId: string): string[] {
    return this.cfg.context_files.map((f) => {
      const copy = path.join(this.writerDir(writerId), 'context', f)
      return fs.existsSync(copy) ? copy : path.resolve(this.file.project_dir, f)
    })
  }
  private writeAgentMap(agentId: string, agentType: string | null, w: WriterState, session: number) {
    if (!/^[A-Za-z0-9_.-]+$/.test(agentId)) return
    const dir = path.join(this.dir, 'agents')
    fs.mkdirSync(dir, { recursive: true })
    writeJson(path.join(dir, agentId + '.json'), {
      agent_id: agentId,
      agent_type: agentType,
      run_id: this.id,
      run_dir: this.dir,
      writer_id: w.id,
      session,
      mode: this.cfg.mode,
      start_ms: this.startMs,
      writer_dir: this.writerDir(w.id),
      context_files: this.cfg.context_files.map((f) => path.resolve(this.file.project_dir, f)),
      shared_dir: this.cfg.shared.enabled ? this.sharedDir : null,
    })
  }

  // ---------- evaluate ----------
  async evaluate(a: { writer_id: string; note?: string; used_lessons?: unknown; agent_id?: string | null }) {
    const w = this.writer(a.writer_id)
    this.checkIdentity(w.id, a.agent_id)
    this.tick()
    if (this.state === 'closed') throw new HostError('run_closed', 'The run is closed; no new candidates are accepted. Finish your notes and return.', { budget: this.budgetView() })
    if (w.current < 0) throw new HostError('not_joined', 'Call join before evaluate.')
    const s = this.sessionOf(w, w.current)
    const quota = this.cfg.session.eval_quota
    if (s.counted + s.pending >= quota + this.cfg.session.grace) throw new HostError('hand_off_required', 'This session has used its evaluation quota. Update your notes file and return your structured result; the next session continues from your notes.', { session: this.sessionView(w) })
    if (w.pending.size >= this.cfg.eval.max_pending) throw new HostError('too_many_pending', `You already have ${w.pending.size} unfinished evaluation(s). Call get_result on them first.`, { pending: [...w.pending] })
    if (w.candCount >= this.cfg.eval.max_candidates) throw new HostError('candidate_limit', `You reached the limit of ${this.cfg.eval.max_candidates} candidates for this run.`)
    const note = String(a.note ?? '').replace(/\s+/g, ' ').slice(0, 200)
    // Team evaluation cap: in-flight evaluations hold a slot each, so the cap can never be exceeded.
    // Wait for a slot (an in-flight build_error frees one) or for the run to close.
    const waitUntil = Date.now() + this.cfg.eval.block_s * 1000
    while (this.evalsLimit != null && this.state === 'open' && this.counted + this.inFlight() >= this.evalsLimit) {
      const left = waitUntil - Date.now()
      if (left <= 0) throw new HostError('budget_reserved', 'The remaining evaluation budget is held by evaluations still in flight. Call evaluate again shortly.', { budget: this.budgetView() })
      let timer: NodeJS.Timeout | undefined
      await Promise.race([new Promise<void>((r) => this.slotWaiters.push(r)), new Promise<void>((r) => (timer = setTimeout(r, left)))])
      clearTimeout(timer)
    }
    if ((this.state as string) === 'closed') throw new HostError('run_closed', 'The run is closed; no new candidates are accepted. Finish your notes and return.', { budget: this.budgetView() })

    // Snapshot: read everything into memory first so later edits to work/ cannot leak into the candidate.
    const work = this.workDir(w.id)
    const rels = matchFiles(work, this.cfg.candidate.files!)
    if (!rels.length) throw new HostError('empty_candidate', `No candidate files found in ${work}. Expected: ${this.cfg.candidate.files!.join(', ')}`)
    const blobs = readBlobs(work, rels)
    const bytes = blobs.reduce((n, b) => n + b.data.length, 0)
    if (bytes > this.cfg.candidate.max_bytes) throw new HostError('too_large', `Candidate is ${bytes} bytes; the limit is ${this.cfg.candidate.max_bytes}.`)
    const hash = hashBlobs(blobs)
    const dup = w.hashes.get(hash)
    if (dup) {
      const c = this.cands.get(dup)!
      if (c.status === 'pending') return { cand_id: dup, status: 'running', duplicate_of: dup, queue_position: this.queuePosition(dup) }
      return { ...this.resultView(c, w, false), duplicate_of: dup, hint: `Identical to your earlier candidate ${dup}; not re-evaluated.` }
    }
    const candId = 'c' + pad(++this.candSeq)
    writeBlobs(path.join(this.candDir(candId), 'src'), blobs)
    this.submitMs.set(candId, this.clock.now())
    this.waiters.set(candId, new Deferred())
    this.emit('eval_submitted', { cand_id: candId, writer_id: w.id, session: w.current, hash, note, bytes })
    const usedNote = this.recordUses(w, candId, a.used_lessons)
    if (this.agentMode) {
      // No evaluation command: the snapshot is a checkpoint. It anchors lessons and carries pushed lessons back.
      this.finish(this.cands.get(candId)!, { status: 'recorded', metric: null, detail: 'Checkpoint recorded. There is no automatic evaluator in this run.', eval_s: 0, log: '' }, 0, hash)
      return { ...this.resultView(this.cands.get(candId)!, w, true), ...usedNote }
    }
    void this.admit(candId)
    return { ...(await this.await(candId, w, this.cfg.eval.block_s)), ...usedNote }
  }
  /** A writer's own statement of which teammates' lessons a candidate builds on. Self-declared, tied to the candidate. */
  private recordUses(w: WriterState, candId: string, raw: unknown): Record<string, unknown> {
    if (raw == null) return {}
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    const ok: string[] = []
    const unknown: string[] = []
    for (const id of new Set(ids)) {
      const l = this.lessonStore.get(id)
      if (l && l.writer_id !== w.id && (w.delivered.has(id) || l.bseq != null)) ok.push(id)
      else unknown.push(id)
    }
    if (ok.length) this.emit('lessons_used', { writer_id: w.id, cand_id: candId, lesson_ids: ok })
    return unknown.length ? { used_lessons_ignored: unknown, used_lessons_hint: "used_lessons takes ids of teammates' lessons you received or read, e.g. L0007." } : {}
  }

  async getResult(a: { writer_id: string; cand_id: string; wait_s?: number; agent_id?: string | null }) {
    const w = this.writer(a.writer_id)
    this.checkIdentity(w.id, a.agent_id)
    const c = this.cands.get(a.cand_id)
    if (!c || c.writer_id !== w.id) throw new HostError('unknown_candidate', `${a.cand_id} is not one of your candidates.`)
    const wait = typeof a.wait_s === 'number' && a.wait_s >= 0 ? Math.min(a.wait_s, 1500) : this.cfg.eval.block_s
    return this.await(c.cand_id, w, wait)
  }

  private async await(candId: string, w: WriterState, waitS: number) {
    const c = this.cands.get(candId)!
    const d = this.waiters.get(candId)
    if (c.status === 'pending' && d) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([d.promise, new Promise<void>((r) => (timer = setTimeout(r, waitS * 1000)))])
      clearTimeout(timer)
    }
    if (c.status === 'pending') return { cand_id: candId, status: 'running', queue_position: this.queuePosition(candId), budget: this.budgetView(), hint: 'Still running. Call get_result with this cand_id.' }
    return this.resultView(c, w, true)
  }
  private queuePosition(candId: string): number {
    // number of evaluations expected to start before this one (round-robin order), 0 when already running
    const snapshot = new Map([...this.queues].map(([k, v]) => [k, [...v]]))
    let last = this.lastServed
    let pos = 0
    for (;;) {
      let found: string | null = null
      for (let i = 1; i <= this.writerIds.length; i++) {
        const idx = (last + i) % this.writerIds.length
        const q = snapshot.get(this.writerIds[idx])!
        if (q.length) {
          found = q.shift()!
          last = idx
          break
        }
      }
      if (!found) return 0
      if (found === candId) return pos + 1
      pos++
    }
  }

  private resultView(c: Cand, w: WriterState, deliver: boolean) {
    this.tick()
    const out: Record<string, unknown> = {
      cand_id: c.cand_id,
      status: c.status,
      metric: c.metric,
      detail: c.detail,
      reference: c.reference,
      gain: c.gain == null ? null : round(c.gain, 4),
      is_own_best: c.is_own_best,
      verified_gain: c.verified_gain,
      reached_target: c.reached_target,
      own_best: w.best,
      queue_wait_s: c.queue_wait_s,
      eval_s: c.eval_s,
      budget: this.budgetView(),
      session: this.sessionView(w),
    }
    // A checkpoint is a saved version. Say so in the result, so nobody reads "recorded" as "passed".
    if (c.status === 'recorded') Object.assign(out, { execution_performed: false, evidence: 'checkpoint saved by the host; nothing was executed or tested' })
    if (this.cfg.board.enabled) out.pushed_lessons = deliver ? this.deliver(w, c.cand_id) : []
    const sv = this.sessionView(w)
    const hints: string[] = []
    if (c.status === 'infra_error') hints.push('The evaluator itself failed (not your candidate). This did not use budget; you may resubmit after a small change, or continue.')
    if (c.status === 'recorded' && this.cfg.board.enabled && this.state === 'open') hints.push(`Checkpoint ${c.cand_id} recorded. If it contains a new insight, post a lesson attached to it.`)
    if (c.verified_gain && this.cfg.board.enabled && this.state === 'open' && c.lessons === 0) hints.push(`This candidate is a verified gain. Post a lesson attached to ${c.cand_id} so teammates receive it.`)
    if (this.state === 'closed') hints.push('The run is closed. Finish your notes and return your structured result.')
    else if (sv.must_hand_off) hints.push('Session quota reached (must_hand_off). Update your notes file and return your structured result.')
    if (hints.length) out.hint = hints.join(' ')
    return out
  }

  /** Piggy-back pushed lessons from other writers on a finished evaluation result (section 6.6). */
  private deliver(w: WriterState, via: string) {
    const out: Array<Record<string, unknown>> = []
    // Corrections of lessons this writer already holds go first: a correction must not wait behind a backlog.
    const due = this.board().filter((l) => l.pushed && l.writer_id !== w.id && !w.delivered.has(l.lesson_id))
    const urgent = (l: Lesson) => (l.corrects && w.delivered.has(l.corrects) ? 0 : 1)
    due.sort((a, b) => urgent(a) - urgent(b) || a.bseq! - b.bseq!)
    for (const l of due) {
      if (out.length >= this.cfg.push.max_per_delivery) break
      this.emit('lesson_delivered', { lesson_id: l.lesson_id, to: w.id, with_cand: via, chars: l.text.length, waited_min: l.pushed_minute == null ? null : round(Math.max(0, (this.clock.now() - this.startMs) / 60000 - l.pushed_minute), 2) })
      out.push({ lesson_id: l.lesson_id, header: this.headerOf(l), text: l.text, ...(l.corrects ? { corrects: l.corrects } : {}) })
    }
    return out
  }
  /** Pushed lessons that have not reached this writer yet, and how long the oldest has waited. */
  private waitingFor(w: WriterState) {
    const due = this.lessons.filter((l) => l.pushed && l.bseq != null && l.writer_id !== w.id && !w.delivered.has(l.lesson_id))
    const nowMin = (this.clock.now() - this.startMs) / 60000
    const oldest = due.reduce((m, l) => Math.max(m, l.pushed_minute == null ? 0 : nowMin - l.pushed_minute), 0)
    return { count: due.length, oldest_wait_min: due.length ? round(Math.max(0, oldest), 1) : 0 }
  }

  /** Lessons visible on the board, in board order. Under agent verification a lesson appears only after its verdict. */
  private board(): Lesson[] {
    const onlyVerified = this.cfg.board.show === 'verified'
    const isVerified = (l: Lesson) => (this.agentMode ? l.verdict === 'verified' || l.verdict === 'partly_verified' : l.evidence.verified_gain)
    return this.lessons.filter((l) => l.bseq != null && (!onlyVerified || isVerified(l))).sort((a, b) => a.bseq! - b.bseq!)
  }

  // ---------- queue ----------
  private async admit(candId: string) {
    const c = this.cands.get(candId)!
    const pre = this.cfg.eval.precheck
    if (pre) {
      if (this.prechecking >= this.cfg.eval.precheck_concurrency) await new Promise<void>((r) => this.precheckWait.push(r))
      this.prechecking++
      let o: EvalOutcome
      try {
        o = await this.evalFn({ kind: 'precheck', candidate_dir: path.join(this.candDir(candId), 'src'), run_dir: this.dir, cand_id: candId })
      } catch (e) {
        o = { status: 'infra_error', metric: null, detail: 'precheck crashed: ' + (e as Error).message, eval_s: 0, log: String(e) }
      }
      this.prechecking--
      this.precheckWait.shift()?.()
      const r = interpretPrecheck(o)
      if (!r.pass) {
        this.safeWrite(path.join(this.candDir(candId), 'precheck.log'), o.log)
        this.finish(c, { status: 'build_error', metric: null, detail: r.detail || 'precheck failed', eval_s: o.eval_s, log: o.log }, 0, null)
        return
      }
    }
    this.queues.get(c.writer_id)!.push(candId)
    this.pump()
  }
  private pickNext(): string | null {
    const n = this.writerIds.length
    for (let i = 1; i <= n; i++) {
      const idx = (this.lastServed + i) % n
      const q = this.queues.get(this.writerIds[idx])!
      if (q.length) {
        this.lastServed = idx
        return q.shift()!
      }
    }
    return null
  }
  private pump(): void {
    while (this.running < this.cfg.eval.concurrency) {
      const next = this.pickNext()
      if (!next) break
      this.running++
      void this.execute(next).finally(() => {
        this.running--
        this.pump()
        this.checkIdle()
      })
    }
    this.checkIdle()
  }
  private safeWrite(file: string, data: string) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data)
    } catch {
      /* best effort */
    }
  }
  private async evalWithRetry(candDir: string, candId: string): Promise<EvalOutcome> {
    const ctx = { kind: 'eval' as const, candidate_dir: path.join(candDir, 'src'), run_dir: this.dir, cand_id: candId }
    let o: EvalOutcome
    let log = ''
    for (let attempt = 0; ; attempt++) {
      try {
        o = await this.evalFn(ctx)
      } catch (e) {
        o = { status: 'infra_error', metric: null, detail: 'evaluator crashed: ' + (e as Error).message, eval_s: 0, log: String(e) }
      }
      log += (attempt ? '\n=== retry ===\n' : '') + o.log
      if (o.status !== 'infra_error' || attempt >= 1) break
    }
    return { ...o, log }
  }
  private async execute(candId: string) {
    const c = this.cands.get(candId)!
    const startMs = this.clock.now()
    const queueWait = Math.max(0, (startMs - (this.submitMs.get(candId) ?? startMs)) / 1000)
    const dir = this.candDir(candId)
    let evaluatedHash: string | null = null
    let o: EvalOutcome
    if (!fs.existsSync(path.join(dir, 'src'))) o = { status: 'infra_error', metric: null, detail: 'candidate snapshot is missing', eval_s: 0, log: '' }
    else {
      evaluatedHash = hashDir(path.join(dir, 'src'))
      o = await this.evalWithRetry(dir, candId)
    }
    this.safeWrite(path.join(dir, 'eval.log'), o.log)
    this.finish(c, o, queueWait, evaluatedHash)
  }

  /** Final snapshot id of a writer in the current result round. Round 0 keeps the historical name. */
  finalId(writerId: string, generation = this.generation): string {
    return generation ? `final-${writerId}-g${generation}` : `final-${writerId}`
  }
  /**
   * Freeze one writer's result for this round: its last checkpoint (work saved before the run closed), or the work
   * directory when it never saved one. Written to a temporary directory and renamed, so a final either exists
   * complete, with its manifest, or not at all. A final that exists is never rewritten.
   */
  private freezeFinal(id: string) {
    const fid = this.finalId(id)
    const dir = this.candDir(fid)
    const manifestPath = path.join(dir, 'final.json')
    if (!fs.existsSync(manifestPath)) {
      const last = [...this.cands.values()].filter((c) => c.writer_id === id && c.status === 'recorded').sort((a, b) => a.cand_id.localeCompare(b.cand_id)).pop()
      const srcDir = last ? path.join(this.candDir(last.cand_id), 'src') : this.workDir(id)
      let blobs = last ? readBlobs(srcDir, matchFiles(srcDir, ['**'])) : readBlobs(srcDir, matchFiles(srcDir, this.cfg.candidate.files!))
      if (blobs.reduce((n, b) => n + b.data.length, 0) > this.cfg.candidate.max_bytes) blobs = []
      const manifest = { writer_id: id, cand_id: fid, generation: this.generation, source: last ? last.cand_id : 'work_dir', hash: hashBlobs(blobs), files: blobs.map((b) => b.rel) }
      // Round 0 of a run made by an older version may already hold src/ without a manifest: adopt it as it is.
      if (this.generation === 0 && fs.existsSync(path.join(dir, 'src'))) {
        const legacy = readBlobs(path.join(dir, 'src'), matchFiles(path.join(dir, 'src'), ['**']))
        writeJson(manifestPath, { ...manifest, source: 'legacy', hash: hashBlobs(legacy), files: legacy.map((b) => b.rel) })
      } else {
        const tmp = `${dir}.tmp${process.pid}`
        fs.rmSync(tmp, { recursive: true, force: true })
        fs.rmSync(dir, { recursive: true, force: true }) // a directory without a manifest is a torn write
        writeBlobs(path.join(tmp, 'src'), blobs)
        writeJson(path.join(tmp, 'final.json'), manifest)
        fs.renameSync(tmp, dir)
      }
      const m = readJson<any>(manifestPath)
      this.emit('final_snapshot', { writer_id: id, cand_id: fid, generation: this.generation, source: m.source, hash: m.hash, files: m.files.length })
    }
    const m = readJson<any>(manifestPath)
    return { writer_id: id, cand_id: fid, final_dir: path.join(dir, 'src'), files: m.files as string[], hash: m.hash as string, source: m.source as string, notes_path: path.join(this.writerDir(id), 'NOTES.md') }
  }

  /**
   * Without an evaluation command there is nothing to replay. The run is closed, every writer's last checkpoint is
   * frozen as the final of this round, and a judge agent ranks the finals against the task criteria. The host
   * checks the ranking itself: one row per writer, scores in range, a reason for each.
   */
  private async confirmJudged(ranking: unknown, reportPath: string) {
    this.close('confirm')
    await this.idle()
    const finals = this.writerIds.map((id) => this.freezeFinal(id))
    if (ranking == null) return { needs_ranking: true, run_id: this.id, generation: this.generation, goal: this.cfg.goal, criteria: this.cfg.criteria, finals, instructions: 'Read every final_dir. Judge each result against the goal and criteria: check it yourself, do not trust claims. Then call confirm again with ranking: one row for EVERY writer, [{writer_id, score (0 to 10), meets_bar (true only if the result is valid and good enough to rely on), reason (one sentence)}]. If no result meets the bar, say so with meets_bar false on every row: the report then names no winner.' }
    if (!Array.isArray(ranking) || !ranking.length) throw new ArgError('ranking must be a non-empty array of {writer_id, score, meets_bar, reason}')
    const seen = new Set<string>()
    const clean = ranking.map((r: any) => {
      if (!r || !this.writers.has(r.writer_id)) throw new ArgError(`ranking: unknown writer_id ${JSON.stringify(r?.writer_id)}`)
      if (seen.has(r.writer_id)) throw new ArgError(`ranking: ${r.writer_id} appears more than once`)
      seen.add(r.writer_id)
      if (typeof r.score !== 'number' || !Number.isFinite(r.score)) throw new ArgError('ranking: score must be a number')
      if (r.score < 0 || r.score > 10) throw new ArgError(`ranking: the score of ${r.writer_id} is ${r.score}; scores go from 0 to 10`)
      const reason = String(r.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
      if (!reason) throw new ArgError(`ranking: ${r.writer_id} has no reason; give one sentence`)
      if (r.meets_bar != null && typeof r.meets_bar !== 'boolean') throw new ArgError('ranking: meets_bar must be true or false')
      const f = finals.find((x) => x.writer_id === r.writer_id)!
      const meets = r.meets_bar !== false
      if (meets && !f.files.length) throw new ArgError(`ranking: ${r.writer_id} has no result files, so it cannot meet the bar; set meets_bar to false`)
      return { writer_id: r.writer_id as string, score: r.score as number, meets_bar: meets, reason, final: f.cand_id, hash: f.hash }
    })
    const missing = this.writerIds.filter((id) => !seen.has(id))
    if (missing.length) throw new ArgError(`ranking: no row for ${missing.join(', ')}; rank every writer of the run (${this.writerIds.join(', ')})`)
    clean.sort((x, y) => y.score - x.score)
    const top = clean.find((x) => x.meets_bar) ?? null
    const winnerDir = path.join(this.dir, 'winner')
    fs.rmSync(winnerDir, { recursive: true, force: true })
    if (top) copyDir(path.join(this.candDir(top.final), 'src'), winnerDir)
    this.emit('run_confirmed', { winner: top ? top.final : null, winner_writer: top ? top.writer_id : null, winner_hash: top ? top.hash : null, no_validated_winner: !top, judged: true, generation: this.generation, ranking: clean })
    const report = buildReport(this.dir)
    writeJson(reportPath, report)
    fs.writeFileSync(path.join(this.dir, 'report.md'), renderReportMd(report))
    return report
  }

  /** Judge a finished evaluation: verified gain, bests, budget, target. */
  private finish(c: Cand, o: EvalOutcome, queueWaitS: number, evaluatedHash: string | null) {
    const w = this.writers.get(c.writer_id)!
    const ok = o.status === 'ok' && o.metric != null
    const m = ok ? o.metric! : null
    let ref: number | null = w.best ? w.best.metric : this.baseline.status === 'ok' ? this.baseline.metric : null
    if (this.cfg.gate.reference === 'team_best_seen' && w.bestSeen != null && (ref == null || this.better(w.bestSeen, ref))) ref = w.bestSeen
    let gain: number | null = null
    if (ok && ref != null && ref !== 0) gain = this.cfg.metric.direction === 'min' ? (ref - m!) / ref : (m! - ref) / Math.abs(ref)
    const verified = ok && gain != null && gain >= this.cfg.metric.min_gain - 1e-12
    const isOwnBest = ok && (w.best == null || this.better(m!, w.best.metric))
    const isTeamBest = ok && (this.teamBest == null || this.better(m!, this.teamBest.metric))
    const counted = o.status === 'ok' || o.status === 'incorrect' || o.status === 'recorded'
    const reached = ok && this.meetsTarget(m!)
    const result = { cand_id: c.cand_id, writer_id: c.writer_id, session: c.session, status: o.status, metric: m, detail: o.detail, reference: ref, gain, verified_gain: verified, is_own_best: isOwnBest, is_team_best: isTeamBest, reached_target: reached, counted, queue_wait_s: round(queueWaitS, 2), eval_s: round(o.eval_s, 2), hash: c.hash, evaluated_hash: evaluatedHash }
    writeJson(path.join(this.candDir(c.cand_id), 'result.json'), result)
    this.emit('eval_result', result)
    if (this.cfg.shared.enabled) this.publishShared(c)
    if (this.state === 'open') {
      if (reached && this.cfg.stop.on_target) this.close('target')
      else if (this.evalsLimit != null && this.counted >= this.evalsLimit) this.close('evals')
      else this.tick()
    }
    this.submitMs.delete(c.cand_id)
    const d = this.waiters.get(c.cand_id)
    this.waiters.delete(c.cand_id)
    d?.resolve()
    for (const r of this.slotWaiters.splice(0)) r()
    this.checkIdle()
  }
  private publishShared(c: Cand) {
    try {
      copyDir(path.join(this.candDir(c.cand_id), 'src'), path.join(this.sharedDir, c.writer_id, c.cand_id))
      const minute = round((this.clock.now() - this.startMs) / 60000, 2)
      fs.appendFileSync(path.join(this.sharedDir, 'index.tsv'), [c.writer_id, c.cand_id, minute, c.status, c.metric ?? ''].join('\t') + '\n')
    } catch (e) {
      this.log('shared publish failed: ' + (e as Error).message)
    }
  }
  private inFlight(): number {
    let n = 0
    for (const w of this.writers.values()) n += w.pending.size
    return n
  }
  private busy(): boolean {
    return this.running > 0 || this.prechecking > 0 || [...this.cands.values()].some((c) => c.status === 'pending')
  }
  private checkIdle() {
    if (!this.busy()) for (const r of this.idleWaiters.splice(0)) r()
  }
  idle(): Promise<void> {
    if (!this.busy()) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  // ---------- lessons ----------
  postLesson(a: { writer_id: string; cand_id: string; text: string; corrects?: string | null; agent_id?: string | null }) {
    const w = this.writer(a.writer_id)
    this.checkIdentity(w.id, a.agent_id)
    if (typeof a.text !== 'string') throw new ArgError('text is required')
    if (typeof a.cand_id !== 'string') throw new ArgError('cand_id is required')
    const text = a.text.trim()
    const reject = (error: string, message: string, detail: Record<string, unknown> = {}) => {
      this.emit('lesson_rejected', { writer_id: w.id, cand_id: a.cand_id, error, chars: text.length, ...detail })
      // Off by default: a rejected text may be the author's result. Turn it on to audit the filter.
      if (this.cfg.lesson.keep_rejected) {
        try {
          appendLineSync(path.join(this.dir, 'rejected.jsonl'), { t: new Date(this.clock.now()).toISOString(), writer_id: w.id, cand_id: a.cand_id, error, ...detail, text }, false)
        } catch {
          /* audit copy is best effort */
        }
      }
      return { error, message, ...detail }
    }
    this.tick()
    if (this.state === 'closed') return reject('run_closed', 'The run is closed; lessons are no longer accepted.')
    if (!this.cfg.board.enabled) return reject('board_disabled', `The lesson board is disabled in ${this.cfg.mode} mode.`)
    const c = this.cands.get(a.cand_id)
    if (!c || c.writer_id !== w.id || c.status === 'pending') return reject('unknown_candidate', `${a.cand_id} is not one of your evaluated candidates. Attach the lesson to a candidate of yours whose evaluation has finished.`)
    if (!text) return reject('empty', 'The lesson text is empty.')
    const bad = validateLessonText(text, this.cfg.lesson)
    if (bad) {
      const why = explainReject(bad, text, this.cfg.lesson)
      return reject(bad, why.message, { rule: why.rule, ...(why.lines.length ? { lines: why.lines } : {}) })
    }
    if (this.cfg.lesson.max_copy_chars > 0) {
      const texts: string[] = []
      for (const d of [path.join(this.candDir(c.cand_id), 'src'), this.workDir(w.id)]) for (const b of safeBlobs(d, this.cfg.candidate.files!)) texts.push(b)
      const span = copiedSpan(text, texts, this.cfg.lesson.max_copy_chars)
      if (span) return reject('contains_solution', `${COPY_MESSAGE} The passage starting "${span.excerpt}" (about character ${span.at + 1} of your lesson) repeats ${this.cfg.lesson.max_copy_chars} or more consecutive characters of your own files. Rephrase that passage; the rest can stay.`, { rule: `copy_chars=${this.cfg.lesson.max_copy_chars}`, at: span.at })
    }
    let corrects: string | null = null
    if (a.corrects != null && a.corrects !== '') {
      const t = typeof a.corrects === 'string' ? this.lessonStore.get(a.corrects) : undefined
      const mayRef = t && this.lessons.includes(t) && (t.writer_id === w.id || w.delivered.has(t.lesson_id) || (t.bseq != null && this.board().includes(t)))
      if (!mayRef) return reject('unknown_lesson', `corrects must name a lesson of your own or one you received; ${JSON.stringify(a.corrects)} is neither.`)
      corrects = t!.lesson_id
    }
    if (w.lessonTexts.has(text)) return reject('duplicate', 'You already posted this exact lesson.')
    if (c.lessons >= this.cfg.lesson.max_per_candidate) return reject('too_many_for_candidate', `${c.cand_id} already has ${c.lessons} lesson(s); the limit is ${this.cfg.lesson.max_per_candidate}. Attach new findings to a newer candidate.`)

    const evidence: Evidence = { status: c.status, metric: c.metric, reference: c.reference, gain: c.gain == null ? null : round(c.gain, 4), verified_gain: c.verified_gain }
    const policy = this.cfg.push.policy
    // With a verifier agent nothing is pushed or even visible until the verdict arrives.
    const gated = this.verifierOn
    const pushed = !gated && (policy === 'all' || (!this.agentMode && policy === 'verified' && c.verified_gain && c.lessons === 0))
    const seq = this.lessons.length + 1
    const lesson: Lesson = {
      lesson_id: 'L' + pad(seq),
      seq,
      writer_id: w.id,
      cand_id: c.cand_id,
      minute: round((this.clock.now() - this.startMs) / 60000, 2),
      evidence,
      header: gated ? verdictHeader(w.id, c.cand_id, 'pending', '') : this.agentMode ? verdictHeader(w.id, c.cand_id, 'unchecked', '') : lessonHeader(w.id, c.cand_id, evidence, this.cfg.metric),
      text,
      pushed,
      bseq: gated ? null : seq,
      verdict: gated ? 'pending' : this.agentMode ? 'unchecked' : null,
      verdict_note: '',
      ...(corrects ? { corrects } : {}),
    }
    appendLineSync(this.lessonsPath, lesson)
    this.lessonStore.set(lesson.lesson_id, lesson)
    this.emit('lesson_posted', { lesson_id: lesson.lesson_id, seq, writer_id: w.id, cand_id: c.cand_id, chars: text.length, pushed, ...(corrects ? { corrects } : {}) })
    for (const r of this.lessonWaiters.splice(0)) r()
    if (gated) return { lesson_id: lesson.lesson_id, pushed: false, status: 'pending_verification', header: lesson.header, hint: 'The verifier will check this lesson. If it is verified it is pushed to your teammates. Keep working.' }
    return { lesson_id: lesson.lesson_id, pushed, header: lesson.header }
  }

  readLessons(a: { writer_id: string; cursor?: number; limit?: number; agent_id?: string | null }) {
    const w = this.writer(a.writer_id)
    this.checkIdentity(w.id, a.agent_id)
    if (!this.cfg.board.enabled) return { error: 'board_disabled', message: `The lesson board is disabled in ${this.cfg.mode} mode.` }
    if (!this.cfg.board.pull) return { error: 'pull_disabled', message: 'read_lessons is off in this run. Lessons reach you only when they are pushed with a result.' }
    if (this.cfg.read.require_own_correct && !w.best) return { error: 'locked', message: 'The board unlocks once you have your own correct candidate. Get one first.' }
    const cursor = Number.isInteger(a.cursor) && a.cursor! >= 0 ? a.cursor! : 0
    const limit = Math.min(20, Math.max(1, Number.isInteger(a.limit) ? a.limit! : 10))
    const board = this.board()
    const others = board.filter((l) => l.bseq! > cursor && l.writer_id !== w.id)
    const page = others.slice(0, limit)
    const next = page.length ? page[page.length - 1].bseq! : Math.max(cursor, board.length ? board[board.length - 1].bseq! : cursor)
    const view = page.map((l) => ({ lesson_id: l.lesson_id, seq: l.bseq, header: this.headerOf(l), text: l.text, pushed: l.pushed, already_delivered: w.delivered.has(l.lesson_id), ...(l.corrects ? { corrects: l.corrects } : {}) }))
    this.emit('lessons_read', { writer_id: w.id, from_seq: cursor, to_seq: next, count: page.length, chars: page.reduce((n, l) => n + l.text.length, 0), has_own_correct: !!w.best })
    return { lessons: view, next_cursor: next, remaining: others.length - page.length }
  }

  // ---------- verifier agent (agent verification) ----------
  registerVerifier(agentId: unknown, agentType: unknown): void {
    if (typeof agentId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(agentId) || this.agents.has(agentId)) return
    const dir = path.join(this.dir, 'agents')
    const f = path.join(dir, agentId + '.json')
    if (fs.existsSync(f)) return
    fs.mkdirSync(path.join(this.dir, 'verifier'), { recursive: true })
    fs.mkdirSync(dir, { recursive: true })
    writeJson(f, { agent_id: agentId, agent_type: agentType ?? null, role: 'verifier', run_id: this.id, run_dir: this.dir, start_ms: this.startMs, scratch_dir: path.join(this.dir, 'verifier'), context_files: this.cfg.context_files.map((x) => path.resolve(this.file.project_dir, x)) })
  }
  private verifierGuard(agentId: unknown) {
    if (!this.verifierOn) throw new HostError('no_verifier', this.agentMode ? 'The verifier is switched off in this run; lessons are not checked.' : 'This run gates lessons with an evaluation command; there is no verifier agent.')
    if (this.writerOfAgent(agentId)) throw new HostError('forbidden', 'writers cannot verify lessons')
  }
  /** Hand the verifier the oldest lesson that still needs a verdict; waits when there is none. */
  async nextLesson(a: { session: number; wait_s?: number; agent_id?: string | null }) {
    this.verifierGuard(a.agent_id)
    if (!Number.isInteger(a.session) || a.session < 0) throw new ArgError('session must be a non-negative integer')
    if (!this.verifierSessions.has(a.session) || (a.agent_id && !this.verifierAgents.has(a.agent_id))) this.emit('verifier_join', { session: a.session, agent_id: a.agent_id ?? null })
    const quota = this.cfg.verifier.session_quota
    const sess = () => ({ index: a.session, verdicts: this.verifierSessions.get(a.session)!.verdicts, quota })
    const waitS = typeof a.wait_s === 'number' && a.wait_s >= 0 ? Math.min(a.wait_s, 1500) : this.cfg.verifier.wait_s
    const until = Date.now() + waitS * 1000
    for (;;) {
      this.tick()
      if (this.state === 'closed') return { run_closed: true, message: 'The run is closed. Return your structured result now.', session: sess() }
      if (sess().verdicts >= quota || this.verifierCurrent > a.session) return { must_hand_off: true, message: 'This verifier session is used up. Return your structured result; the next session continues.', session: sess() }
      const now = this.clock.now()
      const l = this.lessons.find((x) => x.verdict === 'pending' && (this.assigned.get(x.lesson_id) ?? 0) < now - 15 * 60000)
      if (l) {
        this.assigned.set(l.lesson_id, now)
        return {
          lesson: { lesson_id: l.lesson_id, writer_id: l.writer_id, cand_id: l.cand_id, minute: l.minute, text: l.text },
          ...(l.corrects && this.lessonStore.get(l.corrects) ? { corrects: { lesson_id: l.corrects, writer_id: this.lessonStore.get(l.corrects)!.writer_id, header: this.lessonStore.get(l.corrects)!.header, text: this.lessonStore.get(l.corrects)!.text } } : {}),
          author_checkpoint_dir: path.join(this.candDir(l.cand_id), 'src'),
          author_work_dir: this.workDir(l.writer_id),
          author_notes_path: path.join(this.writerDir(l.writer_id), 'NOTES.md'),
          goal: this.cfg.goal,
          criteria: this.cfg.criteria,
          context_files: this.cfg.context_files.map((x) => path.resolve(this.file.project_dir, x)),
          scratch_dir: path.join(this.dir, 'verifier'),
          pending: this.lessons.filter((x) => x.verdict === 'pending').length,
          budget: this.budgetView(),
          session: sess(),
        }
      }
      const left = until - Date.now()
      if (left <= 0) return { none: true, message: 'No lesson is waiting. Call next_lesson again.', budget: this.budgetView(), session: sess() }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([new Promise<void>((r) => this.lessonWaiters.push(r)), new Promise<void>((r) => (timer = setTimeout(r, Math.min(left, 2000))))])
      clearTimeout(timer)
    }
  }
  verdict(a: { lesson_id: string; verdict: string; note?: string; agent_id?: string | null }) {
    this.verifierGuard(a.agent_id)
    const l = this.lessonStore.get(a.lesson_id)
    if (!l || !this.lessons.includes(l)) throw new HostError('unknown_lesson', `no lesson ${a.lesson_id}`)
    if (l.verdict !== 'pending') throw new HostError('already_decided', `${l.lesson_id} already has the verdict "${l.verdict}"`)
    if (!['verified', 'partly_verified', 'unverified', 'refuted', 'withheld'].includes(a.verdict)) throw new ArgError('verdict must be one of verified, partly_verified, unverified, refuted, withheld')
    const note = String(a.note ?? '').replace(/\s+/g, ' ').trim()
    if (!note) throw new HostError('note_required', 'Give a one-sentence note saying what you checked and what you found.')
    if (note.length > this.cfg.verifier.note_max_chars) throw new HostError('note_too_long', `The note is limited to ${this.cfg.verifier.note_max_chars} characters. The verifier reports a verdict; it does not rewrite or extend lessons.`)
    if (note.includes('```') || note.includes('~~~')) throw new HostError('note_has_code', 'The note is one plain sentence without code.')
    const verdict = a.verdict as Verdict
    const policy = this.cfg.push.policy
    const visible = verdict !== 'withheld'
    const pushed = visible && policy !== 'none' && (verdict === 'verified' || verdict === 'partly_verified' || policy === 'all')
    const bseq = visible ? this.bseqMax + 1 : null
    const header = verdictHeader(l.writer_id, l.cand_id, verdict, note)
    this.emit('lesson_verdict', { lesson_id: l.lesson_id, writer_id: l.writer_id, verdict, note, pushed, bseq, header, session: this.verifierCurrent, agent_id: a.agent_id ?? null })
    return { lesson_id: l.lesson_id, verdict, pushed, pending: this.lessons.filter((x) => x.verdict === 'pending').length }
  }

  // ---------- status ----------
  status(writerId?: string, deliver = false) {
    this.tick()
    if (writerId) {
      const w = this.writer(writerId)
      const out: Record<string, unknown> = { run_id: this.id, mode: this.cfg.mode, writer_id: w.id, own_best: w.best, candidates: w.candCount, pending: [...w.pending], budget: this.budgetView(), session: this.sessionView(w), baseline: this.baseline.metric, metric: this.cfg.metric }
      // A writer deep in one long step can collect its pushes here without saving a checkpoint. Only after its
      // first checkpoint, so every writer still commits a first result of its own before it reads the team's.
      if (deliver && this.cfg.board.enabled && this.state === 'open' && w.candCount > 0) out.pushed_lessons = this.deliver(w, 'status')
      return out
    }
    const count = (st: string) => [...this.cands.values()].filter((c) => c.status === st).length
    return {
      run_id: this.id,
      run_dir: this.dir,
      mode: this.cfg.mode,
      n: this.cfg.n,
      budget: this.budgetView(),
      closed_reason: this.closedReason,
      confirmed: this.confirmed,
      baseline: this.baseline.metric,
      metric: this.cfg.metric,
      team_best: this.teamBest,
      writers: this.writerIds.map((id) => {
        const w = this.writers.get(id)!
        const wait = this.waitingFor(w)
        return { writer_id: id, best: w.best, candidates: w.candCount, session: w.current, pending: w.pending.size, pushes_waiting: wait.count, oldest_push_wait_min: wait.oldest_wait_min, ...(wait.count && w.candCount === 0 ? { waiting_because: 'no checkpoint yet: pushes are held until the first one' } : wait.count ? { waiting_because: 'pushes ride on the next checkpoint or status call' } : {}) }
      }),
      evals: { ok: count('ok'), incorrect: count('incorrect'), build_error: count('build_error'), infra_error: count('infra_error'), pending: count('pending'), counted: this.counted },
      lessons: { posted: this.lessons.length, pushed: this.lessons.filter((l) => l.pushed).length, ...(this.agentMode ? { pending: this.lessons.filter((l) => l.verdict === 'pending').length } : {}) },
      queue_length: [...this.queues.values()].reduce((n, q) => n + q.length, 0) + this.running,
      generation: this.generation,
      log_damage: this.damage,
    }
  }

  // ---------- confirm ----------
  confirm(a: { top_k?: number; replays?: number; ranking?: unknown }) {
    // serialize concurrent confirm calls
    if (!this.confirming) this.confirming = this.doConfirm(a).finally(() => (this.confirming = null))
    return this.confirming
  }
  private async doConfirm(a: { top_k?: number; replays?: number; ranking?: unknown }) {
    const reportPath = path.join(this.dir, 'report.json')
    if (this.confirmed && fs.existsSync(reportPath)) return readJson(reportPath)
    if (this.agentMode) return this.confirmJudged(a.ranking, reportPath)
    const topK = Number.isInteger(a.top_k) && a.top_k! > 0 ? a.top_k! : this.cfg.confirm.top_k
    const replays = Number.isInteger(a.replays) && a.replays! > 0 ? a.replays! : this.cfg.confirm.replays
    this.close('confirm')
    await this.idle()
    const seen = new Set<string>()
    const ranked = [...this.cands.values()]
      .filter((c) => c.status === 'ok' && c.metric != null)
      .sort((x, y) => (x.metric === y.metric ? x.cand_id.localeCompare(y.cand_id) : this.better(x.metric!, y.metric!) ? -1 : 1))
      .filter((c) => (seen.has(c.hash) ? false : (seen.add(c.hash), true)))
    const confirmedList: Array<{ cand: Cand; metric: number; replays: number[] }> = []
    const checked: Array<{ cand_id: string; confirmed: boolean; replays: Array<{ status: string; metric: number | null }> }> = []
    for (const c of ranked.slice(0, this.cfg.confirm.max_candidates)) {
      if (confirmedList.length >= topK) break
      const rs: Array<{ status: string; metric: number | null }> = []
      for (let i = 0; i < replays; i++) {
        const o = await this.evalWithRetry(this.candDir(c.cand_id), c.cand_id)
        const m = o.status === 'ok' ? o.metric : null
        this.emit('confirm_replay', { cand_id: c.cand_id, replay: i + 1, status: o.status, metric: m })
        rs.push({ status: o.status, metric: m })
        if (o.status !== 'ok') break
      }
      const allOk = rs.length === replays && rs.every((r) => r.status === 'ok')
      checked.push({ cand_id: c.cand_id, confirmed: allOk, replays: rs })
      if (allOk) confirmedList.push({ cand: c, metric: median(rs.map((r) => r.metric!)), replays: rs.map((r) => r.metric!) })
    }
    confirmedList.sort((x, y) => (x.metric === y.metric ? 0 : this.better(x.metric, y.metric) ? -1 : 1))
    const win = confirmedList[0] ?? null
    const winnerDir = path.join(this.dir, 'winner')
    fs.rmSync(winnerDir, { recursive: true, force: true })
    if (win) copyDir(path.join(this.candDir(win.cand.cand_id), 'src'), winnerDir)
    this.emit('run_confirmed', { winner: win ? win.cand.cand_id : null, confirmed_metric: win ? win.metric : null, replays: win ? win.replays : [], checked })
    const report = buildReport(this.dir)
    writeJson(reportPath, report)
    fs.writeFileSync(path.join(this.dir, 'report.md'), renderReportMd(report))
    return report
  }
}
