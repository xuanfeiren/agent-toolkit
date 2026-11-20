// CLI front end: inspect runs, try the evaluation contract, calibrate noise. Thin wrapper over src/core.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildConfig, loadTaskFile } from '../core/config'
import { Host, commandEvalFn } from '../core/host'
import { buildReport, renderReportMd } from '../core/report'
import { fmtNum, median, readJson, readJsonl, round } from '../core/util'

const USAGE = `lessonshare <command>

  runs                               list runs in this project
  board <run_id> [--follow]          print the lesson board in time order
  report <run_id>                    print report.md, or the current state if not confirmed
  eval <task.json> <candidate_dir>   run the evaluation command once and show how the host parses it
  calibrate <task.json> [--runs 10]  evaluate the seed repeatedly; print noise and a suggested min_gain
  call <tool> '<json-args>'          call a host tool directly (fallback when MCP is unavailable)

The project directory is the current directory (or $LESSONSHARE_PROJECT_DIR).`

const projectDir = () => fs.realpathSync(process.env.LESSONSHARE_PROJECT_DIR && !process.env.LESSONSHARE_PROJECT_DIR.includes('${') ? process.env.LESSONSHARE_PROJECT_DIR : process.cwd())
const runsDir = () => path.join(projectDir(), '.lessonshare', 'runs')
const fail = (msg: string): never => {
  process.stderr.write(msg + '\n')
  process.exit(1)
}
function runDir(id: string | undefined): string {
  if (!id) fail('run_id is required. Use "lessonshare runs" to list runs.')
  const d = path.join(runsDir(), id!)
  if (!fs.existsSync(path.join(d, 'run.json'))) fail(`no run "${id}" in ${runsDir()}`)
  return d
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function cmdRuns() {
  let names: string[] = []
  try {
    names = fs.readdirSync(runsDir()).sort()
  } catch {
    /* none */
  }
  if (!names.length) return console.log('no runs in ' + runsDir())
  for (const id of names) {
    const d = path.join(runsDir(), id)
    if (!fs.existsSync(path.join(d, 'run.json'))) continue
    const rf = readJson(path.join(d, 'run.json'))
    const evs = readJsonl(path.join(d, 'events.jsonl'))
    let state = 'open'
    let best: number | null = null
    for (const e of evs) {
      if (e.type === 'run_closed') state = 'closed:' + e.reason
      if (e.type === 'run_reopened') state = 'open'
      if (e.type === 'run_confirmed') state = 'confirmed'
      if (e.type === 'eval_result' && e.is_team_best) best = e.metric
    }
    console.log(`${id}  ${rf.config.mode.padEnd(16)} n=${String(rf.config.n).padEnd(3)} ${state.padEnd(16)} task=${rf.config.name}  baseline=${rf.baseline.metric == null ? '-' : fmtNum(rf.baseline.metric)}  best=${best == null ? '-' : fmtNum(best)}`)
  }
}

async function cmdBoard(args: string[]) {
  const d = runDir(args[0])
  const file = path.join(d, 'lessons.jsonl')
  let shown = 0
  const done = new Set<string>()
  const print = () => {
    // under agent verification a lesson is printed once its verdict exists (the verdict rewrites header and push state)
    const verdicts = new Map<string, any>()
    for (const e of readJsonl(path.join(d, 'events.jsonl'))) if (e.type === 'lesson_verdict') verdicts.set(e.lesson_id, e)
    for (const l of readJsonl(file)) {
      if (done.has(l.lesson_id)) continue
      const v = verdicts.get(l.lesson_id)
      if (l.verdict === 'pending' && !v && args.includes('--follow')) continue
      const header = v ? v.header : l.header
      const pushed = v ? v.pushed : l.pushed
      const tag = v?.verdict === 'withheld' ? 'HIDDEN' : pushed ? 'PUSHED' : 'board '
      console.log(`${l.lesson_id}  min ${l.minute}  ${tag}  ${header}${l.corrects ? `  (corrects ${l.corrects})` : ''}\n${l.text}\n`)
      done.add(l.lesson_id)
      shown++
    }
  }
  print()
  if (!shown && !args.includes('--follow')) console.log('(no lessons)')
  if (args.includes('--follow')) for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    print()
  }
}

function cmdReport(args: string[]) {
  const d = runDir(args[0])
  const md = path.join(d, 'report.md')
  if (fs.existsSync(md) && readJsonl(path.join(d, 'events.jsonl')).some((e) => e.type === 'run_confirmed')) return process.stdout.write(fs.readFileSync(md, 'utf8'))
  console.log('(run not confirmed; current state)\n')
  process.stdout.write(renderReportMd(buildReport(d)))
}

async function evalOnce(taskPath: string, candDir: string) {
  const proj = projectDir()
  const cfg = buildConfig(proj, loadTaskFile(proj, taskPath), 'lessonshare', 1, {}, {})
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lessonshare-eval-'))
  const fn = commandEvalFn(cfg, proj)
  return { cfg, run: () => fn({ kind: 'eval', candidate_dir: path.resolve(candDir), run_dir: tmp, cand_id: 'try' }) }
}

async function cmdEval(args: string[]) {
  if (args.length < 2) fail('usage: lessonshare eval <task.json> <candidate_dir>')
  const { cfg, run } = await evalOnce(args[0], args[1])
  const o = await run()
  console.log(o.log.trimEnd())
  console.log('\n--- host view ---')
  console.log(JSON.stringify({ status: o.status, metric: o.metric, detail: o.detail, eval_s: round(o.eval_s, 2) }, null, 2))
  if (o.status === 'infra_error') {
    console.log('\nContract problem: the last non-empty stdout line must be a JSON object like {"status":"ok","metric":1.12,"detail":"..."}; the process must exit 0.')
    process.exit(2)
  }
  const perHour = (3600 * cfg.eval.concurrency) / Math.max(o.eval_s, 0.001)
  console.log(`\nThroughput at eval.concurrency=${cfg.eval.concurrency}: about ${Math.round(perHour)} evaluations/hour for the whole team.`)
}

async function cmdCalibrate(args: string[]) {
  if (!args[0]) fail('usage: lessonshare calibrate <task.json> [--runs 10]')
  const runs = Number(flag(args, '--runs') ?? 10)
  const proj = projectDir()
  const task = loadTaskFile(proj, args[0])
  const { cfg, run } = await evalOnce(args[0], path.resolve(proj, task.candidate?.seed ?? '.'))
  const ms: number[] = []
  let secs = 0
  for (let i = 0; i < runs; i++) {
    const o = await run()
    secs += o.eval_s
    console.log(`run ${i + 1}: ${o.status}${o.metric == null ? '' : ' ' + fmtNum(o.metric)} (${round(o.eval_s, 2)}s)${o.status === 'ok' ? '' : ' ' + o.detail}`)
    if (o.status !== 'ok') fail(`seed is not ok (${o.status}); fix the seed or the evaluator before calibrating.`)
    ms.push(o.metric!)
  }
  const med = median(ms)
  const noise = med !== 0 ? (Math.max(...ms) - Math.min(...ms)) / Math.abs(med) : 0
  const suggested = Math.max(0.01, round(2 * noise, 4))
  console.log(JSON.stringify({ baseline: med, noise: round(noise, 5), min_gain_configured: cfg.metric.min_gain, min_gain_suggested: suggested, mean_eval_s: round(secs / runs, 2), evals_per_hour_team: Math.round((3600 * cfg.eval.concurrency) / Math.max(secs / runs, 0.001)) }, null, 2))
  if (noise >= cfg.metric.min_gain) console.log(`WARNING: noise ${(noise * 100).toFixed(2)}% is not below min_gain ${(cfg.metric.min_gain * 100).toFixed(2)}%. Set metric.min_gain to ${suggested} in the task file.`)
}

async function cmdCall(args: string[]) {
  if (!args[0]) fail("usage: lessonshare call <tool> '<json-args>'")
  const host = new Host({ projectDir: projectDir() })
  try {
    const out = await host.call(args[0], args[1] ? JSON.parse(args[1]) : {})
    console.log(JSON.stringify(out, null, 2))
  } finally {
    host.releaseLocks()
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    switch (cmd) {
      case 'runs':
        return cmdRuns()
      case 'board':
        return await cmdBoard(args)
      case 'report':
        return cmdReport(args)
      case 'eval':
        return await cmdEval(args)
      case 'calibrate':
        return await cmdCalibrate(args)
      case 'call':
        return await cmdCall(args)
      default:
        console.log(USAGE)
        process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0)
    }
  } catch (e) {
    fail(`error: ${(e as Error).message}`)
  }
}
main()
