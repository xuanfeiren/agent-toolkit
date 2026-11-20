import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { Host } from '../src/core/host'
import type { EvalFn, EvalOutcome } from '../src/core/evalcmd'
import { deepMerge, readJsonl } from '../src/core/util'

const require_ = createRequire(import.meta.url)
export const { makeSolution } = require_('./fixtures/solutions.cjs') as { makeSolution: (f?: Record<string, unknown>) => string }
export const ROOT = path.resolve(__dirname, '..')

export class FakeClock {
  t = Date.parse('2026-11-18T19:51:04Z')
  now() {
    return this.t
  }
  advance(minutes: number) {
    this.t += minutes * 60000
  }
}

/** A temp project containing the toy task. `task` is merged over the toy task file. */
export function mkToyProject(task: unknown = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-')))
  fs.cpSync(path.join(ROOT, 'examples', 'toy'), path.join(dir, 'toy'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.lessonshare'))
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'toy', 'task.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify(deepMerge(base, task)))
  return dir
}

/** A temp project whose candidate is a JSON file that literally states its evaluation outcome. */
export function mkJsonProject(task: unknown = {}, seed: unknown = { status: 'ok', metric: 100 }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-')))
  fs.mkdirSync(path.join(dir, 'seed'))
  fs.writeFileSync(path.join(dir, 'seed', 'c.json'), JSON.stringify(seed))
  fs.mkdirSync(path.join(dir, '.lessonshare'))
  const base = { name: 'json', goal: 'g', candidate: { seed: 'seed' }, eval: { command: ['true'], block_s: 5 }, metric: { name: 'ms', direction: 'min' } }
  fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify(deepMerge(base, task)))
  return dir
}

export interface JsonEvalCtl {
  order: string[]
  running: number
  maxRunning: number
  delayMs: number
  /** per-candidate scripted outcomes for successive evaluations (used for flaky replays) */
  script: Record<string, Array<Partial<EvalOutcome>>>
  gate: Promise<void> | null
  calls: number
}
export function jsonEval(ctl: Partial<JsonEvalCtl> = {}): { ctl: JsonEvalCtl; factory: () => EvalFn } {
  const c: JsonEvalCtl = { order: [], running: 0, maxRunning: 0, delayMs: 0, script: {}, gate: null, calls: 0, ...ctl }
  const factory = (): EvalFn => async (ctx) => {
    c.calls++
    c.running++
    c.maxRunning = Math.max(c.maxRunning, c.running)
    if (ctx.cand_id !== 'seed') c.order.push(ctx.cand_id)
    // read the candidate at start: later edits to work/ must not matter
    const body = JSON.parse(fs.readFileSync(path.join(ctx.candidate_dir, 'c.json'), 'utf8'))
    if (c.gate) await c.gate
    if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs))
    c.running--
    const scripted = c.script[ctx.cand_id]?.shift()
    const o = { ...body, ...(scripted ?? {}) }
    return { status: o.status, metric: o.status === 'ok' ? o.metric : null, detail: o.detail ?? '', eval_s: 0.01, log: 'json eval' }
  }
  return { ctl: c, factory }
}

export function setJson(run: { run_dir: string }, writer: string, body: unknown) {
  fs.writeFileSync(path.join(run.run_dir, 'writers', writer, 'work', 'c.json'), JSON.stringify(body))
}
export function setSolution(run: { run_dir: string }, writer: string, flags: Record<string, unknown>) {
  fs.writeFileSync(path.join(run.run_dir, 'writers', writer, 'work', 'solution.js'), makeSolution(flags))
}
export function events(run: { run_dir: string }, type?: string): any[] {
  const evs = readJsonl(path.join(run.run_dir, 'events.jsonl'))
  return type ? evs.filter((e) => e.type === type) : evs
}
export async function jsonRun(task: unknown = {}, init: Record<string, unknown> = {}, ctlInit: Partial<JsonEvalCtl> = {}, seed?: unknown) {
  const dir = mkJsonProject(task, seed)
  const clock = new FakeClock()
  const { ctl, factory } = jsonEval(ctlInit)
  const host = new Host({ projectDir: dir, clock, evalFactory: factory })
  const run = await host.call('init_run', { n: 3, mode: 'lessonshare', ...init })
  if (run.error) throw new Error('init failed: ' + JSON.stringify(run))
  const call = (tool: string, a: Record<string, unknown> = {}) => host.call(tool, { run_id: run.run_id, ...a })
  for (const w of run.writers) await call('join', { writer_id: w, session: 0 })
  /** set the candidate body and evaluate it */
  const ev = async (writer: string, body: unknown, note = '') => {
    setJson(run, writer, body)
    return call('evaluate', { writer_id: writer, note })
  }
  return { dir, clock, ctl, host, run, call, ev, factory }
}
