import * as fs from 'node:fs'
import * as path from 'node:path'
import { ArgError, HostError, deepMerge, isObj, listFiles, resolveInside } from './util'

export type Mode = 'independent' | 'lessonshare' | 'lessonshare-pull' | 'workspace'
export const MODES: Record<Mode, unknown> = {
  independent: { board: { enabled: false }, push: { policy: 'none' }, shared: { enabled: false } },
  lessonshare: { board: { enabled: true }, push: { policy: 'verified' }, shared: { enabled: false } },
  'lessonshare-pull': { board: { enabled: true }, push: { policy: 'none' }, shared: { enabled: false } },
  workspace: { board: { enabled: false }, push: { policy: 'none' }, shared: { enabled: true } },
}

export interface EvalSpec {
  command: string[]
  cwd: string
  timeout_s: number
}

export interface Config {
  name: string
  goal: string
  /** What a good result looks like. Given to the verifier and the final judge (agent verification). */
  criteria: string
  context_files: string[]
  candidate: { seed: string | null; files: string[] | null; max_bytes: number }
  /** command: an evaluation command gates lessons by measured gain. agent: a verifier agent checks each lesson. */
  verify: { kind: 'command' | 'agent' }
  verifier: { session_quota: number; wait_s: number; note_max_chars: number; bash: boolean }
  eval: EvalSpec & {
    concurrency: number
    precheck: Partial<EvalSpec> | null
    precheck_concurrency: number
    block_s: number
    max_pending: number
    max_candidates: number
  }
  metric: { name: string; direction: 'min' | 'max'; target: number | null; min_gain: number }
  gate: { reference: 'author_best' | 'team_best_seen' }
  baseline_runs: number
  lesson: {
    max_chars: number
    max_lines: number
    max_code_lines: number
    code_patterns: string[]
    def_patterns: string[]
    api_patterns: string[]
    max_per_candidate: number
    max_copy_chars: number
  }
  push: { policy: 'verified' | 'all' | 'none'; max_per_delivery: number }
  read: { require_own_correct: boolean }
  board: { enabled: boolean }
  shared: { enabled: boolean }
  session: { eval_quota: number; grace: number }
  budget: { minutes: number; evals: number | null }
  stop: { on_target: boolean | null }
  confirm: { replays: number; top_k: number; max_candidates: number }
  writer: { extra_tools: string[] }
  mode: Mode
  n: number
}

/** Built-in defaults (section 12.2). Everything here can be overridden by the task file or init_run overrides. */
export const DEFAULTS = {
  criteria: '',
  context_files: [] as string[],
  candidate: { seed: null, files: null, max_bytes: 1048576 },
  verify: { kind: null },
  verifier: { session_quota: 30, wait_s: 600, note_max_chars: 300, bash: false },
  eval: { command: null, cwd: '.', timeout_s: 600, concurrency: 1, precheck: null, precheck_concurrency: 4, block_s: 300, max_pending: 2, max_candidates: 384 },
  metric: { name: null, direction: null, target: null, min_gain: 0.01 },
  gate: { reference: 'author_best' },
  baseline_runs: 3,
  lesson: {
    max_chars: 2000,
    max_lines: 15,
    max_code_lines: 3,
    code_patterns: [
      '^\\s*(def|class|import|fn|func|function|return)\\b',
      '^\\s*from\\s+\\S+\\s+import\\b',
      '^\\s*#include\\b',
      '^\\s*(for|while|if)\\s*\\(',
      '[{};]\\s*$',
      '\\):\\s*$',
    ],
    def_patterns: ['\\b(def|fn|func|function)\\s+[A-Za-z_]\\w*\\s*\\('],
    api_patterns: [],
    max_per_candidate: 2,
    max_copy_chars: 40,
  },
  push: { policy: 'verified', max_per_delivery: 5 },
  read: { require_own_correct: false },
  board: { enabled: true },
  shared: { enabled: false },
  session: { eval_quota: 25, grace: 3 },
  budget: { minutes: 120, evals: null },
  stop: { on_target: null },
  confirm: { replays: 3, top_k: 3, max_candidates: 10 },
  writer: { extra_tools: [] as string[] },
}

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new HostError('invalid_task', msg)
}
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isPosInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0

export function loadTaskFile(projectDir: string, taskPath: string): any {
  const abs = resolveInside(projectDir, taskPath, 'task_path')
  let raw: string
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch {
    throw new HostError('task_not_found', `cannot read task file ${taskPath}`)
  }
  try {
    const t = JSON.parse(raw)
    need(isObj(t), 'task file must be a JSON object')
    return t
  } catch (e) {
    if (e instanceof HostError) throw e
    throw new HostError('invalid_task', `task file is not valid JSON: ${(e as Error).message}`)
  }
}

/** Merge order: built-in defaults, task file, mode preset, overrides. Then validate and resolve paths. */
export function buildConfig(projectDir: string, task: any, mode: Mode, n: number, budget: unknown, overrides: unknown): Config {
  if (!(mode in MODES)) throw new ArgError(`unknown mode "${mode}"; expected one of ${Object.keys(MODES).join(', ')}`)
  if (!isPosInt(n) || n > 99) throw new ArgError('n must be an integer between 1 and 99')
  let cfg: any = deepMerge(structuredClone(DEFAULTS), structuredClone(task))
  cfg = deepMerge(cfg, MODES[mode])
  if (isObj(budget)) cfg = deepMerge(cfg, { budget: Object.fromEntries(Object.entries(budget).filter(([, v]) => v !== null && v !== undefined)) })
  cfg = deepMerge(cfg, overrides)
  cfg.mode = mode
  cfg.n = n
  validateConfig(projectDir, cfg)
  return cfg as Config
}

export function validateConfig(projectDir: string, cfg: any): void {
  need(typeof cfg.name === 'string' && cfg.name, 'name is required')
  need(typeof cfg.goal === 'string' && cfg.goal, 'goal is required')
  need(Array.isArray(cfg.context_files) && cfg.context_files.every((f: unknown) => typeof f === 'string'), 'context_files must be an array of strings')
  for (const f of cfg.context_files) resolveInside(projectDir, f, 'context_files')
  need(typeof cfg.criteria === 'string', 'criteria must be a string')
  need(isObj(cfg.verify), 'verify must be an object')
  need(isObj(cfg.eval), 'eval must be an object')
  if (cfg.verify.kind == null) cfg.verify.kind = cfg.eval.command != null ? 'command' : 'agent'
  need(cfg.verify.kind === 'command' || cfg.verify.kind === 'agent', 'verify.kind must be "command" or "agent"')
  const agentMode = cfg.verify.kind === 'agent'
  need(isObj(cfg.candidate), 'candidate must be an object')
  if (!agentMode) need(typeof cfg.candidate.seed === 'string', 'candidate.seed is required when an evaluation command is used')
  if (cfg.candidate.seed != null) {
    need(typeof cfg.candidate.seed === 'string', 'candidate.seed must be a path')
    const seedAbs = resolveInside(projectDir, cfg.candidate.seed, 'candidate.seed')
    need(fs.existsSync(seedAbs) && fs.statSync(seedAbs).isDirectory(), `candidate.seed "${cfg.candidate.seed}" is not a directory`)
    if (cfg.candidate.files == null) cfg.candidate.files = agentMode ? ['**'] : listFiles(seedAbs)
  } else if (cfg.candidate.files == null) cfg.candidate.files = ['**']
  need(Array.isArray(cfg.candidate.files) && cfg.candidate.files.length > 0 && cfg.candidate.files.every((f: unknown) => typeof f === 'string'), 'candidate.files must be a non-empty array of globs')
  for (const g of cfg.candidate.files as string[]) {
    if (path.isAbsolute(g) || g.split(/[\\/]/).includes('..')) throw new HostError('path_escape', `candidate.files: "${g}" must stay inside the work directory`)
  }
  need(isPosInt(cfg.candidate.max_bytes), 'candidate.max_bytes must be a positive integer')
  if (!agentMode) validateEvalSpec(projectDir, cfg.eval, 'eval')
  else {
    need(cfg.eval.precheck == null, 'eval.precheck needs an evaluation command (verify.kind "command")')
    if (cfg.metric.name == null) cfg.metric.name = 'score'
    if (cfg.metric.direction == null) cfg.metric.direction = 'max'
    need(cfg.metric.target == null, 'metric.target needs an evaluation command (verify.kind "command")')
  }
  if (cfg.eval.precheck != null) {
    need(isObj(cfg.eval.precheck), 'eval.precheck must be an object or null')
    cfg.eval.precheck = { cwd: cfg.eval.cwd, timeout_s: cfg.eval.timeout_s, ...cfg.eval.precheck }
    validateEvalSpec(projectDir, cfg.eval.precheck, 'eval.precheck')
  }
  for (const k of ['concurrency', 'precheck_concurrency', 'max_pending', 'max_candidates']) need(isPosInt(cfg.eval[k]), `eval.${k} must be a positive integer`)
  need(isNum(cfg.eval.block_s) && cfg.eval.block_s >= 0, 'eval.block_s must be a non-negative number')
  need(isObj(cfg.metric) && typeof cfg.metric.name === 'string' && cfg.metric.name, 'metric.name is required')
  need(cfg.metric.direction === 'min' || cfg.metric.direction === 'max', 'metric.direction must be "min" or "max"')
  need(cfg.metric.target == null || isNum(cfg.metric.target), 'metric.target must be a number')
  if (cfg.metric.target === undefined) cfg.metric.target = null
  need(isNum(cfg.metric.min_gain) && cfg.metric.min_gain >= 0, 'metric.min_gain must be a non-negative number')
  need(['author_best', 'team_best_seen'].includes(cfg.gate.reference), 'gate.reference must be author_best or team_best_seen')
  need(isPosInt(cfg.baseline_runs), 'baseline_runs must be a positive integer')
  for (const k of ['max_chars', 'max_lines', 'max_code_lines', 'max_per_candidate']) need(isPosInt(cfg.lesson[k]), `lesson.${k} must be a positive integer`)
  need(Number.isInteger(cfg.lesson.max_copy_chars) && cfg.lesson.max_copy_chars >= 0, 'lesson.max_copy_chars must be a non-negative integer (0 disables the check)')
  for (const k of ['session_quota', 'wait_s', 'note_max_chars']) need(isPosInt(cfg.verifier[k]), `verifier.${k} must be a positive integer`)
  need(typeof cfg.verifier.bash === 'boolean', 'verifier.bash must be boolean')
  for (const k of ['code_patterns', 'def_patterns', 'api_patterns']) {
    need(Array.isArray(cfg.lesson[k]), `lesson.${k} must be an array of regular expressions`)
    for (const p of cfg.lesson[k]) {
      try {
        new RegExp(p)
      } catch {
        throw new HostError('invalid_task', `lesson.${k}: invalid regular expression ${JSON.stringify(p)}`)
      }
    }
  }
  need(['verified', 'all', 'none'].includes(cfg.push.policy), 'push.policy must be verified, all or none')
  need(isPosInt(cfg.push.max_per_delivery), 'push.max_per_delivery must be a positive integer')
  need(typeof cfg.read.require_own_correct === 'boolean', 'read.require_own_correct must be boolean')
  need(isPosInt(cfg.session.eval_quota), 'session.eval_quota must be a positive integer')
  need(Number.isInteger(cfg.session.grace) && cfg.session.grace >= 0, 'session.grace must be a non-negative integer')
  need(isNum(cfg.budget.minutes) && cfg.budget.minutes > 0, 'budget.minutes must be a positive number')
  need(cfg.budget.evals == null || isPosInt(cfg.budget.evals), 'budget.evals must be a positive integer or null')
  if (cfg.budget.evals === undefined) cfg.budget.evals = null
  if (cfg.stop.on_target == null) cfg.stop.on_target = cfg.metric.target != null
  need(typeof cfg.stop.on_target === 'boolean', 'stop.on_target must be boolean')
  for (const k of ['replays', 'top_k', 'max_candidates']) need(isPosInt(cfg.confirm[k]), `confirm.${k} must be a positive integer`)
  need(Array.isArray(cfg.writer.extra_tools), 'writer.extra_tools must be an array')
}

function validateEvalSpec(projectDir: string, spec: any, what: string): void {
  need(Array.isArray(spec.command) && spec.command.length > 0 && spec.command.every((a: unknown) => typeof a === 'string'), `${what}.command must be a non-empty argv array of strings`)
  need(typeof spec.cwd === 'string', `${what}.cwd must be a string`)
  resolveInside(projectDir, spec.cwd, `${what}.cwd`)
  need(isNum(spec.timeout_s) && spec.timeout_s > 0, `${what}.timeout_s must be a positive number`)
}

export function writerIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `w${String(i + 1).padStart(2, '0')}`)
}
