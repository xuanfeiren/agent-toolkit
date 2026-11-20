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
  verifier: { enabled: boolean; session_quota: number; wait_s: number; note_max_chars: number; bash: boolean }
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
    keep_rejected: boolean
  }
  push: { policy: 'verified' | 'all' | 'none'; max_per_delivery: number }
  read: { require_own_correct: boolean }
  /** show: which lessons writers can read. pull: whether read_lessons is available. */
  board: { enabled: boolean; show: 'all' | 'verified'; pull: boolean }
  shared: { enabled: boolean }
  /** keep_working: how many times a writer that tries to return early is sent back to work (0 = never). */
  session: { eval_quota: number; grace: number; keep_working: number }
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
  verifier: { enabled: true, session_quota: 30, wait_s: 600, note_max_chars: 300, bash: false },
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
      '[{;]\\s*$',
      '\\):\\s*$',
    ],
    def_patterns: ['\\b(def|fn|func|function)\\s+[A-Za-z_]\\w*\\s*\\('],
    api_patterns: [],
    max_per_candidate: 2,
    max_copy_chars: 40,
    keep_rejected: false,
  },
  push: { policy: 'verified', max_per_delivery: 5 },
  read: { require_own_correct: false },
  board: { enabled: true, show: 'all', pull: true },
  shared: { enabled: false },
  session: { eval_quota: null, grace: 3, keep_working: 8 },
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

/**
 * The short, user-facing switches. Each maps onto configuration keys; anything finer goes through `overrides`.
 * Defaults: isolated writers, verified lessons pushed, verifier on, whole board readable.
 */
export const SETTINGS: Record<string, { values: string; doc: string; to: (v: any) => unknown }> = {
  visibility: { values: '"isolated" | "shared"', doc: 'isolated: a writer reads only its own directory. shared: every checkpoint of every writer is readable by all (read-only).', to: (v) => (oneOf(v, ['isolated', 'shared'], 'visibility'), { shared: { enabled: v === 'shared' } }) },
  push: { values: '"verified" | "all" | "none"', doc: 'Which lessons are delivered to teammates with their next result. verified: only checked ones. all: every lesson that is not withheld. none: nothing is delivered; writers read the board themselves.', to: (v) => (oneOf(v, ['verified', 'all', 'none'], 'push'), { push: { policy: v } }) },
  verifier: { values: 'true | false', doc: 'Tasks without an evaluator only. false: no verifier agent; lessons appear on the board at once, labelled "not checked".', to: (v) => (bool(v, 'verifier'), { verifier: { enabled: v } }) },
  board: { values: '"all" | "verified" | "off"', doc: 'What writers may read on the board. all: every visible lesson with its label. verified: only verified ones. off: no lessons at all (independent writers).', to: (v) => (oneOf(v, ['all', 'verified', 'off'], 'board'), { board: { enabled: v !== 'off', show: v === 'verified' ? 'verified' : 'all' } }) },
  pull: { values: 'true | false', doc: 'false: writers cannot page through the board; they only get what is pushed.', to: (v) => (bool(v, 'pull'), { board: { pull: v } }) },
  lesson_chars: { values: 'integer', doc: 'Maximum length of one lesson in characters (default 2000).', to: (v) => (posInt(v, 'lesson_chars'), { lesson: { max_chars: v } }) },
  lesson_lines: { values: 'integer', doc: 'Maximum number of non-empty lines in one lesson (default 15).', to: (v) => (posInt(v, 'lesson_lines'), { lesson: { max_lines: v } }) },
  copy_chars: { values: 'integer', doc: "A lesson is rejected when it repeats this many consecutive characters of its author's own result (default 40; 0 turns the check off).", to: (v) => (nonNegInt(v, 'copy_chars'), { lesson: { max_copy_chars: v } }) },
  lessons_per_checkpoint: { values: 'integer', doc: 'How many lessons one checkpoint or candidate may carry (default 2).', to: (v) => (posInt(v, 'lessons_per_checkpoint'), { lesson: { max_per_candidate: v } }) },
  push_batch: { values: 'integer', doc: 'At most this many lessons are delivered with one result (default 5).', to: (v) => (posInt(v, 'push_batch'), { push: { max_per_delivery: v } }) },
  session_checkpoints: { values: 'integer', doc: 'Evaluations or checkpoints per writer session before it hands off to a fresh session (default 25 with an evaluator, 200 without).', to: (v) => (posInt(v, 'session_checkpoints'), { session: { eval_quota: v } }) },
  keep_working: { values: 'integer', doc: 'How many times a writer that tries to return while the run is open is sent back to work (default 8; 0 lets writers end sessions freely).', to: (v) => (nonNegInt(v, 'keep_working'), { session: { keep_working: v } }) },
  verified_only: { values: 'true', doc: 'One switch for the strict policy: only verified lessons are pushed and only verified lessons are readable on the board. Same as push "verified" with board "verified".', to: (v) => (v === true ? { push: { policy: 'verified' }, board: { enabled: true, show: 'verified' } } : bool(v, 'verified_only') ?? {}) },
  keep_rejected: { values: 'true | false', doc: 'true: the text of every lesson the host rejects is kept in rejected.jsonl in the run directory, for auditing the filter (default false: a rejected text may contain the author\'s result).', to: (v) => (bool(v, 'keep_rejected'), { lesson: { keep_rejected: v } }) },
  read_after_own_result: { values: 'true | false', doc: 'true: the board unlocks for a writer only after it has a correct result of its own (evaluator runs).', to: (v) => (bool(v, 'read_after_own_result'), { read: { require_own_correct: v } }) },
}
function oneOf(v: unknown, vals: string[], k: string) {
  if (!vals.includes(v as string)) throw new ArgError(`settings.${k} must be one of ${vals.join(', ')}`)
}
function bool(v: unknown, k: string) {
  if (typeof v !== 'boolean') throw new ArgError(`settings.${k} must be true or false`)
}
function posInt(v: unknown, k: string) {
  if (!Number.isInteger(v) || (v as number) < 1) throw new ArgError(`settings.${k} must be a positive integer`)
}
function nonNegInt(v: unknown, k: string) {
  if (!Number.isInteger(v) || (v as number) < 0) throw new ArgError(`settings.${k} must be a non-negative integer`)
}
export function settingsToOverrides(settings: unknown): unknown {
  if (settings == null) return {}
  if (!isObj(settings)) throw new ArgError('settings must be an object')
  let out: unknown = {}
  for (const [k, v] of Object.entries(settings)) {
    if (v === null || v === undefined) continue
    if (!(k in SETTINGS)) throw new ArgError(`unknown setting "${k}"; settings are: ${Object.keys(SETTINGS).join(', ')}`)
    out = deepMerge(out, SETTINGS[k].to(v))
  }
  return out
}
/** The effective switches of a run, in the vocabulary of SETTINGS. */
export function effectiveSettings(cfg: Config) {
  return {
    visibility: cfg.shared.enabled ? 'shared' : 'isolated',
    push: cfg.board.enabled ? cfg.push.policy : 'none',
    verification: cfg.verify.kind === 'command' ? 'evaluator' : cfg.verifier.enabled ? 'verifier agent' : 'none',
    board: !cfg.board.enabled ? 'off' : cfg.board.show,
    pull: cfg.board.enabled && cfg.board.pull,
    lesson_chars: cfg.lesson.max_chars,
    lesson_lines: cfg.lesson.max_lines,
    copy_chars: cfg.lesson.max_copy_chars,
    lessons_per_checkpoint: cfg.lesson.max_per_candidate,
    push_batch: cfg.push.max_per_delivery,
    session_checkpoints: cfg.session.eval_quota,
    keep_working: cfg.session.keep_working,
    keep_rejected: cfg.lesson.keep_rejected,
  }
}

/** Merge order: built-in defaults, task file, mode preset, settings, budget, overrides. Then validate and resolve paths. */
export function buildConfig(projectDir: string, task: any, mode: Mode, n: number, budget: unknown, overrides: unknown, settings: unknown = null): Config {
  if (!(mode in MODES)) throw new ArgError(`unknown mode "${mode}"; expected one of ${Object.keys(MODES).join(', ')}`)
  if (!isPosInt(n) || n > 99) throw new ArgError('n must be an integer between 1 and 99')
  let cfg: any = deepMerge(structuredClone(DEFAULTS), structuredClone(task))
  cfg = deepMerge(cfg, MODES[mode])
  cfg = deepMerge(cfg, settingsToOverrides(settings))
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
  need(isObj(cfg.board) && typeof cfg.board.enabled === 'boolean' && typeof cfg.board.pull === 'boolean' && ['all', 'verified'].includes(cfg.board.show), 'board must be {enabled, show: all|verified, pull}')
  need(typeof cfg.verifier.enabled === 'boolean', 'verifier.enabled must be boolean')
  // One long session per writer when nothing is measured; shorter sessions when an evaluator sets the pace.
  if (cfg.session.eval_quota == null) cfg.session.eval_quota = agentMode ? 200 : 25
  if (agentMode && !cfg.verifier.enabled && cfg.board.enabled && cfg.push.policy === 'verified') throw new HostError('invalid_task', 'With the verifier off nothing can be verified, so push "verified" would never deliver a lesson. Set push to "all" or "none", or keep the verifier on.')
  if (agentMode && !cfg.verifier.enabled && cfg.board.enabled && cfg.board.show === 'verified') throw new HostError('invalid_task', 'With the verifier off no lesson is ever verified, so board "verified" would stay empty. Set board to "all" or "off", or keep the verifier on.')
  need(isPosInt(cfg.push.max_per_delivery), 'push.max_per_delivery must be a positive integer')
  need(typeof cfg.read.require_own_correct === 'boolean', 'read.require_own_correct must be boolean')
  need(typeof cfg.lesson.keep_rejected === 'boolean', 'lesson.keep_rejected must be boolean')
  if (agentMode && cfg.read.require_own_correct) throw new HostError('invalid_task', 'read_after_own_result needs an evaluator: without one no result is ever marked correct, so the board would stay locked for the whole run. Leave it off. Pushes already wait for a writer\'s first checkpoint in runs without an evaluator.')
  need(isPosInt(cfg.session.eval_quota), 'session.eval_quota must be a positive integer')
  need(Number.isInteger(cfg.session.grace) && cfg.session.grace >= 0, 'session.grace must be a non-negative integer')
  need(Number.isInteger(cfg.session.keep_working) && cfg.session.keep_working >= 0, 'session.keep_working must be a non-negative integer')
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
