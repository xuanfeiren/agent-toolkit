import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'lessonshare',
  component: 'Pane',
  requestId: 'lesson-board',
  props: { title: 'Lesson board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const RUN = '/p/.lessonshare/runs/r-1'
const FILES: Record<string, string> = {
  [`${RUN}/run.json`]: JSON.stringify({ config: { name: 'chain', n: 3, shared: { enabled: false }, push: { policy: 'verified' }, verify: { kind: 'agent' }, verifier: { enabled: true }, board: { enabled: true, show: 'all', pull: true }, lesson: { max_chars: 2000 } } }),
  [`${RUN}/lessons.jsonl`]:
    JSON.stringify({ lesson_id: 'L0001', writer_id: 'w01', cand_id: 'c0001', minute: 1.2, verdict: 'pending', pushed: false, header: '[w01 · c0001 · pending verification]', text: 'Large primes only sit next to 1.' }) + '\n' +
    JSON.stringify({ lesson_id: 'L0002', writer_id: 'w02', cand_id: 'c0002', minute: 1.5, verdict: 'pending', pushed: false, header: '', text: 'Second idea, still waiting.' }) + '\n' +
    JSON.stringify({ lesson_id: 'L0003', writer_id: 'w01', cand_id: 'c0003', minute: 2.5, verdict: 'pending', pushed: false, header: '', corrects: 'L0001', text: 'Two such primes fit, not one.' }) + '\n',
  [`${RUN}/events.jsonl`]:
    JSON.stringify({ minute: 1.0, type: 'lesson_rejected', error: 'contains_solution' }) + '\n' +
    JSON.stringify({ minute: 1.6, type: 'lesson_verdict', lesson_id: 'L0001', verdict: 'verified', note: 'recounted the pairs', pushed: true }) + '\n' +
    JSON.stringify({ minute: 2.0, type: 'lesson_delivered', lesson_id: 'L0001', to: 'w02' }) + '\n' +
    JSON.stringify({ minute: 2.8, type: 'lesson_verdict', lesson_id: 'L0003', verdict: 'partly_verified', note: 'the count is right, the reason given is not', pushed: true }) + '\n',
}

function world(on: any) {
  on('command.register', () => ({ value: { command: 'lesson-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path === '/p/.lessonshare/runs' || e.path in FILES }))
  on('fs.list', () => ({ value: [{ name: 'r-1', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', (_: unknown, e: any) => ({ value: { kind: 'file', size: (FILES[e.path] ?? '').length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_: unknown, e: any) => ({ value: FILES[e.path] ?? '' }))
}

test('each lesson is one card with its verdict and where it went', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await clock.advance(3500)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /agents isolated/ }))?.text).toContain('push verified · checked by verifier')
    expect((await ui.find({ type: 'Text', text: /3 lessons/ }))?.text).toContain('1 rejected by the host (1 pasted the result)')
    expect((await ui.find({ type: 'Text', text: /3 lessons/ }))?.text).toContain('1 partly')
    expect(await ui.find({ type: 'Text', text: /partly verified, read the correction/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^corrects L0001$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /corrected by L0003/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /pushed →/ }))?.text).toContain('verified · pushed → w02')
    expect(await ui.find({ type: 'Text', text: /recounted the pairs/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Large primes only sit next to 1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /waiting for the verifier/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the filter button narrows the cards', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await clock.advance(3500)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'filter' })
  expect(await ui.find({ type: 'Text', text: /Second idea/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Large primes/ })).toBeTruthy()
  await ui.unmount()
})

test('with no run the pane says how to start one', async ($, on) => {
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No run in this project yet/ })).toBeTruthy()
  await ui.unmount()
})
