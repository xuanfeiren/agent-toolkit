import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Host } from '../../src/core/host'
import { parseEvalOutput } from '../../src/core/evalcmd'
import { lessonHeader, validateLessonText } from '../../src/core/lesson'
import { DEFAULTS } from '../../src/core/config'
import { Deferred, readJson } from '../../src/core/util'
import { FakeClock, events, jsonEval, jsonRun, mkJsonProject, mkToyProject, setJson, setSolution } from '../helpers'

let tagN = 0
const ok = (metric: number) => ({ status: 'ok', metric, tag: ++tagN })
const bad = (status: string) => ({ status, tag: ++tagN })

describe('gate', () => {
  it('min direction: reference falls back to baseline, then to the author best before this evaluation', async () => {
    const { ev } = await jsonRun()
    const r1 = await ev('w01', ok(90))
    expect(r1).toMatchObject({ status: 'ok', reference: 100, verified_gain: true, is_own_best: true })
    expect(r1.gain).toBeCloseTo(0.1)
    const r2 = await ev('w01', ok(89.5)) // 0.56% better than 90: below 1%
    expect(r2).toMatchObject({ reference: 90, verified_gain: false, is_own_best: true })
    const r3 = await ev('w01', ok(95)) // worse; reference is the best before this evaluation (89.5)
    expect(r3).toMatchObject({ reference: 89.5, verified_gain: false, is_own_best: false })
    expect(r3.gain).toBeLessThan(0)
    const other = await ev('w02', ok(99.5)) // another writer still compares against baseline
    expect(other).toMatchObject({ reference: 100, verified_gain: false })
  })
  it('gain exactly at the threshold is a verified gain', async () => {
    const { ev } = await jsonRun()
    expect(await ev('w01', ok(99))).toMatchObject({ verified_gain: true })
    expect(await ev('w02', ok(99.01))).toMatchObject({ verified_gain: false })
  })
  it('max direction', async () => {
    const { ev } = await jsonRun({ metric: { direction: 'max' } })
    const r = await ev('w01', ok(110))
    expect(r).toMatchObject({ reference: 100, verified_gain: true })
    expect(r.gain).toBeCloseTo(0.1)
    expect(await ev('w01', ok(105))).toMatchObject({ reference: 110, verified_gain: false, is_own_best: false })
  })
  it('empty baseline: the first correct candidate is not a gain, later ones are', async () => {
    const { ev, run } = await jsonRun({}, {}, {}, { status: 'incorrect' })
    expect(run.baseline).toMatchObject({ status: 'incorrect', metric: null })
    expect(run.warnings.join(' ')).toMatch(/Baseline is incorrect/)
    expect(await ev('w01', ok(50))).toMatchObject({ reference: null, gain: null, verified_gain: false, is_own_best: true })
    expect(await ev('w01', ok(40))).toMatchObject({ reference: 50, verified_gain: true })
  })
  it('gate.reference=team_best_seen also requires beating the best lesson seen', async () => {
    const { ev, call } = await jsonRun({}, { overrides: { gate: { reference: 'team_best_seen' } } })
    const a = await ev('w01', ok(50))
    await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: 'Halving the work halved the time.' })
    expect(await ev('w02', ok(90))).toMatchObject({ reference: 100, verified_gain: true }) // the push arrives with this result
    expect(await ev('w02', ok(60))).toMatchObject({ reference: 50, verified_gain: false })
    expect(await ev('w02', ok(45))).toMatchObject({ reference: 50, verified_gain: true })
  })
})

describe('queue', () => {
  it('rotates between writers and respects eval.concurrency and max_pending', async () => {
    const gate = new Deferred<void>()
    const { ev, ctl, call } = await jsonRun({ eval: { max_pending: 5, block_s: 0 } }, {}, {})
    ctl.gate = gate.promise
    const a: any[] = []
    for (let i = 0; i < 5; i++) a.push(await ev('w01', ok(90 - i)))
    const b = await ev('w02', ok(80))
    expect(a[0].status).toBe('running')
    expect(b.queue_position).toBe(1) // next to start, ahead of w01's other four
    const sixth = await ev('w01', ok(70))
    expect(sixth.error).toBe('too_many_pending')
    gate.resolve()
    ctl.gate = null
    for (const x of [...a, b]) await call('get_result', { writer_id: x === b ? 'w02' : 'w01', cand_id: x.cand_id, wait_s: 5 })
    expect(ctl.order.slice(0, 3)).toEqual([a[0].cand_id, b.cand_id, a[1].cand_id])
    expect(ctl.maxRunning).toBe(1)
  })
  it('runs up to eval.concurrency evaluations at once', async () => {
    const { ev, ctl, call } = await jsonRun({ eval: { concurrency: 2, block_s: 0 } }, {}, { delayMs: 30 })
    const rs = [await ev('w01', ok(90)), await ev('w02', ok(91)), await ev('w03', ok(92))]
    for (let i = 0; i < 3; i++) await call('get_result', { writer_id: `w0${i + 1}`, cand_id: rs[i].cand_id, wait_s: 5 })
    expect(ctl.maxRunning).toBe(2)
  })
})

describe('snapshot', () => {
  it('identical content is not re-evaluated and does not use budget', async () => {
    const { ev, ctl, run, call } = await jsonRun()
    const body = ok(90)
    const r1 = await ev('w01', body)
    const calls = ctl.calls
    const r2 = await ev('w01', body)
    expect(r2).toMatchObject({ duplicate_of: r1.cand_id, metric: 90 })
    expect(ctl.calls).toBe(calls)
    expect(events(run, 'eval_submitted')).toHaveLength(1)
    expect((await call('status', {})).evals.counted).toBe(1)
  })
  it('rejects candidates above max_bytes', async () => {
    const { ev } = await jsonRun({ candidate: { max_bytes: 200 } })
    expect((await ev('w01', { status: 'ok', metric: 1, pad: 'x'.repeat(300) })).error).toBe('too_large')
  })
  it('edits to work/ during evaluation do not affect the submitted snapshot', async () => {
    const gate = new Deferred<void>()
    const { ev, run, call, ctl } = await jsonRun({ eval: { block_s: 0 } })
    // hold the evaluator before it reads: json evaluator reads the snapshot dir, never work/
    ctl.gate = gate.promise
    const r = await ev('w01', ok(77))
    setJson(run, 'w01', ok(1))
    gate.resolve()
    const done = await call('get_result', { writer_id: 'w01', cand_id: r.cand_id, wait_s: 5 })
    expect(done.metric).toBe(77)
    const snap = readJson(path.join(run.run_dir, 'candidates', r.cand_id, 'src', 'c.json'))
    expect(snap.metric).toBe(77)
    const res = events(run, 'eval_result')[0]
    expect(res.evaluated_hash).toBe(res.hash)
  })
})

describe('evaluation contract', () => {
  it('takes the last non-empty stdout line', () => {
    expect(parseEvalOutput('noise\n{"status":"incorrect"}\n{"status":"ok","metric":1.5,"detail":"d"}\n\n')).toEqual({ status: 'ok', metric: 1.5, detail: 'd' })
    expect(parseEvalOutput('{"status":"ok","metric":1}\nnot json')).toMatchObject({ status: 'infra_error' })
    expect(parseEvalOutput('{"status":"ok"}')).toMatchObject({ status: 'infra_error' })
    expect(parseEvalOutput('{"status":"weird"}')).toMatchObject({ status: 'infra_error' })
    expect(parseEvalOutput('')).toMatchObject({ status: 'infra_error' })
    expect(parseEvalOutput(JSON.stringify({ status: 'incorrect', detail: 'x'.repeat(3000) })).detail).toHaveLength(2000)
  })
  it('non-zero exit, timeout and invalid JSON are infra_error, retried once, and never counted', async () => {
    const dir = mkToyProject()
    const counter = path.join(dir, 'count.txt')
    const script = path.join(dir, 'ev.js')
    fs.writeFileSync(
      script,
      `const fs=require('fs');const m=fs.readFileSync(process.argv[2]+'/solution.js','utf8').trim();fs.appendFileSync(${JSON.stringify(counter)},m+'\\n');
if(m==='seed')console.log('{"status":"ok","metric":10}');else if(m==='exit')process.exit(3);else if(m==='hang')setTimeout(()=>{},60000);else if(m==='junk')console.log('hello');
else if(m==='build')console.log('{"status":"build_error","detail":"no"}');else if(m==='flaky'){if(fs.readFileSync(${JSON.stringify(counter)},'utf8').split('flaky').length>2)console.log('{"status":"ok","metric":5}');else process.exit(1)}`,
    )
    fs.writeFileSync(path.join(dir, 'toy', 'baseline', 'solution.js'), 'seed')
    const task = readJson(path.join(dir, '.lessonshare', 'task.json'))
    task.eval = { command: ['node', 'ev.js', '{candidate_dir}'], timeout_s: 1 }
    task.budget = { evals: 100 }
    fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify(task))
    const host = new Host({ projectDir: dir })
    const run = await host.call('init_run', { n: 1 })
    expect(run.baseline).toMatchObject({ status: 'ok', metric: 10, noise: 0 })
    await host.call('join', { run_id: run.run_id, writer_id: 'w01', session: 0 })
    const go = async (m: string) => {
      fs.writeFileSync(path.join(run.run_dir, 'writers', 'w01', 'work', 'solution.js'), m)
      return host.call('evaluate', { run_id: run.run_id, writer_id: 'w01' })
    }
    const count = (m: string) => fs.readFileSync(counter, 'utf8').split('\n').filter((l) => l === m).length
    for (const m of ['exit', 'junk', 'hang']) {
      const r = await go(m)
      expect(r.status).toBe('infra_error')
      expect(count(m)).toBe(2) // retried once
    }
    expect((await go('build')).status).toBe('build_error')
    expect((await go('flaky')).status).toBe('ok') // second attempt succeeds
    const st = await host.call('status', { run_id: run.run_id })
    expect(st.evals.counted).toBe(1)
    expect(st.budget.evals_left).toBe(99)
    host.releaseLocks()
  }, 20000)
  it('init_run fails with the log tail when the seed evaluation is an infra error', async () => {
    const dir = mkToyProject({ eval: { command: ['node', '-e', 'console.error("boom");process.exit(2)'] } })
    const r = await new Host({ projectDir: dir }).call('init_run', { n: 1 })
    expect(r.error).toBe('baseline_infra_error')
    expect(r.eval_log_tail).toMatch(/boom/)
  })
})

describe('lesson validation', () => {
  const lc = DEFAULTS.lesson as any
  it('length boundary', () => {
    expect(validateLessonText('a'.repeat(2000), lc)).toBeNull()
    expect(validateLessonText('a'.repeat(2001), lc)).toBe('too_long')
  })
  it('fenced code blocks', () => {
    expect(validateLessonText('use ``` here', lc)).toBe('code_block')
    expect(validateLessonText('~~~\nx\n~~~', lc)).toBe('code_block')
    expect(validateLessonText('single `backticks` are fine', lc)).toBeNull()
  })
  it('line count boundary counts non-empty lines', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i} about tiling.`).join('\n\n')
    expect(validateLessonText(lines(15), lc)).toBeNull()
    expect(validateLessonText(lines(16), lc)).toBe('too_many_lines')
  })
  it('code-looking lines', () => {
    expect(validateLessonText('Memoizing price by name cut cost from 30768 to 14928.\nIt depends on names repeating.', lc)).toBeNull()
    expect(validateLessonText('I changed this:\nfor (let i = 0; i < n; i++) {\n  total += price(o);\n}', lc)).toBe('looks_like_code')
    expect(validateLessonText('def solve(x):\n    return x\nimport os', lc)).toBe('looks_like_code')
    expect(validateLessonText('One line ending with a brace {\nand prose after.', lc)).toBeNull() // 1 < 3
  })
  it('function definition together with an api pattern', () => {
    const withApi = { ...lc, api_patterns: ['nl\\.\\w+'] }
    expect(validateLessonText('I wrote def kernel(a) that calls nl.matmul once.', withApi)).toBe('looks_like_code')
    expect(validateLessonText('Calling nl.matmul once instead of twice helped.', withApi)).toBeNull()
    expect(validateLessonText('I wrote def kernel(a) differently.', withApi)).toBeNull()
  })
  it('header reflects the evaluation record', () => {
    const m = { name: 'latency_ms', direction: 'min', target: null, min_gain: 0.01 } as any
    expect(lessonHeader('w05', 'c0038', { status: 'ok', metric: 1.29, reference: 1.44, gain: 0.104, verified_gain: true }, m)).toBe('[w05 · c0038 · ok · latency_ms 1.44 → 1.29 (10.4% better) · verified gain]')
    expect(lessonHeader('w02', 'c0017', { status: 'incorrect', metric: null, reference: 1.3, gain: null, verified_gain: false }, m)).toBe('[w02 · c0017 · incorrect]')
    expect(lessonHeader('w02', 'c0019', { status: 'ok', metric: 1.4, reference: 1.36, gain: -0.029, verified_gain: false }, m)).toBe('[w02 · c0019 · ok · latency_ms 1.36 → 1.4 (2.9% worse) · no gain]')
  })
  it('post_lesson applies the rules in order and records rejections', async () => {
    const t = await jsonRun()
    const a = await t.ev('w01', ok(90))
    const p = (w: string, c: string, text: string) => t.call('post_lesson', { writer_id: w, cand_id: c, text })
    expect((await p('w02', a.cand_id, 'not mine')).error).toBe('unknown_candidate')
    expect((await p('w01', 'c9999', 'nope')).error).toBe('unknown_candidate')
    expect((await p('w01', a.cand_id, 'x'.repeat(2001))).error).toBe('too_long')
    const rej = await p('w01', a.cand_id, '```js\nx\n```')
    expect(rej).toMatchObject({ error: 'code_block', message: 'Lessons are short prose. State the design insight and its measured effect in words, without code.' })
    const good = await p('w01', a.cand_id, 'Caching cut the cost by ten percent.')
    expect(good).toMatchObject({ lesson_id: 'L0001', pushed: true, header: '[w01 · c0001 · ok · ms 100 → 90 (10.0% better) · verified gain]' })
    expect((await p('w01', a.cand_id, 'Caching cut the cost by ten percent.')).error).toBe('duplicate')
    expect(await p('w01', a.cand_id, 'Untested: batching may help too.')).toMatchObject({ pushed: false })
    expect((await p('w01', a.cand_id, 'A third note.')).error).toBe('too_many_for_candidate')
    expect(events(t.run, 'lesson_rejected').map((e) => e.error)).toEqual(['unknown_candidate', 'unknown_candidate', 'too_long', 'code_block', 'duplicate', 'too_many_for_candidate'])
    // a still-running candidate cannot carry a lesson
    const gate = new Deferred<void>()
    const u = await jsonRun({ eval: { block_s: 0 } })
    u.ctl.gate = gate.promise
    const running = await u.ev('w01', ok(50))
    expect(running.status).toBe('running')
    expect((await u.call('post_lesson', { writer_id: 'w01', cand_id: running.cand_id, text: 'too early' })).error).toBe('unknown_candidate')
    gate.resolve()
    expect((await u.call('get_result', { writer_id: 'w01', cand_id: running.cand_id, wait_s: 5 })).status).toBe('ok')
  })
})

describe('push', () => {
  it('only the first lesson on a verified-gain candidate is pushed; never to the author; once per writer; rides on any result status', async () => {
    const { ev, call, run } = await jsonRun()
    const post = (w: string, c: string, text: string) => call('post_lesson', { writer_id: w, cand_id: c, text })
    const g = await ev('w01', ok(80))
    const noGain = await ev('w01', ok(79.9))
    const wrong = await ev('w01', bad('incorrect'))
    expect(await post('w01', g.cand_id, 'Gain lesson one.')).toMatchObject({ pushed: true })
    expect(await post('w01', g.cand_id, 'Gain lesson two.')).toMatchObject({ pushed: false })
    expect(await post('w01', noGain.cand_id, 'No gain here.')).toMatchObject({ pushed: false })
    expect(await post('w01', wrong.cand_id, 'This broke correctness on my candidate.')).toMatchObject({ pushed: false, header: `[w01 · ${wrong.cand_id} · incorrect]` })
    // the author never receives its own lesson
    expect((await ev('w01', ok(79.8))).pushed_lessons).toEqual([])
    // delivered with an incorrect result, and with a build_error
    const r2 = await ev('w02', bad('incorrect'))
    expect(r2.pushed_lessons.map((l: any) => l.lesson_id)).toEqual(['L0001'])
    expect(r2.pushed_lessons[0].header).toContain('verified gain')
    const r3 = await ev('w03', bad('build_error'))
    expect(r3.pushed_lessons).toHaveLength(1)
    // only once per writer
    expect((await ev('w02', ok(95))).pushed_lessons).toEqual([])
    expect(events(run, 'lesson_delivered')).toHaveLength(2)
  })
  it('delivers at most push.max_per_delivery per result, in order, and carries the rest over', async () => {
    const { ev, call } = await jsonRun({}, { overrides: { push: { max_per_delivery: 2 } } })
    let m = 90
    for (let i = 0; i < 5; i++) {
      const r = await ev('w01', ok((m *= 0.9)))
      await call('post_lesson', { writer_id: 'w01', cand_id: r.cand_id, text: `Step ${i} helped.` })
    }
    const ids = async () => (await ev('w02', ok(99 - tagN / 1000))).pushed_lessons.map((l: any) => l.lesson_id)
    expect(await ids()).toEqual(['L0001', 'L0002'])
    expect(await ids()).toEqual(['L0003', 'L0004'])
    expect(await ids()).toEqual(['L0005'])
    expect(await ids()).toEqual([])
  })
  it('policy all pushes everything, policy none pushes nothing', async () => {
    const all = await jsonRun({}, { overrides: { push: { policy: 'all' } } })
    const w = await all.ev('w01', bad('incorrect'))
    expect(await all.call('post_lesson', { writer_id: 'w01', cand_id: w.cand_id, text: 'Negative finding.' })).toMatchObject({ pushed: true })
    expect((await all.ev('w02', ok(99))).pushed_lessons).toHaveLength(1)
    const none = await jsonRun({}, { mode: 'lessonshare-pull' })
    const g = await none.ev('w01', ok(50))
    expect(await none.call('post_lesson', { writer_id: 'w01', cand_id: g.cand_id, text: 'Big gain.' })).toMatchObject({ pushed: false })
    expect((await none.ev('w02', ok(99))).pushed_lessons).toEqual([])
    expect((await none.call('read_lessons', { writer_id: 'w02' })).lessons).toHaveLength(1)
  })
})

describe('read_lessons', () => {
  it('pages by cursor, skips own lessons, flags delivered ones', async () => {
    const { ev, call } = await jsonRun()
    const a = await ev('w01', ok(90))
    const b = await ev('w02', ok(91))
    for (let i = 0; i < 3; i++) {
      const c = i === 0 ? a : await ev('w01', ok(89 - i))
      await call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: `w01 note ${i}` })
      await call('post_lesson', { writer_id: 'w02', cand_id: b.cand_id, text: `w02 note ${i}` }) // third one rejected (max per candidate)
    }
    const p1 = await call('read_lessons', { writer_id: 'w03', limit: 2 })
    expect(p1.lessons.map((l: any) => l.seq)).toEqual([1, 2])
    expect(p1).toMatchObject({ next_cursor: 2, remaining: 3 })
    const p2 = await call('read_lessons', { writer_id: 'w03', cursor: p1.next_cursor, limit: 20 })
    expect(p2.lessons.map((l: any) => l.seq)).toEqual([3, 4, 5])
    expect(p2.remaining).toBe(0)
    expect((await call('read_lessons', { writer_id: 'w03', cursor: p2.next_cursor })).lessons).toEqual([])
    const own = await call('read_lessons', { writer_id: 'w01' })
    expect(own.lessons.every((l: any) => l.text.startsWith('w02'))).toBe(true)
    await ev('w03', ok(99)) // receives pushed lessons
    const again = await call('read_lessons', { writer_id: 'w03', limit: 20 })
    expect(again.lessons.some((l: any) => l.already_delivered)).toBe(true)
  })
  it('read.require_own_correct locks the board until the reader has an ok candidate', async () => {
    const { ev, call } = await jsonRun({}, { overrides: { read: { require_own_correct: true } } })
    expect((await call('read_lessons', { writer_id: 'w01' })).error).toBe('locked')
    await ev('w01', bad('incorrect'))
    expect((await call('read_lessons', { writer_id: 'w01' })).error).toBe('locked')
    await ev('w01', ok(99.9))
    expect((await call('read_lessons', { writer_id: 'w01' })).lessons).toEqual([])
  })
})

describe('budget and sessions', () => {
  it('closes at the time budget; closed runs reject new work but still answer reads', async () => {
    const { ev, call, clock } = await jsonRun({}, { budget: { minutes: 30 } })
    const r = await ev('w01', ok(90))
    expect(r.budget).toMatchObject({ run_state: 'open', minutes_left: 30 })
    clock.advance(31)
    expect((await ev('w01', ok(80))).error).toBe('run_closed')
    expect((await call('post_lesson', { writer_id: 'w01', cand_id: r.cand_id, text: 'late' })).error).toBe('run_closed')
    expect((await call('join', { writer_id: 'w02', session: 1 })).error).toBe('run_closed')
    expect((await call('read_lessons', { writer_id: 'w01' })).lessons).toEqual([])
    expect((await call('get_result', { writer_id: 'w01', cand_id: r.cand_id })).metric).toBe(90)
    expect(await call('status', {})).toMatchObject({ closed_reason: 'time', budget: { run_state: 'closed' } })
  })
  it('the evaluation cap counts only ok and incorrect and is never exceeded; queued evaluations still finish after closing', async () => {
    const t = await jsonRun({}, { budget: { evals: 2 } })
    expect((await t.ev('w01', bad('build_error'))).budget.evals_left).toBe(2) // not counted
    expect((await t.ev('w01', ok(90))).budget).toMatchObject({ evals_left: 1, run_state: 'open' })
    expect((await t.ev('w02', bad('incorrect'))).budget).toMatchObject({ evals_left: 0, run_state: 'closed' })
    expect((await t.call('status', {})).closed_reason).toBe('evals')
    expect((await t.ev('w02', ok(60))).error).toBe('run_closed')

    // in-flight evaluations reserve budget: a third submission waits, then is told the run closed
    const gate = new Deferred<void>()
    const u = await jsonRun({ eval: { block_s: 0.2 } }, { budget: { evals: 2 } })
    u.ctl.gate = gate.promise
    const a = await u.ev('w01', ok(90))
    const b = await u.ev('w02', ok(80))
    expect([a.status, b.status]).toEqual(['running', 'running'])
    expect((await u.ev('w03', ok(70))).error).toBe('budget_reserved')
    const third = u.ev('w03', ok(70))
    gate.resolve()
    expect((await third).error).toBe('run_closed')
    // both queued evaluations still completed after the close
    expect((await u.call('get_result', { writer_id: 'w02', cand_id: b.cand_id, wait_s: 5 })).status).toBe('ok')
    expect((await u.call('status', {})).evals.counted).toBe(2)

    // time-based close: an evaluation queued before the deadline still returns its result
    const g2 = new Deferred<void>()
    const v = await jsonRun({ eval: { block_s: 0 } }, { budget: { minutes: 10 } })
    v.ctl.gate = g2.promise
    const q = await v.ev('w01', ok(55))
    v.clock.advance(11)
    v.host.tick()
    expect((await v.call('status', {})).closed_reason).toBe('time')
    g2.resolve()
    expect(await v.call('get_result', { writer_id: 'w01', cand_id: q.cand_id, wait_s: 5 })).toMatchObject({ status: 'ok', metric: 55 })
  })
  it('stops on target by default when a target is set', async () => {
    const { ev, call } = await jsonRun({ metric: { target: 50 } })
    expect((await ev('w01', ok(60))).reached_target).toBe(false)
    const r = await ev('w01', ok(50))
    expect(r).toMatchObject({ reached_target: true, budget: { run_state: 'closed' } })
    expect((await call('status', {})).closed_reason).toBe('target')
    const keep = await jsonRun({ metric: { target: 50 } }, { overrides: { stop: { on_target: false } } })
    expect((await keep.ev('w01', ok(40))).budget.run_state).toBe('open')
  })
  it('session quota: must_hand_off, three grace evaluations, then hand_off_required; join is idempotent', async () => {
    const { ev, call, run } = await jsonRun({}, { overrides: { session: { eval_quota: 2 } } })
    expect((await ev('w01', ok(99))).session).toMatchObject({ evals_used: 1, must_hand_off: false })
    await ev('w01', bad('build_error')) // not counted
    expect((await ev('w01', ok(98))).session).toMatchObject({ evals_used: 2, must_hand_off: true })
    for (let i = 0; i < 3; i++) expect((await ev('w01', ok(97 - i))).status).toBe('ok')
    expect((await ev('w01', ok(90))).error).toBe('hand_off_required')
    // replayed session 0 sees its usage and is exhausted
    const j0 = await call('join', { writer_id: 'w01', session: 0 })
    expect(j0.session).toMatchObject({ index: 0, evals_used: 5, exhausted: true })
    const j1 = await call('join', { writer_id: 'w01', session: 1 })
    expect(j1.session).toMatchObject({ index: 1, evals_used: 0, exhausted: false })
    expect(j1.own_best.metric).toBe(95)
    expect((await ev('w01', ok(90))).session).toMatchObject({ index: 1, evals_used: 1 })
    const before = events(run, 'join').length
    await call('join', { writer_id: 'w01', session: 1 })
    expect(events(run, 'join')).toHaveLength(before)
    // a session that ended early is exhausted once a later one exists
    await call('join', { writer_id: 'w02', session: 1 })
    expect((await call('join', { writer_id: 'w02', session: 0 })).session.exhausted).toBe(true)
  })
  it('resume_run_id reopens a closed run and reports the next session base', async () => {
    const { ev, call, clock, host, run } = await jsonRun({}, { budget: { minutes: 10 } })
    await ev('w01', ok(90))
    clock.advance(11)
    expect((await ev('w01', ok(80))).error).toBe('run_closed')
    const re = await host.call('init_run', { resume_run_id: run.run_id, budget: { minutes: 20 } })
    expect(re).toMatchObject({ run_id: run.run_id, resumed: true, session_base: 1 })
    expect(events(run, 'run_reopened')).toHaveLength(1)
    await call('join', { writer_id: 'w01', session: 1 })
    expect(await ev('w01', ok(80))).toMatchObject({ status: 'ok', budget: { run_state: 'open', minutes_left: 20 } })
  })
  it('init_run warnings cover small N, tight evaluation caps and noise', async () => {
    const { run } = await jsonRun({}, { n: 3, budget: { evals: 10, minutes: 20 } })
    const w = run.warnings.join('\n')
    expect(w).toMatch(/below 8/)
    expect(w).toMatch(/N x 20/)
    expect(w).toMatch(/short/)
    let i = 0
    const noisy = mkJsonProject()
    const host = new Host({ projectDir: noisy, clock: new FakeClock(), evalFactory: () => async () => ({ status: 'ok', metric: [100, 103, 98][i++ % 3], detail: '', eval_s: 0, log: '' }) })
    const r = await host.call('init_run', { n: 8 })
    expect(r.baseline).toMatchObject({ metric: 100, noise: 0.05 })
    expect(r.warnings.join('\n')).toMatch(/noise.*Suggested min_gain: 0\.1/i)
  })
})

describe('recovery', () => {
  it('rebuilds bests, cursors and counters from the event log and re-queues unfinished evaluations', async () => {
    const gate = new Deferred<void>()
    const t = await jsonRun({ eval: { block_s: 0, max_pending: 3 } }, { budget: { evals: 50 } })
    const fin = async (w: string, body: unknown) => {
      const r = await t.ev(w, body)
      return r.status === 'running' ? t.call('get_result', { writer_id: w, cand_id: r.cand_id, wait_s: 5 }) : r
    }
    const a = await fin('w01', ok(80))
    await t.call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: 'Eighty.' })
    const d = await fin('w02', ok(95)) // delivery to w02
    expect(d.pushed_lessons).toHaveLength(1)
    t.ctl.gate = gate.promise
    const pend = await t.ev('w03', ok(60)) // submitted, never finished by this server
    expect(pend.status).toBe('running')
    const before = await t.call('status', {})

    // "crash": a new host on the same project, with no memory
    fs.rmSync(path.join(t.run.run_dir, 'server.lock'))
    const { ctl: ctl2, factory } = jsonEval()
    const host2 = new Host({ projectDir: t.dir, clock: t.clock, evalFactory: factory })
    const done = await host2.call('get_result', { run_id: t.run.run_id, writer_id: 'w03', cand_id: pend.cand_id, wait_s: 5 })
    expect(done).toMatchObject({ status: 'ok', metric: 60 })
    expect(ctl2.order).toEqual([pend.cand_id])
    expect(done.pushed_lessons.map((l: any) => l.lesson_id)).toEqual(['L0001']) // w03 had not received it
    const after = await host2.call('status', { run_id: t.run.run_id })
    expect(after.writers.find((w: any) => w.writer_id === 'w01').best).toEqual(before.writers.find((w: any) => w.writer_id === 'w01').best)
    expect(after.evals.counted).toBe(before.evals.counted + 1)
    expect(after.lessons).toEqual(before.lessons)
    // w02 already got the lesson before the crash: not delivered twice
    setJson(t.run, 'w02', ok(94))
    const again = await host2.call('evaluate', { run_id: t.run.run_id, writer_id: 'w02' })
    expect(again.pushed_lessons).toEqual([])
    expect(again.cand_id).toBe('c0004') // candidate numbering continues
    gate.resolve()
  })
  it('a second live process cannot take over a run', async () => {
    const t = await jsonRun()
    const lock = path.join(t.run.run_dir, 'server.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid }))
    const host2 = new Host({ projectDir: t.dir, clock: t.clock, evalFactory: t.factory })
    expect((await host2.call('status', { run_id: t.run.run_id })).error).toBe('run_locked')
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 })) // dead pid
    expect((await host2.call('status', { run_id: t.run.run_id })).run_id).toBe(t.run.run_id)
  })
})

describe('confirm', () => {
  it('a candidate with one non-ok replay cannot win; the confirmed metric is the replay median', async () => {
    const { ev, call, ctl, run } = await jsonRun()
    const best = await ev('w01', ok(50))
    const second = await ev('w02', ok(60))
    await ev('w03', ok(70))
    ctl.script[best.cand_id] = [{}, { status: 'incorrect' }]
    ctl.script[second.cand_id] = [{ metric: 61 }, { metric: 59 }, { metric: 60.5 }]
    const rep = await call('confirm', {})
    expect(rep.winner).toMatchObject({ cand_id: second.cand_id, writer_id: 'w02', metric: 60, confirmed_metric: 60.5, replays: [61, 59, 60.5] })
    expect(rep.winner.improvement).toBeCloseTo(0.395)
    expect(rep.closed_reason).toBe('confirm')
    expect(readJson(path.join(run.run_dir, 'winner', 'c.json')).metric).toBe(60)
    expect(fs.existsSync(path.join(run.run_dir, 'report.md'))).toBe(true)
    expect(events(run, 'confirm_replay').filter((e) => e.cand_id === best.cand_id)).toHaveLength(2)
    expect(await call('confirm', {})).toEqual(rep) // idempotent
  })
  it('no correct candidate: winner is null with a warning', async () => {
    const { ev, call } = await jsonRun()
    await ev('w01', bad('incorrect'))
    const rep = await call('confirm', {})
    expect(rep.winner).toBeNull()
    expect(rep.warnings.join(' ')).toMatch(/no winner/)
  })
})

describe('modes', () => {
  it('independent: board tools are disabled and results carry no pushes', async () => {
    const { ev, call } = await jsonRun({}, { mode: 'independent' })
    const r = await ev('w01', ok(50))
    expect('pushed_lessons' in r).toBe(false)
    expect(r.hint ?? '').not.toMatch(/Post a lesson/)
    expect((await call('post_lesson', { writer_id: 'w01', cand_id: r.cand_id, text: 'hi' })).error).toBe('board_disabled')
    expect((await call('read_lessons', { writer_id: 'w02' })).error).toBe('board_disabled')
    expect((await call('join', { writer_id: 'w01', session: 0 })).mode).toBe('independent')
  })
  it('workspace: every evaluated candidate is copied to shared/ with an index line', async () => {
    const { ev, call, run } = await jsonRun({}, { mode: 'workspace' })
    const r = await ev('w01', ok(50))
    const j = await call('join', { writer_id: 'w02', session: 0 })
    expect(j.shared_dir).toBe(path.join(run.run_dir, 'shared'))
    expect(j.mode_instructions).toMatch(/shared_dir/)
    expect(readJson(path.join(j.shared_dir, 'w01', r.cand_id, 'c.json')).metric).toBe(50)
    expect(fs.readFileSync(path.join(j.shared_dir, 'index.tsv'), 'utf8')).toMatch(new RegExp(`^w01\\t${r.cand_id}\\t[\\d.]+\\tok\\t50\\n$`))
    expect((await call('post_lesson', { writer_id: 'w01', cand_id: r.cand_id, text: 'hi' })).error).toBe('board_disabled')
  })
})

describe('paths and identity', () => {
  it('rejects task paths, seeds and candidate files that escape the project', async () => {
    const dir = mkJsonProject()
    const host = new Host({ projectDir: dir, evalFactory: jsonEval().factory })
    expect((await host.call('init_run', { task_path: '../outside.json' })).error).toBe('path_escape')
    expect((await host.call('init_run', { task_path: '/etc/hostname' })).error).toBe('path_escape')
    const write = (t: unknown) => fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify(t))
    const base = { name: 'x', goal: 'g', eval: { command: ['true'] }, metric: { name: 'm', direction: 'min' } }
    write({ ...base, candidate: { seed: '../..' } })
    expect((await host.call('init_run', {})).error).toBe('path_escape')
    write({ ...base, candidate: { seed: 'seed', files: ['../other/*.json'] } })
    expect((await host.call('init_run', {})).error).toBe('path_escape')
    write({ ...base, candidate: { seed: 'seed' }, eval: { command: ['true'], cwd: '/tmp' } })
    expect((await host.call('init_run', {})).error).toBe('path_escape')
    fs.symlinkSync('/etc', path.join(dir, 'link'))
    write({ ...base, candidate: { seed: 'link' } })
    expect((await host.call('init_run', {})).error).toBe('path_escape')
  })
  it('an agent registered as one writer cannot act as another; writers only get their own status', async () => {
    const { call, ev, run } = await jsonRun()
    await call('join', { writer_id: 'w01', session: 0, _harness_agent_id: 'agentA', _harness_agent_type: 'lessonshare:writer' })
    const map = readJson(path.join(run.run_dir, 'agents', 'agentA.json'))
    expect(map).toMatchObject({ writer_id: 'w01', run_id: run.run_id, mode: 'lessonshare' })
    setJson(run, 'w02', ok(50))
    expect((await call('evaluate', { writer_id: 'w02', _harness_agent_id: 'agentA' })).error).toBe('identity_mismatch')
    expect((await call('join', { writer_id: 'w02', session: 0, _harness_agent_id: 'agentA' })).error).toBe('identity_mismatch')
    await ev('w02', ok(40))
    const st = await call('status', { _harness_agent_id: 'agentA' })
    expect(st.writer_id).toBe('w01')
    expect(st.team_best).toBeUndefined()
    expect((await call('confirm', { _harness_agent_id: 'agentA' })).error).toBe('forbidden')
    // sessions joined without a stamp are recorded once each
    expect(events(run, 'stamp_missing')).toHaveLength(3)
    expect((await call('status', {})).team_best.metric).toBe(40)
  })
})

describe('toy task end to end (real evaluator)', () => {
  it('seed, techniques, incorrect and build_error behave as designed', async () => {
    const dir = mkToyProject()
    const host = new Host({ projectDir: dir })
    const run = await host.call('init_run', { n: 2, budget: { minutes: 5 } })
    expect(run.baseline).toMatchObject({ status: 'ok', metric: 30768, noise: 0 })
    const call = (tool: string, a: Record<string, unknown>) => host.call(tool, { run_id: run.run_id, ...a })
    const j = await call('join', { writer_id: 'w01', session: 0 })
    expect(j.goal).toMatch(/Minimize/)
    expect(j.context_files).toEqual([path.join(run.run_dir, 'writers', 'w01', 'context', 'toy', 'API.md')])
    expect(fs.readFileSync(j.context_files[0], 'utf8')).toMatch(/catalog report/)
    const go = async (flags: Record<string, unknown>) => {
      setSolution(run, 'w01', flags)
      return call('evaluate', { writer_id: 'w01', note: JSON.stringify(flags) })
    }
    expect(await go({ memo: 1 })).toMatchObject({ status: 'ok', metric: 14928, verified_gain: true })
    expect((await go({ memo: 1, wrong: 1 })).status).toBe('incorrect')
    expect((await go({ broken: 1 })).status).toBe('build_error')
    const last = await go({ memo: 1, sort: 1, bsearch: 1, batch: 1 })
    expect(last).toMatchObject({ status: 'ok', metric: 3879, reached_target: true, budget: { run_state: 'closed' } })
    const rep = await call('confirm', {})
    expect(rep.winner).toMatchObject({ cand_id: last.cand_id, confirmed_metric: 3879, reached_target: true })
    expect(rep.team.evals).toEqual({ ok: 2, incorrect: 1, build_error: 1, infra_error: 0 })
    host.releaseLocks()
  }, 20000)
})
