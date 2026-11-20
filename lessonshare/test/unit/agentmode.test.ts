import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Host } from '../../src/core/host'
import { copiesFromWork, verdictHeader } from '../../src/core/lesson'
import { readJson } from '../../src/core/util'
import { FakeClock, ROOT, events } from '../helpers'

/** A project with an open task: no evaluation command, no seed. */
async function openRun(init: Record<string, unknown> = {}, task: Record<string, unknown> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-open-')))
  fs.mkdirSync(path.join(dir, '.lessonshare'))
  fs.writeFileSync(path.join(dir, 'problem.md'), 'the problem')
  fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify({ name: 'open', goal: 'Find the longest chain.', criteria: 'Valid first, then longer.', context_files: ['problem.md'], candidate: { files: ['answer.md'] }, ...task }))
  const clock = new FakeClock()
  const host = new Host({ projectDir: dir, clock, evalFactory: () => async () => { throw new Error('no evaluator must ever run') } })
  const run = await host.call('init_run', { n: 3, ...init })
  if (run.error) throw new Error(JSON.stringify(run))
  const call = (tool: string, a: Record<string, unknown> = {}) => host.call(tool, { run_id: run.run_id, ...a })
  for (const w of run.writers) await call('join', { writer_id: w, session: 0 })
  const answer = (w: string, text: string) => fs.writeFileSync(path.join(run.run_dir, 'writers', w, 'work', 'answer.md'), text)
  const checkpoint = async (w: string, text: string) => {
    answer(w, text)
    return call('evaluate', { writer_id: w, note: 'progress' })
  }
  return { dir, clock, host, run, call, checkpoint, answer }
}
const V = { _harness_agent_id: 'ver1', _harness_agent_type: 'lessonshare:verifier' }

describe('copy check (a lesson must not paste the result)', () => {
  const work = ['LENGTH: 12\nSEQUENCE: 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6\nWhy: every neighbour pair divides. Primes above 24 have no partner except 1, so at most one of them fits.']
  it('flags long verbatim spans, ignoring whitespace differences', () => {
    expect(copiesFromWork('My sequence is 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6 and every neighbour pair divides. Primes above 24 work badly.', work, 40)).toBe(true)
    expect(copiesFromWork('My sequence is 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6 and it works.', work, 80)).toBe(false) // shorter than the threshold
    expect(copiesFromWork('SEQUENCE:   5, 10, 20,\n40, 8, 16, 32, 4, 12, 24, 48, 6 Why: every neighbour pair divides. Primes above 24 have no partner', work, 80)).toBe(true)
  })
  it('passes prose that restates the insight', () => {
    expect(copiesFromWork('A prime larger than half the range only divides itself, so it can sit next to 1 alone; at most two such primes fit, at the two ends around 1. Checked by listing the multiples of each prime above 24.', work, 80)).toBe(false)
    expect(copiesFromWork('short', work, 80)).toBe(false)
    expect(copiesFromWork(work[0], work, 0)).toBe(false) // 0 disables
  })
  it('verdict headers', () => {
    expect(verdictHeader('w03', 'c0007', 'pending', '')).toBe('[w03 · c0007 · pending verification]')
    expect(verdictHeader('w03', 'c0007', 'verified', 'recomputed all pairs')).toBe('[w03 · c0007 · verified by verifier: recomputed all pairs]')
  })
})

describe('runs without an evaluator (verify.kind = agent)', () => {
  it('init needs no evaluator or seed; join explains the mode; evaluate records checkpoints', async () => {
    const { run, call, checkpoint } = await openRun()
    expect(run).toMatchObject({ verify_kind: 'agent', baseline: { status: 'none', metric: null } })
    expect(run.config.verify.kind).toBe('agent')
    const j = await call('join', { writer_id: 'w01', session: 0 })
    expect(j).toMatchObject({ verify_kind: 'agent', criteria: 'Valid first, then longer.', own_best: null })
    expect(j.how_this_run_works).toMatch(/no automatic evaluator/)
    expect(fs.readdirSync(j.work_dir)).toEqual([])
    expect(fs.readFileSync(j.context_files[0], 'utf8')).toBe('the problem')
    expect((await call('evaluate', { writer_id: 'w01' })).error).toBe('empty_candidate')
    const r = await checkpoint('w01', 'LENGTH: 3\nSEQUENCE: 1, 2, 4')
    expect(r).toMatchObject({ cand_id: 'c0001', status: 'recorded', metric: null, verified_gain: false, pushed_lessons: [], session: { evals_used: 1 } })
    expect((await checkpoint('w01', 'LENGTH: 3\nSEQUENCE: 1, 2, 4')).duplicate_of).toBe('c0001')
    expect(fs.readFileSync(path.join(run.run_dir, 'candidates', 'c0001', 'src', 'answer.md'), 'utf8')).toMatch(/1, 2, 4/)
  })
  it('a task with neither evaluator nor verify.kind defaults to agent; command mode still requires a seed', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-open-')))
    fs.mkdirSync(path.join(dir, '.lessonshare'))
    fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify({ name: 'x', goal: 'g', eval: { command: ['true'] }, metric: { name: 'm', direction: 'min' } }))
    expect(await new Host({ projectDir: dir }).call('init_run', {})).toMatchObject({ error: 'invalid_task', message: expect.stringMatching(/candidate.seed is required/) })
    fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify({ name: 'x', goal: 'g', metric: { target: 3 } }))
    expect((await new Host({ projectDir: dir }).call('init_run', {})).message).toMatch(/metric.target needs an evaluation command/)
    fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify({ name: 'x', goal: 'g' }))
    const r = await new Host({ projectDir: dir, clock: new FakeClock() }).call('init_run', { n: 2 })
    expect(r.verify_kind).toBe('agent')
    expect(r.warnings.join(' ')).toMatch(/No criteria given/)
  })
  it('lessons stay invisible until the verifier decides; only verified ones are pushed', async () => {
    const { run, call, checkpoint } = await openRun()
    const a = await checkpoint('w01', 'LENGTH: 4\nSEQUENCE: 1, 2, 4, 8')
    const post = (text: string, w = 'w01', cand = a.cand_id) => call('post_lesson', { writer_id: w, cand_id: cand, text })
    const l1 = await post('Powers of two chain freely with each other, so they make a good backbone. Checked on my four-term chain.')
    expect(l1).toMatchObject({ lesson_id: 'L0001', pushed: false, status: 'pending_verification', header: '[w01 · c0001 · pending verification]' })
    const l2 = await post('Primes above half the range only fit next to 1. Untested beyond 29.')
    // nothing visible yet, by pull or by push
    expect((await call('read_lessons', { writer_id: 'w02' })).lessons).toEqual([])
    expect((await checkpoint('w02', 'LENGTH: 2\nSEQUENCE: 3, 6')).pushed_lessons).toEqual([])
    expect((await call('join', { writer_id: 'w02', session: 0 })).lessons_unread).toBe(0)

    // verifier takes the oldest pending lesson
    const n1 = await call('next_lesson', { session: 0, ...V })
    expect(n1.lesson).toMatchObject({ lesson_id: 'L0001', writer_id: 'w01', cand_id: 'c0001' })
    expect(n1).toMatchObject({ goal: 'Find the longest chain.', criteria: 'Valid first, then longer.', pending: 2, author_checkpoint_dir: path.join(run.run_dir, 'candidates', 'c0001', 'src') })
    expect(readJson(path.join(run.run_dir, 'agents', 'ver1.json'))).toMatchObject({ role: 'verifier', scratch_dir: path.join(run.run_dir, 'verifier') })
    const n2 = await call('next_lesson', { session: 0, ...V })
    expect(n2.lesson.lesson_id).toBe('L0002') // L0001 is assigned, not handed out twice
    expect(await call('verdict', { lesson_id: 'L0002', verdict: 'unverified', note: 'Plausible; the checkpoint contains no prime above 24 to check it on.', ...V })).toMatchObject({ verdict: 'unverified', pushed: false, pending: 1 })
    expect(await call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: 'Checked all three neighbour pairs in the checkpoint.', ...V })).toMatchObject({ verdict: 'verified', pushed: true, pending: 0 })
    expect((await call('verdict', { lesson_id: 'L0001', verdict: 'refuted', note: 'again', ...V })).error).toBe('already_decided')

    // board order is verdict order; the verified one is pushed with the verifier's header, once, never to its author
    const board = await call('read_lessons', { writer_id: 'w03' })
    expect(board.lessons.map((l: any) => [l.lesson_id, l.seq, l.pushed])).toEqual([['L0002', 1, false], ['L0001', 2, true]])
    expect(board.lessons[0].header).toBe('[w01 · c0001 · not verified: Plausible; the checkpoint contains no prime above 24 to check it on.]')
    const got = await checkpoint('w02', 'LENGTH: 3\nSEQUENCE: 3, 6, 12')
    expect(got.pushed_lessons).toEqual([{ lesson_id: 'L0001', header: '[w01 · c0001 · verified by verifier: Checked all three neighbour pairs in the checkpoint.]', text: expect.stringMatching(/^Powers of two/) }])
    expect((await checkpoint('w02', 'LENGTH: 4\nSEQUENCE: 3, 6, 12, 24')).pushed_lessons).toEqual([])
    expect((await checkpoint('w01', 'LENGTH: 5\nSEQUENCE: 1, 2, 4, 8, 16')).pushed_lessons).toEqual([])
    void l2
  })
  it('withheld lessons never reach the board; refuted ones do, labelled; policy none pushes nothing', async () => {
    const { call, checkpoint } = await openRun()
    const a = await checkpoint('w01', 'LENGTH: 4\nSEQUENCE: 1, 2, 4, 8')
    for (const t of ['Take 1, 2, 4, 8.', 'Odd numbers can never be used at all.']) await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: t })
    await call('next_lesson', { session: 0, ...V })
    await call('verdict', { lesson_id: 'L0001', verdict: 'withheld', note: 'States the answer itself, not an insight.', ...V })
    await call('verdict', { lesson_id: 'L0002', verdict: 'refuted', note: 'False: 3, 6 is a valid pair containing an odd number.', ...V })
    const board = await call('read_lessons', { writer_id: 'w02' })
    expect(board.lessons.map((l: any) => l.lesson_id)).toEqual(['L0002'])
    expect(board.lessons[0].header).toMatch(/refuted by verifier: False/)
    expect((await checkpoint('w02', 'x')).pushed_lessons).toEqual([])
    const pull = await openRun({ mode: 'lessonshare-pull' })
    const b = await pull.checkpoint('w01', 'LENGTH: 1\nSEQUENCE: 7')
    await pull.call('post_lesson', { writer_id: 'w01', cand_id: b.cand_id, text: 'Seven alone is valid.' })
    expect(await pull.call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: 'Trivially valid.', ...V })).toMatchObject({ pushed: false })
    expect((await pull.call('read_lessons', { writer_id: 'w02' })).lessons).toHaveLength(1)
  })
  it('post_lesson rejects text copied from the author\'s own result, in both verification kinds', async () => {
    const { call, checkpoint } = await openRun()
    const body = 'LENGTH: 12\nSEQUENCE: 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6\nWhy: every neighbour pair divides, and the primes above 24 have no partner except 1.'
    const a = await checkpoint('w01', body)
    const r = await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: 'Best so far: SEQUENCE: 5, 10, 20, 40, 8, 16, 32, 4, 12, 24, 48, 6 Why: every neighbour pair divides, and the primes above 24 fail.' })
    expect(r).toMatchObject({ error: 'contains_solution', message: expect.stringMatching(/must not paste your own result/) })
    expect((await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: 'Chaining through small even numbers lets you revisit different prime families; my twelve-term chain switches from the fives to the threes through 4 and 12.' })).status).toBe('pending_verification')
    const off = await openRun({ overrides: { lesson: { max_copy_chars: 0 } } })
    const b = await off.checkpoint('w01', body)
    expect((await off.call('post_lesson', { writer_id: 'w01', cand_id: b.cand_id, text: body })).status).toBe('pending_verification')
  })
  it('verdict input rules, verifier quota and hand-off, writers cannot verify', async () => {
    const { call, checkpoint } = await openRun({ overrides: { verifier: { session_quota: 2, wait_s: 1 }, lesson: { max_per_candidate: 5 } } })
    const a = await checkpoint('w01', 'LENGTH: 1\nSEQUENCE: 1')
    for (let i = 0; i < 3; i++) await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: `Observation number ${i} about the chain.` })
    await call('join', { writer_id: 'w02', session: 0, _harness_agent_id: 'wr2', _harness_agent_type: 'lessonshare:writer' })
    expect((await call('next_lesson', { session: 0, _harness_agent_id: 'wr2' })).error).toBe('forbidden')
    expect((await call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: 'ok', _harness_agent_id: 'wr2' })).error).toBe('forbidden')
    await call('next_lesson', { session: 0, ...V })
    await expect(call('verdict', { lesson_id: 'L0001', verdict: 'great', note: 'x', ...V })).rejects.toThrow(/verdict must be one of/)
    expect((await call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: '', ...V })).error).toBe('note_required')
    expect((await call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: 'n'.repeat(301), ...V })).error).toBe('note_too_long')
    expect((await call('verdict', { lesson_id: 'L0009', verdict: 'verified', note: 'x', ...V })).error).toBe('unknown_lesson')
    await call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: 'checked', ...V })
    await call('verdict', { lesson_id: 'L0002', verdict: 'verified', note: 'checked', ...V })
    expect(await call('next_lesson', { session: 0, ...V })).toMatchObject({ must_hand_off: true, session: { verdicts: 2, quota: 2 } })
    const s1 = await call('next_lesson', { session: 1, ...V })
    expect(s1.lesson.lesson_id).toBe('L0003')
    expect((await call('next_lesson', { session: 0, ...V })).must_hand_off).toBe(true) // replayed old session
    await call('verdict', { lesson_id: 'L0003', verdict: 'unverified', note: 'not checkable', ...V })
    expect(await call('next_lesson', { session: 1, wait_s: 0.05, ...V })).toMatchObject({ none: true })
  })
  it('next_lesson wakes up for a new lesson and when the run closes', async () => {
    const { call, checkpoint, clock, host } = await openRun({ budget: { minutes: 10 } })
    const a = await checkpoint('w01', 'LENGTH: 1\nSEQUENCE: 1')
    const waiting = call('next_lesson', { session: 0, wait_s: 20, ...V })
    await new Promise((r) => setTimeout(r, 30))
    await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: 'One is a universal neighbour.' })
    expect((await waiting).lesson.lesson_id).toBe('L0001')
    await call('verdict', { lesson_id: 'L0001', verdict: 'verified', note: 'ok', ...V })
    const idle = call('next_lesson', { session: 0, wait_s: 20, ...V })
    await new Promise((r) => setTimeout(r, 30))
    clock.advance(11)
    host.tick()
    expect(await idle).toMatchObject({ run_closed: true })
    expect((await call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: 'late' })).error).toBe('run_closed')
  })
  it('recovery restores verdicts, board order and pending lessons', async () => {
    const t = await openRun()
    const a = await t.checkpoint('w01', 'LENGTH: 1\nSEQUENCE: 1')
    for (const x of ['First insight about hubs.', 'Second insight about primes.', 'Third insight about ends.']) await t.call('post_lesson', { writer_id: 'w01', cand_id: a.cand_id, text: x }).catch(() => {})
    await t.call('next_lesson', { session: 0, ...V })
    await t.call('verdict', { lesson_id: 'L0002', verdict: 'verified', note: 'ok', ...V })
    fs.rmSync(path.join(t.run.run_dir, 'server.lock'))
    const host2 = new Host({ projectDir: t.dir, clock: t.clock })
    const call2 = (tool: string, x: Record<string, unknown> = {}) => host2.call(tool, { run_id: t.run.run_id, ...x })
    expect((await call2('status')).lessons).toEqual({ posted: 2, pushed: 1, pending: 1 }) // the third exceeded max_per_candidate
    expect((await call2('read_lessons', { writer_id: 'w02' })).lessons.map((l: any) => [l.lesson_id, l.header])).toEqual([['L0002', '[w01 · c0001 · verified by verifier: ok]']])
    expect((await call2('next_lesson', { session: 0, ...V })).lesson.lesson_id).toBe('L0001')
  })
  it('confirm freezes every last checkpoint, asks a judge for a ranking and reports the judged winner', async () => {
    const { run, call, checkpoint, answer } = await openRun()
    await checkpoint('w01', 'LENGTH: 4\nSEQUENCE: 1, 2, 4, 8')
    answer('w01', 'LENGTH: 5\nSEQUENCE: 1, 2, 4, 8, 16') // edited after the last checkpoint: not part of the result
    answer('w02', 'LENGTH: 2\nSEQUENCE: 3, 6')
    const a = await call('post_lesson', { writer_id: 'w01', cand_id: 'c0001', text: 'Doubling keeps the chain valid.' })
    await call('verdict', { lesson_id: a.lesson_id, verdict: 'verified', note: 'ok', ...V })
    const ask = await call('confirm', { ...V })
    expect(ask).toMatchObject({ needs_ranking: true, goal: 'Find the longest chain.', criteria: 'Valid first, then longer.' })
    expect(ask.finals.map((f: any) => [f.writer_id, f.files])).toEqual([['w01', ['answer.md']], ['w02', ['answer.md']], ['w03', []]])
    expect(fs.readFileSync(path.join(ask.finals[0].final_dir, 'answer.md'), 'utf8')).toBe('LENGTH: 4\nSEQUENCE: 1, 2, 4, 8')
    expect(ask.finals.map((f: any) => f.source)).toEqual(['c0001', 'work_dir', 'work_dir']) // w02 never saved a checkpoint
    expect((await checkpoint('w03', 'late')).error).toBe('run_closed')
    await expect(call('confirm', { ranking: [{ writer_id: 'w09', score: 1 }], ...V })).rejects.toThrow(/unknown writer_id/)
    const rep = await call('confirm', { ranking: [{ writer_id: 'w02', score: 3, reason: 'valid but short' }, { writer_id: 'w01', score: 8, reason: 'valid, five terms' }, { writer_id: 'w03', score: 0, meets_bar: false, reason: 'empty' }], ...V })
    expect(rep.winner).toMatchObject({ writer_id: 'w01', judged: true, score: 8, reason: 'valid, five terms' })
    expect(rep.ranking.map((r: any) => r.writer_id)).toEqual(['w01', 'w02', 'w03'])
    expect(rep.diagnostics.verification).toMatchObject({ kind: 'agent', verdicts: { verified: 1 }, pending: 0 })
    expect(rep.team.evals.recorded).toBe(1)
    expect(rep.warnings.join(' ')).toMatch(/chosen by a judge agent/)
    expect(fs.readFileSync(path.join(run.run_dir, 'winner', 'answer.md'), 'utf8')).toMatch(/8$/)
    const md = fs.readFileSync(path.join(run.run_dir, 'report.md'), 'utf8')
    expect(md).toMatch(/Winner: w01\*\* · chosen by the judge agent, score 8\/10/)
    expect(md).toMatch(/Verifier verdicts: 1 verified/)
    expect(await call('confirm', {})).toEqual(rep)
    expect(events(run, 'final_snapshot')).toHaveLength(3)
  })
  it('the bundled open toy task is a valid agent-verified task', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-open-')))
    fs.cpSync(path.join(ROOT, 'examples', 'toy-open'), path.join(dir, 'toy-open'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.lessonshare'))
    fs.copyFileSync(path.join(ROOT, 'examples', 'toy-open', 'task.json'), path.join(dir, '.lessonshare', 'task.json'))
    const r = await new Host({ projectDir: dir, clock: new FakeClock() }).call('init_run', { n: 8, budget: { minutes: 60 } })
    expect(r).toMatchObject({ verify_kind: 'agent', warnings: [] })
  })
})

describe('team settings', () => {
  const L1 = 'Large primes only sit next to 1, so at most two of them fit, one on each side of 1. Checked by listing multiples.'
  it('defaults: isolated, verified push, verifier on; one long session without an evaluator', async () => {
    const { run } = await openRun()
    expect(run.settings).toMatchObject({ visibility: 'isolated', push: 'verified', verification: 'verifier agent', board: 'all', pull: true, session_checkpoints: 200 })
    expect(run.verifier).toBe(true)
  })
  it('rejects unknown settings and combinations that could never deliver', async () => {
    await expect(openRun({ settings: { colour: 'red' } })).rejects.toThrow(/unknown setting/)
    await expect(openRun({ settings: { verifier: false } })).rejects.toThrow(/verifier off/)
  })
  it('verifier off + push all: a lesson is visible and pushed at once, labelled not checked', async () => {
    const { run, call, checkpoint } = await openRun({ settings: { verifier: false, push: 'all' } })
    expect(run.verifier).toBe(false)
    const c = await checkpoint('w01', 'LENGTH: 3\nSEQUENCE: 1, 2, 4')
    const p = await call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L1 })
    expect(p).toMatchObject({ pushed: true })
    expect(p.header).toMatch(/not checked/)
    const r = await checkpoint('w02', 'LENGTH: 2\nSEQUENCE: 1, 3')
    expect(r.pushed_lessons.map((l: any) => l.lesson_id)).toEqual([p.lesson_id])
    expect((await call('next_lesson', { session: 0, wait_s: 0, ...V })).error).toBe('no_verifier')
  })
  it('push none: verified lessons stay on the board and are never delivered', async () => {
    const { call, checkpoint } = await openRun({ settings: { push: 'none' } })
    const c = await checkpoint('w01', 'LENGTH: 3\nSEQUENCE: 1, 2, 4')
    const p = await call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L1 })
    await call('next_lesson', { session: 0, wait_s: 0, ...V })
    expect(await call('verdict', { lesson_id: p.lesson_id, verdict: 'verified', note: 'checked', ...V })).toMatchObject({ pushed: false })
    expect((await checkpoint('w02', 'LENGTH: 2\nSEQUENCE: 1, 3')).pushed_lessons).toEqual([])
    expect((await call('read_lessons', { writer_id: 'w02' })).lessons).toHaveLength(1)
  })
  it('board verified hides unverified lessons; pull false turns read_lessons off', async () => {
    const a = await openRun({ settings: { board: 'verified' } })
    const c = await a.checkpoint('w01', 'LENGTH: 3\nSEQUENCE: 1, 2, 4')
    const p = await a.call('post_lesson', { writer_id: 'w01', cand_id: c.cand_id, text: L1 })
    await a.call('next_lesson', { session: 0, wait_s: 0, ...V })
    await a.call('verdict', { lesson_id: p.lesson_id, verdict: 'unverified', note: 'could not confirm', ...V })
    expect((await a.call('read_lessons', { writer_id: 'w02' })).lessons).toEqual([])
    const b = await openRun({ settings: { pull: false } })
    expect((await b.call('read_lessons', { writer_id: 'w02' })).error).toBe('pull_disabled')
  })
  it('visibility shared: checkpoints are published to shared_dir while the board stays on', async () => {
    const { run, call, checkpoint } = await openRun({ settings: { visibility: 'shared' } })
    const c = await checkpoint('w01', 'LENGTH: 3\nSEQUENCE: 1, 2, 4')
    const j = await call('join', { writer_id: 'w02', session: 0 })
    expect(j.board_enabled).toBe(true)
    expect(fs.readFileSync(path.join(j.shared_dir, 'w01', c.cand_id, 'answer.md'), 'utf8')).toMatch(/1, 2, 4/)
    expect(j.shared_dir.startsWith(run.run_dir)).toBe(true)
  })
  it('.lessonshare/settings.json gives project defaults; launch settings win', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-set-')))
    fs.mkdirSync(path.join(dir, '.lessonshare'))
    fs.writeFileSync(path.join(dir, '.lessonshare', 'task.json'), JSON.stringify({ name: 'open', goal: 'g', candidate: { files: ['answer.md'] } }))
    fs.writeFileSync(path.join(dir, '.lessonshare', 'settings.json'), JSON.stringify({ push: 'all', lesson_chars: 500 }))
    const host = new Host({ projectDir: dir, clock: new FakeClock() })
    const r = await host.call('init_run', { n: 2, settings: { push: 'none' } })
    expect(r.settings).toMatchObject({ push: 'none', lesson_chars: 500 })
  })
})
