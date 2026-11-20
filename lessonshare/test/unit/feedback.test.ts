// Regression tests for the defects and gaps reported from a 5-writer, 120-minute field run (2026-11-20).
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { Host } from '../../src/core/host'
import { readJson, readJsonl } from '../../src/core/util'
import { FakeClock, ROOT, events } from '../helpers'

async function openRun(init: Record<string, unknown> = {}, task: Record<string, unknown> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-fb-')))
  fs.mkdirSync(path.join(dir, '.lessonshare'))
  fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify({ name: 'open', goal: 'Find the longest chain.', criteria: 'Valid first, then longer.', candidate: { files: ['answer.md'] }, ...task }))
  const clock = new FakeClock()
  const mk = () => new Host({ projectDir: dir, clock })
  const host = mk()
  const run = await host.call('init_run', { n: 3, ...init })
  if (run.error) throw new Error(JSON.stringify(run))
  const on = (h: Host) => (tool: string, a: Record<string, unknown> = {}) => h.call(tool, { run_id: run.run_id, ...a })
  const call = on(host)
  for (const w of run.writers) await call('join', { writer_id: w, session: 0 })
  const answer = (w: string, text: string) => fs.writeFileSync(path.join(run.run_dir, 'writers', w, 'work', 'answer.md'), text)
  const checkpoint = async (w: string, text: string, extra: Record<string, unknown> = {}, c = call) => {
    answer(w, text)
    return c('evaluate', { writer_id: w, note: 'progress', ...extra })
  }
  return { dir, clock, host, mk, on, run, call, checkpoint, answer }
}
const V = { _harness_agent_id: 'ver1', _harness_agent_type: 'lessonshare:verifier' }
const rank = (rows: Array<[string, number, string, boolean?]>) => rows.map(([writer_id, score, reason, meets_bar]) => ({ writer_id, score, reason, ...(meets_bar == null ? {} : { meets_bar }) }))
const L = (n: number) => `Insight number ${n}: large primes only sit next to one, so at most two of them fit. Checked by listing multiples.`

describe('B01: a reopened run reports the results of its new round', () => {
  it('final and winner follow the checkpoint saved after the reopen; the earlier round stays on disk', async () => {
    const t = await openRun()
    await t.checkpoint('w01', 'old')
    await t.call('confirm', V)
    const first = await t.call('confirm', { ranking: rank([['w01', 5, 'ok'], ['w02', 0, 'empty', false], ['w03', 0, 'empty', false]]), ...V })
    expect(first.winner).toMatchObject({ writer_id: 'w01', cand_id: 'final-w01', generation: 0 })

    const re = await t.host.call('init_run', { resume_run_id: t.run.run_id, budget: { minutes: 30 } })
    expect(re).toMatchObject({ resumed: true, generation: 1, writers: ['w01', 'w02', 'w03'] })
    await t.call('join', { writer_id: 'w01', session: 1 })
    await t.checkpoint('w01', 'NEW')
    const ask = await t.call('confirm', V)
    expect(ask.generation).toBe(1)
    expect(fs.readFileSync(path.join(ask.finals[0].final_dir, 'answer.md'), 'utf8')).toBe('NEW')
    expect(await t.call('confirm', V)).toEqual(ask) // retry in the same round: same finals, nothing rewritten
    const rep = await t.call('confirm', { ranking: rank([['w01', 7, 'better'], ['w02', 0, 'empty', false], ['w03', 0, 'empty', false]]), ...V })
    expect(rep.winner).toMatchObject({ writer_id: 'w01', cand_id: 'final-w01-g1', generation: 1 })
    expect(rep.generation).toBe(1)
    expect(fs.readFileSync(path.join(t.run.run_dir, 'winner', 'answer.md'), 'utf8')).toBe('NEW')
    // the first round is still there, under its own names
    expect(fs.readFileSync(path.join(t.run.run_dir, 'candidates', 'final-w01', 'src', 'answer.md'), 'utf8')).toBe('old')
    expect(readJson(path.join(t.run.run_dir, 'report-g0.json')).winner.cand_id).toBe('final-w01')
    const m = readJson(path.join(t.run.run_dir, 'candidates', 'final-w01-g1', 'final.json'))
    expect(m).toMatchObject({ generation: 1, source: 'c0002', files: ['answer.md'] })
    expect(rep.winner.hash).toBe(m.hash)
  })
  it('a final directory left without its manifest is rebuilt, and a writer with nothing new keeps its last checkpoint', async () => {
    const t = await openRun()
    await t.checkpoint('w01', 'one')
    await t.call('confirm', V)
    await t.host.call('init_run', { resume_run_id: t.run.run_id, budget: { minutes: 30 } })
    // a torn write of the new round: directory present, manifest missing
    fs.mkdirSync(path.join(t.run.run_dir, 'candidates', 'final-w01-g1', 'src'), { recursive: true })
    fs.writeFileSync(path.join(t.run.run_dir, 'candidates', 'final-w01-g1', 'src', 'answer.md'), 'half written')
    const ask = await t.call('confirm', V)
    expect(fs.readFileSync(path.join(ask.finals[0].final_dir, 'answer.md'), 'utf8')).toBe('one')
    expect(ask.finals[0].source).toBe('c0001')
  })
})

describe('B02: one live owner per run', () => {
  it('of several processes loading the same run at the same instant, exactly one succeeds', async () => {
    const t = await openRun()
    t.host.releaseLocks()
    const out = path.join(t.dir, 'racer.cjs')
    buildSync({
      stdin: {
        contents: `import { Host } from ${JSON.stringify(path.join(ROOT, 'src/core/host.ts'))}
          const [dir, runId, at] = process.argv.slice(2)
          const host = new Host({ projectDir: dir })
          while (Date.now() < Number(at)) {}
          host.call('status', { run_id: runId }).then((r) => { console.log(r.error ? 'ERR ' + r.error : 'OK'); setTimeout(() => process.exit(0), 1500) })`,
        resolveDir: ROOT,
        loader: 'ts',
      },
      outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    })
    const at = Date.now() + 1200
    const results = await Promise.all(
      Array.from({ length: 6 }, () => new Promise<string>((resolve) => {
        const p = spawn(process.execPath, [out, t.dir, t.run.run_id, String(at)])
        let buf = ''
        p.stdout.on('data', (d) => (buf += d))
        p.on('close', () => resolve(buf.trim()))
      })),
    )
    expect(results.filter((r) => r === 'OK')).toHaveLength(1)
    expect(results.filter((r) => r === 'ERR run_locked')).toHaveLength(5)
  }, 30000)
  it('a lock left by a dead process is taken over; a damaged lock too; a live one is refused', async () => {
    const t = await openRun()
    const lock = path.join(t.run.run_dir, 'server.lock')
    t.host.releaseLocks()
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 })) // no such process
    expect((await t.mk().call('status', { run_id: t.run.run_id })).run_id).toBe(t.run.run_id)
    expect(readJson(lock).pid).toBe(process.pid)
    fs.writeFileSync(lock, '{"pid":') // cut off mid-write by a crash
    expect((await t.mk().call('status', { run_id: t.run.run_id })).run_id).toBe(t.run.run_id)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid }))
    expect((await t.mk().call('status', { run_id: t.run.run_id })).error).toBe('run_locked')
    expect(fs.existsSync(lock + '.takeover')).toBe(false)
  })
})

describe('B03: a record cut off by a crash does not swallow the next one', () => {
  it('the torn tail is set aside and events written after recovery survive another recovery', async () => {
    const t = await openRun({ budget: { minutes: 90 } })
    await t.checkpoint('w01', 'one')
    t.host.releaseLocks()
    const log = path.join(t.run.run_dir, 'events.jsonl')
    fs.appendFileSync(log, '{"type":') // no newline
    const h2 = t.mk()
    const re = await h2.call('init_run', { resume_run_id: t.run.run_id, budget: { minutes: 120 } })
    expect(re.warnings.join(' ')).toMatch(/cut off by a crash was set aside/)
    expect(re.minutes_left).toBe(120)
    h2.releaseLocks()
    const again = await t.mk().call('status', { run_id: t.run.run_id })
    expect(again.budget.minutes_left).toBe(120) // not back to 90: run_reopened was read back
    expect(events(t.run, 'run_reopened')).toHaveLength(1)
    expect(events(t.run, 'log_repaired')).toHaveLength(1)
    expect(Buffer.from(readJsonl(log + '.corrupt')[0].base64, 'base64').toString()).toBe('{"type":')
    expect(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l).every((l) => JSON.parse(l))).toBe(true)
  })
  it('a complete last record that only lacks its newline is kept; a hook appending to a torn log starts a new line', async () => {
    const t = await openRun()
    t.host.releaseLocks()
    const log = path.join(t.run.run_dir, 'events.jsonl')
    fs.appendFileSync(log, JSON.stringify({ t: new Date(t.clock.now()).toISOString(), minute: 0, type: 'guard_denied', tool: 'Read' })) // complete, no newline
    await t.mk().call('status', { run_id: t.run.run_id })
    expect(events(t.run, 'guard_denied')).toHaveLength(1)
    expect(fs.existsSync(log + '.corrupt')).toBe(false)
    const { appendLineSync } = await import('../../src/core/util')
    fs.appendFileSync(log, '{"type":"torn')
    appendLineSync(log, { type: 'after' })
    expect(events(t.run, 'after')).toHaveLength(1)
  })
})

describe('B04/B05: the host enforces the roster and the ranking contract', () => {
  it('resume refuses a different n and keeps the roster', async () => {
    const t = await openRun()
    expect((await t.host.call('init_run', { resume_run_id: t.run.run_id, n: 8 })).error).toBe('roster_mismatch')
    expect(events(t.run, 'run_reopened')).toHaveLength(0)
    expect((await t.host.call('init_run', { resume_run_id: t.run.run_id, n: 3, budget: { minutes: 5 } })).writers).toEqual(['w01', 'w02', 'w03'])
  })
  it('a ranking must cover every writer once, with scores from 0 to 10 and a reason', async () => {
    const t = await openRun()
    await t.checkpoint('w01', 'a')
    await t.checkpoint('w02', 'b')
    await t.call('confirm', V)
    const bad = async (ranking: unknown, re: RegExp) => expect(t.call('confirm', { ranking, ...V })).rejects.toThrow(re)
    await bad(rank([['w02', 999, 'best']]), /scores go from 0 to 10/)
    await bad(rank([['w02', 5, 'fine']]), /no row for w01, w03/)
    await bad(rank([['w01', 5, 'a'], ['w01', 6, 'b'], ['w02', 1, 'c'], ['w03', 0, 'd', false]]), /w01 appears more than once/)
    await bad(rank([['w01', 5, '  '], ['w02', 1, 'c'], ['w03', 0, 'd', false]]), /w01 has no reason/)
    await bad(rank([['w01', -1, 'a'], ['w02', 1, 'c'], ['w03', 0, 'd', false]]), /0 to 10/)
    await bad(rank([['w01', 5, 'a'], ['w02', 1, 'c'], ['w03', 4, 'nothing there']]), /w03 has no result files/)
    await bad(rank([['w01', 5, 'a'], ['w02', 1, 'c'], ['w09', 0, 'd']]), /unknown writer_id/)
    expect(fs.existsSync(path.join(t.run.run_dir, 'report.json'))).toBe(false)
    expect(events(t.run, 'run_confirmed')).toHaveLength(0)
    const rep = await t.call('confirm', { ranking: rank([['w01', 5, 'a'], ['w02', 1, 'c'], ['w03', 0, 'd', false]]), ...V })
    expect(rep.winner.writer_id).toBe('w01')
  })
  it('the judge may say that no result meets the bar: the report then names no winner', async () => {
    const t = await openRun()
    await t.checkpoint('w01', 'a')
    await t.call('confirm', V)
    const rep = await t.call('confirm', { ranking: rank([['w01', 3, 'invalid chain', false], ['w02', 0, 'empty', false], ['w03', 0, 'empty', false]]), ...V })
    expect(rep).toMatchObject({ winner: null, no_validated_winner: true, top_ranked: { writer_id: 'w01', score: 3 } })
    expect(fs.existsSync(path.join(t.run.run_dir, 'winner'))).toBe(false)
    expect(fs.readFileSync(path.join(t.run.run_dir, 'report.md'), 'utf8')).toMatch(/Winner: none\.\*\* The judge found no result that meets the bar\. Highest-ranked: w01/)
  })
})

describe('verdicts, corrections and use', () => {
  it('partly_verified is pushed with its own label and counts separately', async () => {
    const t = await openRun({ settings: { verified_only: true } })
    expect(t.run.settings).toMatchObject({ push: 'verified', board: 'verified' })
    const c = await t.checkpoint('w01', 'a')
    const l = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L(1) })
    expect(await t.call('verdict', { lesson_id: l.lesson_id, verdict: 'partly_verified', note: 'the bound holds; the count of primes is 6, not 5', ...V })).toMatchObject({ pushed: true })
    const got = await t.checkpoint('w02', 'b')
    expect(got.pushed_lessons[0].header).toBe('[w01 · c0001 · PARTLY verified by verifier, read the correction: the bound holds; the count of primes is 6, not 5]')
    await t.call('confirm', V)
    const rep = await t.call('confirm', { ranking: rank([['w01', 5, 'a'], ['w02', 4, 'b'], ['w03', 0, 'c', false]]), ...V })
    expect(rep.diagnostics.verification.verdicts).toMatchObject({ verified: 0, partly_verified: 1 })
  })
  it('a correction names its target, reaches the holders of the original first, and marks the original', async () => {
    const t = await openRun({ settings: { push_batch: 1 } })
    const c = await t.checkpoint('w01', 'a')
    const l1 = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L(1) })
    await t.call('verdict', { lesson_id: l1.lesson_id, verdict: 'verified', note: 'checked', ...V })
    expect((await t.checkpoint('w02', 'b')).pushed_lessons.map((x: any) => x.lesson_id)).toEqual(['L0001'])
    // a backlog builds up, then the author retracts L0001
    const c2 = await t.checkpoint('w01', 'a2')
    const l2 = await t.call('post_lesson', { writer_id: 'w01', cand_id: c2.cand_id, text: L(2) })
    await t.call('verdict', { lesson_id: l2.lesson_id, verdict: 'verified', note: 'checked', ...V })
    expect((await t.call('post_lesson', { writer_id: 'w01', cand_id: c2.cand_id, text: L(3), corrects: 'L0099' })).error).toBe('unknown_lesson')
    const l3 = await t.call('post_lesson', { writer_id: 'w01', cand_id: c2.cand_id, text: 'L0001 was wrong about the count: three such primes fit when one end is free. Rechecked by hand.', corrects: 'L0001' })
    const nl = await t.call('next_lesson', { session: 0, wait_s: 0, ...V })
    expect(nl.corrects).toMatchObject({ lesson_id: 'L0001', writer_id: 'w01' })
    await t.call('verdict', { lesson_id: l3.lesson_id, verdict: 'verified', note: 'rechecked', ...V })
    const next = await t.checkpoint('w02', 'b2')
    expect(next.pushed_lessons).toHaveLength(1)
    expect(next.pushed_lessons[0]).toMatchObject({ lesson_id: l3.lesson_id, corrects: 'L0001' }) // ahead of L0002
    expect(next.pushed_lessons[0].header).toMatch(/corrects L0001\]$/)
    const board = await t.call('read_lessons', { writer_id: 'w03' })
    expect(board.lessons.find((x: any) => x.lesson_id === 'L0001').header).toMatch(/CORRECTED BY L0003/)
    // a second verdict on a decided lesson is still refused: corrections are new lessons, on the record
    expect((await t.call('verdict', { lesson_id: 'L0001', verdict: 'refuted', note: 'x', ...V })).error).toBe('already_decided')
  })
  it('used_lessons records a self-declared use tied to the checkpoint; the report separates it from deliveries', async () => {
    const t = await openRun()
    const c = await t.checkpoint('w01', 'a')
    const l = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L(1) })
    await t.call('verdict', { lesson_id: l.lesson_id, verdict: 'verified', note: 'checked', ...V })
    await t.checkpoint('w02', 'b')
    const r = await t.checkpoint('w02', 'b2', { used_lessons: ['L0001', 'L0042'] })
    expect(r.used_lessons_ignored).toEqual(['L0042'])
    expect(events(t.run, 'lessons_used')[0]).toMatchObject({ writer_id: 'w02', cand_id: 'c0003', lesson_ids: ['L0001'] })
    await t.call('confirm', V)
    const rep = await t.call('confirm', { ranking: rank([['w01', 5, 'a'], ['w02', 4, 'b'], ['w03', 0, 'c', false]]), ...V })
    expect(rep.team.lessons).toMatchObject({ delivered_pairs: 1, undelivered_pairs: 1, used_declared_pairs: 1 })
    expect(fs.readFileSync(path.join(t.run.run_dir, 'report.md'), 'utf8')).toMatch(/not that it was read or used/)
  })
})

describe('observability and contracts', () => {
  it('a checkpoint says that nothing was executed', async () => {
    const t = await openRun()
    expect(await t.checkpoint('w01', 'a')).toMatchObject({ status: 'recorded', execution_performed: false })
  })
  it('status hands a writer its waiting pushes, but only after its first checkpoint; the lead sees who waits and why', async () => {
    const t = await openRun()
    const c = await t.checkpoint('w01', 'a')
    const l = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L(1) })
    await t.call('verdict', { lesson_id: l.lesson_id, verdict: 'verified', note: 'checked', ...V })
    t.clock.advance(12)
    const lead = await t.call('status')
    expect(lead.writers[1]).toMatchObject({ writer_id: 'w02', pushes_waiting: 1, oldest_push_wait_min: 12, waiting_because: expect.stringMatching(/no checkpoint yet/) })
    const asW2 = { _harness_agent_id: 'ag2', _harness_agent_type: 'lessonshare:writer' }
    await t.call('join', { writer_id: 'w02', session: 0, ...asW2 })
    expect((await t.call('status', asW2)).pushed_lessons).toBeUndefined() // no first result of its own yet
    // w03 saves a first result (and gets L0001 with it); the next approved lesson can then be collected by status
    const asW3 = { _harness_agent_id: 'ag3', _harness_agent_type: 'lessonshare:writer' }
    await t.call('join', { writer_id: 'w03', session: 0, ...asW3 })
    t.answer('w03', 'c')
    expect((await t.call('evaluate', { writer_id: 'w03', ...asW3 })).pushed_lessons).toHaveLength(1)
    const c2 = await t.checkpoint('w01', 'a2')
    const l2 = await t.call('post_lesson', { writer_id: 'w01', cand_id: c2.cand_id, text: L(2) })
    await t.call('verdict', { lesson_id: l2.lesson_id, verdict: 'verified', note: 'checked', ...V })
    const st = await t.call('status', asW3)
    expect(st.pushed_lessons.map((x: any) => x.lesson_id)).toEqual(['L0002'])
    expect(events(t.run, 'lesson_delivered').filter((e) => e.to === 'w03').map((e) => e.with_cand)).toEqual(['c0002', 'status'])
    expect((await t.call('status', asW3)).pushed_lessons).toEqual([])
  })
  it('a rejection names the rule and the lines; rejected text is kept only when asked', async () => {
    const t = await openRun({ settings: { keep_rejected: true } })
    const c = await t.checkpoint('w01', 'LENGTH: 12 SEQUENCE: 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6 and more of the same')
    const code = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: 'I tried this.\nreturn the chain;\nfor (x of xs) {\nimport nothing\nand it worked.' })
    expect(code).toMatchObject({ error: 'looks_like_code', rule: 'max_code_lines=3', lines: [2, 3, 4] })
    expect(code.message).toMatch(/Lines 2, 3, 4/)
    const copy = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: 'My chain is 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6 and it is long.' })
    expect(copy).toMatchObject({ error: 'contains_solution', rule: 'copy_chars=40' })
    expect(copy.message).toMatch(/passage starting "/)
    expect(readJsonl(path.join(t.run.run_dir, 'rejected.jsonl')).map((r) => r.error)).toEqual(['looks_like_code', 'contains_solution'])
    const quiet = await openRun()
    const c2 = await quiet.checkpoint('w01', 'x')
    await quiet.call('post_lesson', { writer_id: 'w01', cand_id: c2.cand_id, text: '```\ncode\n```' })
    expect(fs.existsSync(path.join(quiet.run.run_dir, 'rejected.jsonl'))).toBe(false)
    // a line of mathematics that ends with a closing brace is not code
    const { validateLessonText } = await import('../../src/core/lesson')
    expect(validateLessonText('The bound is\n\\frac{S A}{1-\\gamma}\n\\sqrt{T \\log{T}}\n\\sum_{t} r_{t}', quiet.run.config.lesson)).toBeNull()
  })
  it('recover continues an open run with the deadline it has; a closed run needs an explicit reopen', async () => {
    const t = await openRun({ budget: { minutes: 60 } })
    t.clock.advance(20)
    t.host.releaseLocks()
    const h2 = t.mk()
    const r = await h2.call('init_run', { resume_run_id: t.run.run_id, recover: true })
    expect(r).toMatchObject({ resumed: true, minutes_left: 40, generation: 0 })
    expect((await h2.call('init_run', { resume_run_id: t.run.run_id, recover: true })).minutes_left).toBe(40) // repeating changes nothing
    expect(events(t.run, 'run_reopened')).toHaveLength(0)
    t.clock.advance(50)
    expect((await h2.call('init_run', { resume_run_id: t.run.run_id, recover: true })).error).toBe('run_closed')
  })
  it('settings that cannot work together are refused at launch', async () => {
    await expect(openRun({ settings: { read_after_own_result: true } })).rejects.toThrow(/needs an evaluator/)
  })
  it('the report says when the run ended before its deadline and which pushes arrived too late', async () => {
    const t = await openRun({ budget: { minutes: 60 } })
    const c = await t.checkpoint('w01', 'a')
    await t.checkpoint('w02', 'b')
    t.clock.advance(10)
    const l = await t.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L(1) })
    await t.call('verdict', { lesson_id: l.lesson_id, verdict: 'verified', note: 'checked', ...V }) // after w02's last checkpoint
    await t.call('confirm', V)
    const rep = await t.call('confirm', { ranking: rank([['w01', 5, 'a'], ['w02', 4, 'b'], ['w03', 0, 'c', false]]), ...V })
    expect(rep.unused_minutes).toBe(50)
    expect(rep.team.lessons.undelivered_pushed_after_last_checkpoint).toBe(2)
    expect(rep.warnings.join(' ')).toMatch(/50 minute\(s\) before its deadline/)
    expect(rep.diagnostics.lexical_families).toBe(2)
  })
})
