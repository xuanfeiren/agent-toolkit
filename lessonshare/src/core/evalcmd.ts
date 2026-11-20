import { spawn } from 'node:child_process'
import type { EvalSpec } from './config'

/** 'recorded' is a checkpoint in runs without an evaluation command. */
export type EvalStatus = 'ok' | 'incorrect' | 'build_error' | 'infra_error' | 'recorded'
export interface EvalOutcome {
  status: EvalStatus
  metric: number | null
  detail: string
  eval_s: number
  log: string
}
export interface EvalCtx {
  kind: 'eval' | 'precheck'
  candidate_dir: string
  run_dir: string
  cand_id: string
}
export type EvalFn = (ctx: EvalCtx) => Promise<EvalOutcome>

const MAX_CAPTURE = 1 << 20
const MAX_LOG = 200_000
export const MAX_DETAIL = 2000

export function substitute(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => a.replace(/\{(candidate_dir|run_dir|cand_id)\}/g, (_, k) => vars[k] ?? ''))
}

function tailLines(s: string, n: number): string {
  return s.split('\n').slice(-n).join('\n')
}

/** Parse the evaluation contract (section 5.2): the last non-empty stdout line is a JSON object. */
export function parseEvalOutput(stdout: string): { status: EvalStatus; metric: number | null; detail: string } {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  if (!lines.length) return { status: 'infra_error', metric: null, detail: 'evaluator printed nothing on stdout' }
  let obj: any
  try {
    obj = JSON.parse(lines[lines.length - 1])
  } catch {
    return { status: 'infra_error', metric: null, detail: 'last stdout line of the evaluator is not valid JSON' }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { status: 'infra_error', metric: null, detail: 'last stdout line of the evaluator is not a JSON object' }
  let detail = typeof obj.detail === 'string' ? obj.detail : ''
  if (detail.length > MAX_DETAIL) detail = detail.slice(0, MAX_DETAIL)
  if (obj.status === 'ok') {
    if (typeof obj.metric !== 'number' || !Number.isFinite(obj.metric)) return { status: 'infra_error', metric: null, detail: 'status ok without a finite numeric metric' }
    return { status: 'ok', metric: obj.metric, detail }
  }
  if (obj.status === 'incorrect' || obj.status === 'build_error') return { status: obj.status, metric: null, detail }
  return { status: 'infra_error', metric: null, detail: `unknown status ${JSON.stringify(obj.status)}` }
}

/** Run one evaluator process: argv, no shell, fresh process, hard timeout on the whole process group. */
export function runCommand(spec: EvalSpec, cwdAbs: string, vars: Record<string, string>): Promise<EvalOutcome> {
  return new Promise((resolve) => {
    const argv = substitute(spec.command, vars)
    const t0 = Date.now()
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (o: Omit<EvalOutcome, 'eval_s' | 'log'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let log = `$ ${argv.join(' ')}\n--- stdout ---\n${out}\n--- stderr ---\n${err}\n`
      if (log.length > MAX_LOG) log = log.slice(0, MAX_LOG / 2) + '\n...[truncated]...\n' + log.slice(-MAX_LOG / 2)
      resolve({ ...o, eval_s: (Date.now() - t0) / 1000, log })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cwdAbs, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      return resolve({ status: 'infra_error', metric: null, detail: `failed to start evaluator: ${(e as Error).message}`, eval_s: 0, log: String(e) })
    }
    timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, spec.timeout_s * 1000)
    child.stdout!.on('data', (d) => {
      if (out.length < MAX_CAPTURE) out += d
    })
    child.stderr!.on('data', (d) => {
      if (err.length < MAX_CAPTURE) err += d
    })
    child.on('error', (e) => finish({ status: 'infra_error', metric: null, detail: `failed to start evaluator: ${e.message}` }))
    child.on('close', (code, signal) => {
      if (timedOut) return finish({ status: 'infra_error', metric: null, detail: `evaluator timed out after ${spec.timeout_s}s` })
      if (code !== 0) return finish({ status: 'infra_error', metric: null, detail: `evaluator exited with ${signal ? 'signal ' + signal : 'code ' + code}` })
      finish(parseEvalOutput(out))
    })
  })
}

/** A precheck passes when the process exits 0. If it prints a contract line with a non-ok status, that also fails it. */
export function interpretPrecheck(o: EvalOutcome): { pass: boolean; detail: string } {
  if (o.status === 'ok') return { pass: true, detail: '' }
  if (o.status === 'build_error' || o.status === 'incorrect') return { pass: false, detail: o.detail }
  // infra_error: exit 0 with free-form output still counts as a pass
  if (/not valid JSON|printed nothing|not a JSON object|unknown status|without a finite/.test(o.detail)) return { pass: true, detail: '' }
  return { pass: false, detail: (o.detail + '\n' + tailLines(o.log, 20)).slice(0, MAX_DETAIL) }
}

export { tailLines }
