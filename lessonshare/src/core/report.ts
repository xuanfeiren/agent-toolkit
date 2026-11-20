import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RunFile } from './run'
import { fmtNum, listFiles, median, readJson, readJsonl, round } from './util'

const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? 'n/a' : (x * 100).toFixed(1) + '%')

function codeLineSet(dir: string): Set<string> {
  const set = new Set<string>()
  for (const f of listFiles(dir)) {
    let txt: string
    try {
      txt = fs.readFileSync(path.join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const raw of txt.split('\n')) {
      const l = raw.trim()
      if (!l || l.startsWith('#') || l.startsWith('//') || l.startsWith('/*') || l.startsWith('*') || l.startsWith('--')) continue
      set.add(l)
    }
  }
  return set
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Build the report object (section 13.2) purely from files on disk, so the CLI can do it too. */
export function buildReport(runDir: string): any {
  const rf = readJson<RunFile>(path.join(runDir, 'run.json'))
  const cfg = rf.config
  const events = readJsonl(path.join(runDir, 'events.jsonl'))
  const dir = cfg.metric.direction
  const better = (a: number, b: number) => (dir === 'min' ? a < b : a > b)
  const within = (m: number, best: number, tol: number) => (dir === 'min' ? m <= best * (1 + tol) : m >= best * (1 - tol))
  const relGain = (from: number, to: number) => (from === 0 ? 0 : dir === 'min' ? (from - to) / from : (to - from) / Math.abs(from))

  const W: Record<string, any> = {}
  for (const id of rf.writers) W[id] = { writer_id: id, best_metric: null, best_cand: null, evals: 0, sessions: 0, lessons_posted: 0, lessons_pushed: 0, read_chars: 0, _sessions: new Set<number>(), _bestTimeline: [] as Array<{ minute: number; metric: number }> }
  const evals = { ok: 0, incorrect: 0, build_error: 0, infra_error: 0 }
  const agentMode = cfg.verify?.kind === 'agent'
  const lessons: any = { posted: 0, pushed: 0, rejected: 0, delivered: 0 }
  const verdicts: Record<string, number> = { verified: 0, unverified: 0, refuted: 0, withheld: 0 }
  const verdictDelay: number[] = []
  const postedAt: Record<string, number> = {}
  const timeline: Array<{ minute: number; metric: number; writer_id: string; cand_id: string }> = []
  const candWriter: Record<string, string> = {}
  const results: Record<string, any> = {}
  const sessionEvals: Record<string, number> = {}
  let closedReason: string | null = null
  let lastMinute = 0
  let queueS = 0
  let evalS = 0
  let reads = 0
  let readsNoCorrect = 0
  let guardDenied = 0
  let stampMissing = 0
  let joinsWithAgent = 0
  let confirmedEv: any = null
  let gainsTotal = 0
  let gainsFollowed = 0
  const awaitingLesson: Record<string, string | null> = {}
  const replays: Record<string, number[]> = {}
  const hasOk: Record<string, boolean> = {}
  const lastCheckpoint: Record<string, string> = {}
  const postedLessonCands = new Set<string>()
  // iterate once to know which candidates got a lesson (for the 8.4 check)
  const lessonAt: Array<{ writer: string; cand: string; idx: number }> = []
  events.forEach((e, idx) => {
    if (e.type === 'lesson_posted') lessonAt.push({ writer: e.writer_id, cand: e.cand_id, idx })
  })

  events.forEach((e, idx) => {
    if (typeof e.minute === 'number' && e.minute > lastMinute && e.type !== 'confirm_replay' && e.type !== 'run_confirmed') lastMinute = e.minute
    switch (e.type) {
      case 'join':
        if (W[e.writer_id]) W[e.writer_id]._sessions.add(e.session)
        if (e.agent_id) joinsWithAgent++
        break
      case 'stamp_missing':
        stampMissing++
        break
      case 'guard_denied':
        guardDenied++
        break
      case 'eval_submitted':
        candWriter[e.cand_id] = e.writer_id
        // 8.4: a verified gain should be followed by a lesson on that candidate before the writer's next evaluate
        if (awaitingLesson[e.writer_id]) {
          const cand = awaitingLesson[e.writer_id]!
          if (lessonAt.some((l) => l.cand === cand && l.idx < idx)) gainsFollowed++
          awaitingLesson[e.writer_id] = null
        }
        break
      case 'eval_result': {
        results[e.cand_id] = e
        const w = W[e.writer_id]
        if (!w) break
        ;(evals as any)[e.status] = ((evals as any)[e.status] ?? 0) + 1
        w.evals++
        const key = `${e.writer_id}/s${e.session}`
        sessionEvals[key] = (sessionEvals[key] ?? 0) + 1
        queueS += e.queue_wait_s ?? 0
        evalS += e.eval_s ?? 0
        if (e.status === 'ok' || e.status === 'recorded') hasOk[e.writer_id] = true
        if (e.status === 'recorded') lastCheckpoint[e.writer_id] = e.cand_id
        if (e.is_own_best) {
          w.best_metric = e.metric
          w.best_cand = e.cand_id
          w._bestTimeline.push({ minute: e.minute, metric: e.metric })
        }
        if (e.is_team_best) timeline.push({ minute: e.minute, metric: e.metric, writer_id: e.writer_id, cand_id: e.cand_id })
        if (e.verified_gain && cfg.board.enabled) {
          gainsTotal++
          awaitingLesson[e.writer_id] = e.cand_id
        }
        break
      }
      case 'lesson_posted':
        lessons.posted++
        postedAt[e.lesson_id] = e.minute
        postedLessonCands.add(e.cand_id)
        if (W[e.writer_id]) {
          W[e.writer_id].lessons_posted++
          if (e.pushed) W[e.writer_id].lessons_pushed++
        }
        if (e.pushed) lessons.pushed++
        break
      case 'lesson_rejected':
        lessons.rejected++
        break
      case 'lesson_verdict':
        verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1
        if (e.pushed) {
          lessons.pushed++
          if (W[e.writer_id]) W[e.writer_id].lessons_pushed++
        }
        if (postedAt[e.lesson_id] != null) verdictDelay.push(Math.max(0, e.minute - postedAt[e.lesson_id]))
        break
      case 'lesson_delivered':
        lessons.delivered++
        if (W[e.to]) W[e.to].read_chars += e.chars ?? 0
        break
      case 'lessons_read':
        reads++
        if (!hasOk[e.writer_id]) readsNoCorrect++
        if (W[e.writer_id]) W[e.writer_id].read_chars += e.chars ?? 0
        break
      case 'run_closed':
        closedReason = e.reason
        break
      case 'run_reopened':
        closedReason = null
        confirmedEv = null
        break
      case 'confirm_replay':
        if (e.status === 'ok') (replays[e.cand_id] ??= []).push(e.metric)
        break
      case 'run_confirmed':
        confirmedEv = e
        break
    }
  })
  // verified gains still awaiting a lesson at the end of the run
  for (const [, cand] of Object.entries(awaitingLesson)) if (cand && postedLessonCands.has(cand)) gainsFollowed++

  // --- catch-up time ---
  const catchUps: number[] = []
  let censored = 0
  let prevBest: number | null = rf.baseline.metric
  for (const tb of timeline) {
    const jump = prevBest == null ? true : relGain(prevBest, tb.metric) >= 0.05
    prevBest = tb.metric
    if (!jump) continue
    for (const id of rf.writers) {
      if (id === tb.writer_id) continue
      const hit = (W[id]._bestTimeline as Array<{ minute: number; metric: number }>).find((p) => within(p.metric, tb.metric, 0.05))
      if (hit) catchUps.push(Math.max(0, round(hit.minute - tb.minute, 2)))
      else censored++
    }
  }
  const allCatch = [...catchUps, ...Array(censored).fill(Infinity)]
  const catchMedian = allCatch.length ? median(allCatch) : null

  // --- implementation similarity ---
  // without a metric, compare each writer's final snapshot (or its last checkpoint while the run is open)
  const resultOf = (id: string): string | null => (agentMode ? (fs.existsSync(path.join(runDir, 'candidates', 'final-' + id, 'src')) ? 'final-' + id : (lastCheckpoint[id] ?? null)) : W[id].best_cand)
  const bests = rf.writers.filter((id) => resultOf(id)).map((id) => ({ id, set: codeLineSet(path.join(runDir, 'candidates', resultOf(id)!, 'src')) }))
  const parent: Record<string, string> = {}
  const find = (x: string): string => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  for (const b of bests) parent[b.id] = b.id
  for (let i = 0; i < bests.length; i++) for (let j = i + 1; j < bests.length; j++) if (jaccard(bests[i].set, bests[j].set) >= 0.8) parent[find(bests[i].id)] = find(bests[j].id)
  const families = new Set(bests.map((b) => find(b.id))).size

  // --- winner ---
  const target = cfg.metric.target
  const meets = (m: number) => target != null && (dir === 'min' ? m <= target : m >= target)
  let winner: any = null
  const warnings: string[] = []
  if (confirmedEv && confirmedEv.judged) {
    const top = confirmedEv.ranking[0]
    winner = { cand_id: confirmedEv.winner, writer_id: confirmedEv.winner_writer, metric: null, confirmed_metric: null, replays: [], improvement: null, reached_target: false, judged: true, score: top.score, reason: top.reason, path: path.join(runDir, 'winner') }
    warnings.push('The winner was chosen by a judge agent against the task criteria, not by a measurement. Check it yourself before relying on it.')
  } else if (confirmedEv && confirmedEv.winner) {
    const r = results[confirmedEv.winner]
    const cm = confirmedEv.confirmed_metric
    winner = {
      cand_id: confirmedEv.winner,
      writer_id: r?.writer_id ?? candWriter[confirmedEv.winner],
      metric: r?.metric ?? null,
      confirmed_metric: cm,
      replays: confirmedEv.replays,
      improvement: rf.baseline.metric != null ? round(relGain(rf.baseline.metric, cm), 4) : null,
      reached_target: meets(cm),
      path: path.join(runDir, 'winner'),
    }
  } else if (confirmedEv) warnings.push(evals.ok ? 'No candidate passed confirmation: every replayed candidate had at least one non-ok replay.' : 'No correct candidate was produced, so there is no winner.')
  else warnings.push('Run is not confirmed yet; winner is not selected.')
  if (rf.baseline.status !== 'ok' && !agentMode) warnings.push('Baseline was not ok; improvement is not available.')
  const isolation = stampMissing > 0 || joinsWithAgent === 0 ? 'unenforced' : 'enforced'
  if (isolation === 'unenforced') warnings.push('Hooks did not stamp every writer session; workspace isolation relied on the prompt only.')

  const sessCounts = Object.values(sessionEvals)
  const writers = rf.writers.map((id) => {
    const w = W[id]
    return { writer_id: id, best_metric: w.best_metric, best_cand: w.best_cand, evals: w.evals, sessions: w._sessions.size, lessons_posted: w.lessons_posted, lessons_pushed: w.lessons_pushed, read_chars: w.read_chars }
  })
  const readChars = writers.map((w) => w.read_chars)
  const diagnostics = {
    lesson_verified_rate: lessons.posted ? round(lessons.pushed / lessons.posted, 3) : null,
    catch_up_minutes_median: catchMedian == null ? null : Number.isFinite(catchMedian) ? catchMedian : null,
    catch_up: { events: catchUps.length + censored, caught: catchUps.length, censored },
    read_chars_per_writer_mean: readChars.length ? Math.round(readChars.reduce((a, b) => a + b, 0) / readChars.length) : 0,
    reads_without_own_correct_share: reads ? round(readsNoCorrect / reads, 3) : null,
    implementation_families: families,
    implementation_family_ratio: bests.length ? round(families / bests.length, 3) : null,
    eval_queue_share: queueS + evalS > 0 ? round(queueS / (queueS + evalS), 3) : null,
    evals_per_session: { sessions: sessCounts.length, mean: sessCounts.length ? round(sessCounts.reduce((a, b) => a + b, 0) / sessCounts.length, 1) : null, min: sessCounts.length ? Math.min(...sessCounts) : null, max: sessCounts.length ? Math.max(...sessCounts) : null },
    verification: agentMode ? { kind: 'agent', verdicts, pending: lessons.posted - Object.values(verdicts).reduce((a, b) => a + b, 0), verdict_delay_minutes_median: verdictDelay.length ? round(median(verdictDelay), 2) : null } : { kind: 'command' },
    behavior: {
      lesson_after_verified_gain_rate: gainsTotal ? round(gainsFollowed / gainsTotal, 3) : null,
      verified_gains: gainsTotal,
      lesson_rejection_rate: lessons.posted + lessons.rejected ? round(lessons.rejected / (lessons.posted + lessons.rejected), 3) : null,
      guard_denied: guardDenied,
    },
  }
  const report: any = {
    verify_kind: agentMode ? 'agent' : 'command',
    run_id: rf.run_id,
    run_dir: runDir,
    task: cfg.name,
    mode: cfg.mode,
    n: cfg.n,
    closed_reason: closedReason,
    minutes: round(lastMinute, 1),
    metric: { name: cfg.metric.name, direction: dir, target },
    baseline: { metric: rf.baseline.metric, status: rf.baseline.status, noise: rf.baseline.noise },
    winner,
    ranking: confirmedEv?.ranking ?? null,
    team: {
      evals,
      writers,
      writers_at_target: target == null ? null : writers.filter((w) => w.best_metric != null && meets(w.best_metric)).length,
      lessons,
      team_best_timeline: timeline.map(({ minute, metric, writer_id }) => ({ minute, metric, writer_id })),
    },
    diagnostics,
    isolation,
    warnings,
  }
  report.hints = diagnoseHints(report, cfg)
  return report
}

/** Symptom -> bottleneck hints, adapted from the paper's Table 11 (section 13.3). */
export function diagnoseHints(r: any, cfg: any): string[] {
  const d = r.diagnostics
  const hints: string[] = []
  const board = cfg.board.enabled
  if (board && r.team.lessons.pushed > 0 && r.team.lessons.delivered === 0) hints.push('Lessons were pushed but none was delivered: check that writers keep evaluating (pushes ride on evaluation results).')
  if (d.catch_up.events > 0 && d.catch_up.censored > d.catch_up.caught) hints.push(board ? 'Most writers never caught up with new team bests: discoveries are not spreading. Check lesson_delivered events and whether verified gains were followed by a lesson.' : 'Most writers never caught up with new team bests. In this mode nothing is shared; try mode lessonshare.')
  if (board && d.lesson_verified_rate != null && d.lesson_verified_rate < 0.15) hints.push('Verified-lesson rate is low: writers rarely make verified gains or do not post after them. Check behavior.lesson_after_verified_gain_rate and whether metric.min_gain is above the real step size.')
  if (board && d.behavior.lesson_after_verified_gain_rate != null && d.behavior.lesson_after_verified_gain_rate < 0.8) hints.push('Writers often skipped posting a lesson after a verified gain; the push channel is underused.')
  if (d.implementation_family_ratio != null && r.n >= 3 && d.implementation_family_ratio < 0.5) hints.push('Implementation similarity is high: the team is converging on one implementation. Check that the guard hook is active and the mode is not workspace.')
  if (board && d.reads_without_own_correct_share != null && d.reads_without_own_correct_share > 0.2) hints.push('Many board reads happened before the reader had a correct candidate of its own. Consider read.require_own_correct=true.')
  if (d.eval_queue_share != null && d.eval_queue_share > 0.5) hints.push('Evaluations spend most of their time queued: the bottleneck is evaluator throughput. Reduce N, or raise eval.concurrency if the metric tolerates concurrent runs.')
  if (board && r.team.lessons.delivered > 0 && r.winner && r.metric.target != null && !r.winner.reached_target) hints.push('Pushes were delivered but the target was not reached: the bottleneck is discovery itself. Add writers or time; changing the channel will not help.')
  if (r.isolation === 'unenforced') hints.push('Isolation was not enforced by hooks in this run; similarity numbers should be read with that in mind.')
  return hints
}

export function renderReportMd(r: any): string {
  const m = r.metric
  const L: string[] = []
  L.push(`# LessonShare report: ${r.task}`, '')
  L.push(`- Run: \`${r.run_id}\` · mode **${r.mode}** · N=${r.n} · closed by **${r.closed_reason ?? 'n/a'}** after ${r.minutes} min`)
  const agent = r.verify_kind === 'agent'
  if (agent) L.push('- No evaluator: lessons were checked by the verifier agent, results ranked by a judge agent')
  else {
    L.push(`- Metric: ${m.name} (${m.direction === 'min' ? 'lower' : 'higher'} is better)${m.target != null ? `, target ${fmtNum(m.target)}` : ''}`)
    L.push(`- Baseline: ${r.baseline.metric == null ? 'n/a (' + r.baseline.status + ')' : fmtNum(r.baseline.metric)}`)
  }
  if (r.winner && r.winner.judged) {
    L.push(`- **Winner: ${r.winner.writer_id}** · chosen by the judge agent, score ${r.winner.score}/10: ${r.winner.reason}`)
    L.push(`- Winner files: \`${r.winner.path}\` (not applied to your workspace)`)
  } else if (r.winner) {
    const w = r.winner
    L.push(`- **Winner: ${w.cand_id} by ${w.writer_id}** · confirmed ${fmtNum(w.confirmed_metric)} (replays ${w.replays.map(fmtNum).join(', ')}) · improvement ${pct(w.improvement)}${m.target != null ? ` · target ${w.reached_target ? 'reached' : 'not reached'}` : ''}`)
    L.push(`- Winner files: \`${w.path}\` (not applied to your workspace)`)
  } else L.push('- **Winner: none**')
  L.push(`- Isolation: ${r.isolation}`, '')
  if (r.ranking) {
    L.push('## Judge ranking', '', '| writer | score | reason |', '|---|---|---|')
    for (const x of r.ranking) L.push(`| ${x.writer_id} | ${x.score} | ${x.reason} |`)
    L.push('')
  }
  L.push('## Team', '')
  const e = r.team.evals
  L.push(e.recorded ? `Checkpoints: ${e.recorded}.` : `Evaluations: ${e.ok} ok, ${e.incorrect} incorrect, ${e.build_error} build_error, ${e.infra_error} infra_error.`)
  const l = r.team.lessons
  L.push(`Lessons: ${l.posted} posted, ${l.pushed} pushed, ${l.rejected} rejected, ${l.delivered} deliveries.`)
  const v = r.diagnostics.verification
  if (v?.kind === 'agent') L.push(`Verifier verdicts: ${v.verdicts.verified} verified, ${v.verdicts.unverified} not verified, ${v.verdicts.refuted} refuted, ${v.verdicts.withheld} withheld, ${v.pending} still pending; median time to verdict ${v.verdict_delay_minutes_median ?? 'n/a'} min.`)
  if (r.team.writers_at_target != null) L.push(`Writers at target: ${r.team.writers_at_target}/${r.n}.`)
  L.push('', '| writer | best | evals | sessions | lessons | pushed | chars read |', '|---|---|---|---|---|---|---|')
  for (const w of r.team.writers) L.push(`| ${w.writer_id} | ${w.best_metric == null ? '-' : fmtNum(w.best_metric)} | ${w.evals} | ${w.sessions} | ${w.lessons_posted} | ${w.lessons_pushed} | ${w.read_chars} |`)
  if (!agent) {
    L.push('', '### Team best over time', '')
    for (const t of r.team.team_best_timeline) L.push(`- minute ${t.minute}: ${fmtNum(t.metric)} (${t.writer_id})`)
    if (!r.team.team_best_timeline.length) L.push('- (no correct candidate)')
  }
  const d = r.diagnostics
  L.push('', '## Diagnostics', '', 'Paper values are for orientation only; they are not thresholds.', '', '| metric | value | paper reference |', '|---|---|---|')
  L.push(`| Lesson verified rate (pushed / posted) | ${pct(d.lesson_verified_rate)} | 37-40% |`)
  if (!agent) L.push(`| Catch-up time, median minutes (${d.catch_up.caught} caught, ${d.catch_up.censored} censored) | ${d.catch_up_minutes_median ?? (d.catch_up.events ? 'not reached (censored)' : 'n/a')} | LessonShare 15-19; Independent 40-60; SharedWorkspace ~4 |`)
  L.push(`| Characters read per writer (pushes + reads), mean | ${d.read_chars_per_writer_mean} | 52K at N=4, 171K at N=16 |`)
  L.push(`| Share of reads before own ${agent ? 'first checkpoint' : 'correct candidate'} | ${pct(d.reads_without_own_correct_share)} | 0.17-0.20 pull-only; lower is better |`)
  L.push(`| ${agent ? 'Distinct results / writers with a result' : 'Implementation families / writers with a best'} | ${d.implementation_families} (${pct(d.implementation_family_ratio)}) | LessonShare 15.5/16; SharedWorkspace 1.6/16 |`)
  if (!agent) L.push(`| Evaluation queue share | ${pct(d.eval_queue_share)} | near 0 |`)
  L.push(`| ${agent ? 'Checkpoints' : 'Evaluations'} per session (mean, min-max over ${d.evals_per_session.sessions} sessions) | ${d.evals_per_session.mean ?? 'n/a'} (${d.evals_per_session.min ?? '-'}-${d.evals_per_session.max ?? '-'}) | none |`)
  if (!agent) L.push(`| Lesson posted after verified gain, before next evaluate | ${pct(d.behavior.lesson_after_verified_gain_rate)} of ${d.behavior.verified_gains} | expect ≥80% |`)
  L.push(`| Lesson rejection rate | ${pct(d.behavior.lesson_rejection_rate)} | expect <20% |`)
  L.push(`| Guard denials | ${d.behavior.guard_denied} | expect 0 |`)
  L.push('', '## Hints', '')
  if (r.hints?.length) for (const h of r.hints) L.push(`- ${h}`)
  else L.push('- No bottleneck stands out.')
  if (r.warnings?.length) {
    L.push('', '## Warnings', '')
    for (const w of r.warnings) L.push(`- ${w}`)
  }
  return L.join('\n') + '\n'
}
