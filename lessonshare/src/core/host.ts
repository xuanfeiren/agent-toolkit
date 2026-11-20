import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { type Config, type Mode, buildConfig, loadTaskFile, writerIds } from './config'
import { type EvalCtx, type EvalFn, type EvalOutcome, runCommand, tailLines } from './evalcmd'
import { type Baseline, Run, type RunFile } from './run'
import { ArgError, type Clock, HostError, copyDir, isObj, matchFiles, median, readBlobs, readJson, realClock, resolveInside, round, writeBlobs, writeJson } from './util'

export interface HostOptions {
  projectDir: string
  clock?: Clock
  /** Test hook: replaces the evaluator subprocess. Receives the frozen config of the run. */
  evalFactory?: (cfg: Config, projectDir: string) => EvalFn
}

export function commandEvalFn(cfg: Config, projectDir: string): EvalFn {
  return (ctx: EvalCtx): Promise<EvalOutcome> => {
    const spec = ctx.kind === 'precheck' ? { ...cfg.eval, ...cfg.eval.precheck! } : cfg.eval
    return runCommand({ command: spec.command!, cwd: spec.cwd!, timeout_s: spec.timeout_s! }, path.resolve(projectDir, spec.cwd!), { candidate_dir: ctx.candidate_dir, run_dir: ctx.run_dir, cand_id: ctx.cand_id })
  }
}

const str = (a: any, k: string, required = true): string | undefined => {
  if (a[k] == null) {
    if (required) throw new ArgError(`${k} is required`)
    return undefined
  }
  if (typeof a[k] !== 'string') throw new ArgError(`${k} must be a string`)
  return a[k]
}
const num = (a: any, k: string): number | undefined => {
  if (a[k] == null) return undefined
  const v = typeof a[k] === 'string' && a[k].trim() !== '' ? Number(a[k]) : a[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ArgError(`${k} must be a number`)
  return v
}

export class Host {
  readonly projectDir: string
  private clock: Clock
  private evalFactory: (cfg: Config, projectDir: string) => EvalFn
  private runs = new Map<string, Run>()
  private locks = new Set<string>()

  constructor(opts: HostOptions) {
    this.projectDir = fs.realpathSync(opts.projectDir)
    this.clock = opts.clock ?? realClock
    this.evalFactory = opts.evalFactory ?? commandEvalFn
  }
  get runsDir() {
    return path.join(this.projectDir, '.lessonshare', 'runs')
  }

  /** Dispatch one tool call. Business refusals come back as {error, message}; ArgError propagates. */
  async call(tool: string, args: unknown): Promise<any> {
    const a: any = isObj(args) ? args : {}
    try {
      switch (tool) {
        case 'init_run':
          return await this.initRun(a)
        case 'join':
          return this.run(a).join({ writer_id: str(a, 'writer_id')!, session: num(a, 'session') ?? 0, agent_id: a._harness_agent_id, agent_type: a._harness_agent_type })
        case 'evaluate':
          return await this.run(a).evaluate({ writer_id: str(a, 'writer_id')!, note: str(a, 'note', false), agent_id: a._harness_agent_id })
        case 'get_result':
          return await this.run(a).getResult({ writer_id: str(a, 'writer_id')!, cand_id: str(a, 'cand_id')!, wait_s: num(a, 'wait_s'), agent_id: a._harness_agent_id })
        case 'post_lesson':
          return this.run(a).postLesson({ writer_id: str(a, 'writer_id')!, cand_id: str(a, 'cand_id')!, text: str(a, 'text')!, agent_id: a._harness_agent_id })
        case 'read_lessons':
          return this.run(a).readLessons({ writer_id: str(a, 'writer_id')!, cursor: num(a, 'cursor'), limit: num(a, 'limit'), agent_id: a._harness_agent_id })
        case 'status': {
          const run = this.run(a)
          // a registered writer agent only ever gets its own view (section 6.7)
          const forced = run.writerOfAgent(a._harness_agent_id)
          const wid = str(a, 'writer_id', false)
          if (forced && wid && wid !== forced) throw new HostError('identity_mismatch', `this agent is registered as ${forced}`)
          return run.status(forced ?? wid)
        }
        case 'confirm': {
          const run = this.run(a)
          if (run.writerOfAgent(a._harness_agent_id)) throw new HostError('forbidden', 'writers cannot confirm a run')
          this.maybeVerifier(run, a)
          return await run.confirm({ top_k: num(a, 'top_k'), replays: num(a, 'replays'), ranking: a.ranking })
        }
        case 'next_lesson': {
          const run = this.run(a)
          this.maybeVerifier(run, a)
          return await run.nextLesson({ session: num(a, 'session') ?? 0, wait_s: num(a, 'wait_s'), agent_id: a._harness_agent_id })
        }
        case 'verdict': {
          const run = this.run(a)
          this.maybeVerifier(run, a)
          return run.verdict({ lesson_id: str(a, 'lesson_id')!, verdict: str(a, 'verdict')!, note: str(a, 'note', false), agent_id: a._harness_agent_id })
        }
        default:
          throw new ArgError(`unknown tool "${tool}"`)
      }
    } catch (e) {
      if (e instanceof HostError) return { error: e.code, message: e.message, ...e.extra }
      throw e
    }
  }

  /** Agents of a verifier type get a guard mapping (read the run, write only their scratch directory). */
  private maybeVerifier(run: Run, a: any): void {
    if (typeof a._harness_agent_type === 'string' && /^lessonshare[:-]verifier/.test(a._harness_agent_type)) run.registerVerifier(a._harness_agent_id, a._harness_agent_type)
  }

  tick(): void {
    for (const r of this.runs.values()) r.tick()
  }

  // ---------- run registry, locking, recovery ----------
  private run(a: any): Run {
    const id = str(a, 'run_id')!
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new ArgError('invalid run_id')
    const cached = this.runs.get(id)
    if (cached) return cached
    const dir = path.join(this.runsDir, id)
    if (!fs.existsSync(path.join(dir, 'run.json'))) throw new HostError('unknown_run', `no run "${id}" in ${this.runsDir}`)
    this.lock(dir)
    const file = readJson<RunFile>(path.join(dir, 'run.json'))
    const run = new Run(dir, file, this.clock, this.evalFactory(file.config, this.projectDir))
    run.recover()
    run.log('run loaded from disk')
    this.runs.set(id, run)
    return run
  }
  private lock(dir: string): void {
    const f = path.join(dir, 'server.lock')
    try {
      const cur = readJson<{ pid: number }>(f)
      if (cur.pid !== process.pid) {
        let alive = true
        try {
          process.kill(cur.pid, 0)
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === 'EPERM'
        }
        if (alive) throw new HostError('run_locked', `run is owned by live process ${cur.pid}`)
      }
    } catch (e) {
      if (e instanceof HostError) throw e
    }
    writeJson(f, { pid: process.pid, started: new Date(this.clock.now()).toISOString() })
    this.locks.add(f)
  }
  releaseLocks(): void {
    for (const f of this.locks) {
      try {
        if (readJson<{ pid: number }>(f).pid === process.pid) fs.unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
    this.locks.clear()
  }

  // ---------- init_run ----------
  private async initRun(a: any) {
    const budget = isObj(a.budget) ? a.budget : {}
    if (a.resume_run_id != null) {
      const run = this.run({ run_id: a.resume_run_id })
      const minutes = num(budget, 'minutes') ?? run.cfg.budget.minutes
      if (!(minutes > 0)) throw new ArgError('budget.minutes must be positive')
      run.reopen(minutes, num(budget, 'evals') ?? null)
      return this.initResult(run, [`Run ${run.id} reopened with ${minutes} more minute(s).`], true)
    }
    const taskPath = str(a, 'task_path', false) ?? '.lessonshare/task.json'
    const mode = (str(a, 'mode', false) ?? 'lessonshare') as Mode
    const n = num(a, 'n') ?? 8
    const task = loadTaskFile(this.projectDir, taskPath)
    const cfg = buildConfig(this.projectDir, task, mode, n, budget, a.overrides)
    const now = this.clock.now()
    const ts = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const runId = `r-${ts}-${crypto.randomBytes(2).toString('hex').slice(0, 3)}`
    const dir = path.join(this.runsDir, runId)
    fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true })
    this.lock(dir)
    const agentMode = cfg.verify.kind === 'agent'
    const seedAbs = cfg.candidate.seed != null ? resolveInside(this.projectDir, cfg.candidate.seed, 'candidate.seed') : null
    const ids = writerIds(n)
    for (const id of ids) {
      fs.mkdirSync(path.join(dir, 'writers', id, 'work'), { recursive: true })
      if (seedAbs) copyDir(seedAbs, path.join(dir, 'writers', id, 'work'))
      for (const f of cfg.context_files) {
        const src = resolveInside(this.projectDir, f, 'context_files')
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new HostError('invalid_task', `context file "${f}" does not exist`)
        const dst = path.join(dir, 'writers', id, 'context', f)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
      }
    }
    if (cfg.shared.enabled) fs.mkdirSync(path.join(dir, 'shared'), { recursive: true })

    // Baseline and noise calibration on the seed snapshot (section 5.4).
    const evalFn = this.evalFactory(cfg, this.projectDir)
    const warnings: string[] = []
    let baseline: Baseline
    if (agentMode) {
      baseline = { status: 'none', metric: null, noise: null, runs: [] }
      if (!cfg.criteria.trim()) warnings.push('No criteria given. The verifier and the final judge only have the goal to judge by; add "criteria" to the task file to say what a good result looks like.')
    } else {
    const seedSnap = path.join(dir, 'candidates', 'seed', 'src')
    const seedFiles = matchFiles(seedAbs!, cfg.candidate.files!)
    if (!seedFiles.length) throw new HostError('invalid_task', 'candidate.files matches nothing in the seed directory')
    writeBlobs(seedSnap, readBlobs(seedAbs!, seedFiles))
    const runs: Baseline['runs'] = []
    let log = ''
    for (let i = 0; i < cfg.baseline_runs; i++) {
      let o = await evalFn({ kind: 'eval', candidate_dir: seedSnap, run_dir: dir, cand_id: 'seed' })
      if (o.status === 'infra_error') o = await evalFn({ kind: 'eval', candidate_dir: seedSnap, run_dir: dir, cand_id: 'seed' })
      log += `=== baseline run ${i + 1} ===\n${o.log}\n`
      runs.push({ status: o.status, metric: o.status === 'ok' ? o.metric : null })
      if (o.status === 'infra_error') {
        fs.writeFileSync(path.join(dir, 'candidates', 'seed', 'eval.log'), log)
        this.releaseOne(dir)
        throw new HostError('baseline_infra_error', `The evaluator failed on the seed candidate: ${o.detail}`, { eval_log_tail: tailLines(o.log, 40) })
      }
    }
    fs.writeFileSync(path.join(dir, 'candidates', 'seed', 'eval.log'), log)
    if (runs.every((r) => r.status === 'ok')) {
      const ms = runs.map((r) => r.metric!)
      const med = median(ms)
      const noise = med !== 0 ? round((Math.max(...ms) - Math.min(...ms)) / Math.abs(med), 5) : 0
      baseline = { status: 'ok', metric: med, noise, runs }
      if (noise >= cfg.metric.min_gain) warnings.push(`Evaluation noise (${(noise * 100).toFixed(2)}%) is not below metric.min_gain (${(cfg.metric.min_gain * 100).toFixed(2)}%). Noise may be pushed as verified gains. Suggested min_gain: ${Math.max(0.01, round(2 * noise, 4))}. The host did not change it.`)
    } else {
      const bad = runs.find((r) => r.status !== 'ok')!
      baseline = { status: bad.status, metric: null, noise: null, runs }
      warnings.push(`Baseline is ${bad.status}: the seed candidate is not correct. A writer's first correct candidate will not count as a verified gain.`)
    }
    }
    if (n < 8) warnings.push(`N=${n} is below 8. In the paper, lessons did not beat the alternatives at N=4 (41% vs 53% for an orchestrated team); they led or tied from N=8 (R9).`)
    if (cfg.budget.evals != null && cfg.budget.evals < n * 20) warnings.push(`budget.evals=${cfg.budget.evals} is below N x 20 = ${n * 20}. Tight evaluation caps suppressed every team design in the paper (R10).`)
    if (cfg.budget.minutes < 60) warnings.push(`budget.minutes=${cfg.budget.minutes} is short. In the paper most of the benefit of sharing appeared in the second hour (R10).`)
    const gi = spawnSync('git', ['check-ignore', '-q', path.join('.lessonshare', 'runs', 'x')], { cwd: this.projectDir })
    if (gi.status === 1) warnings.push('.lessonshare/runs/ is not ignored by git. Add ".lessonshare/runs/" to .gitignore.')

    const file: RunFile = { run_id: runId, created: new Date(now).toISOString(), project_dir: this.projectDir, config: cfg, baseline, writers: ids }
    writeJson(path.join(dir, 'run.json'), file)
    const run = new Run(dir, file, this.clock, evalFn)
    this.runs.set(runId, run)
    run.start() // budget clock starts here, after the baseline
    run.log(`run created: mode=${mode} n=${n}`)
    return this.initResult(run, warnings, false)
  }
  private releaseOne(dir: string) {
    const f = path.join(dir, 'server.lock')
    try {
      fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
    this.locks.delete(f)
  }
  private initResult(run: Run, warnings: string[], resumed: boolean) {
    return {
      run_id: run.id,
      run_dir: run.dir,
      writers: run.writerIds,
      baseline: { status: run.baseline.status, metric: run.baseline.metric, noise: run.baseline.noise },
      verify_kind: run.cfg.verify.kind,
      session_base: resumed ? run.maxSession() + 1 : 0,
      resumed,
      config: run.cfg,
      warnings,
    }
  }
}
