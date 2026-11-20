import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { hashDir, readJsonl } from '../../src/core/util'
import { ROOT, makeSolution, mkToyProject } from '../helpers'

const DIST = path.join(ROOT, 'dist')

describe('build', () => {
  it('dist/ is up to date with src/', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-dist-'))
    execFileSync('node', ['build.mjs'], { cwd: ROOT, env: { ...process.env, LS_OUTDIR: out } })
    for (const f of ['board.js', 'cli.js', 'hook-stamp.js', 'hook-guard.js']) expect(fs.readFileSync(path.join(out, f), 'utf8') === fs.readFileSync(path.join(DIST, f), 'utf8'), `${f} differs: run npm run build`).toBe(true)
  }, 60000)
})

describe('scripted fake writers against the real board.js over MCP', () => {
  let client: Client
  let dir: string
  let run: any
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args })
    return { ...JSON.parse(r.content[0].text), __isError: !!r.isError }
  }
  beforeAll(async () => {
    dir = mkToyProject()
    client = new Client({ name: 'test', version: '0' })
    await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(DIST, 'board.js')], env: { ...process.env, LESSONSHARE_PROJECT_DIR: dir } as Record<string, string>, stderr: 'ignore' }))
  }, 30000)
  afterAll(async () => {
    await client?.close()
  })

  it('lists the ten tools, each accepting the host stamp fields', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['confirm', 'evaluate', 'get_result', 'init_run', 'join', 'next_lesson', 'post_lesson', 'read_lessons', 'status', 'verdict'])
    for (const t of tools) expect(Object.keys((t.inputSchema as any).properties)).toEqual(expect.arrayContaining(['_harness_agent_id', '_harness_agent_type']))
  })

  it('invalid parameters are MCP errors; business refusals are normal results', async () => {
    expect(await call('status', {})).toMatchObject({ __isError: true, error: 'invalid_arguments' })
    expect(await call('status', { run_id: 'r-nope' })).toMatchObject({ __isError: false, error: 'unknown_run' })
  })

  it('runs a 4-writer team to confirmation and keeps the protocol invariants', async () => {
    const EVAL_CAP = 30
    run = await call('init_run', { n: 4, mode: 'lessonshare', budget: { minutes: 10, evals: EVAL_CAP }, overrides: { stop: { on_target: false }, session: { eval_quota: 6 } } })
    expect(run.baseline).toMatchObject({ status: 'ok', metric: 30768 })
    expect(run.writers).toEqual(['w01', 'w02', 'w03', 'w04'])
    // every writer walks its own order of techniques, with a wrong and a broken attempt in between
    const plans: Record<string, Array<Record<string, unknown>>> = {
      w01: [{ memo: 1 }, { memo: 1, sort: 1 }, { memo: 1, sort: 1, wrong: 1 }, { memo: 1, sort: 1, batch: 1 }, { memo: 1, sort: 1, batch: 1, bsearch: 1 }, { memo: 1, sort: 1, batch: 1, table: 1 }, { memo: 1, sort: 1, batch: 1, table: 1, dedupe: 1 }],
      w02: [{ bsearch: 1 }, { broken: 1 }, { bsearch: 1, memo: 1 }, { bsearch: 1 }, { table: 1, memo: 1 }, { table: 1, memo: 1, batch: 1 }, { table: 1, memo: 1, batch: 1, sort: 1 }, { table: 1, memo: 1, batch: 1, sort: 1, tag: 'x' }],
      w03: [{ batch: 1 }, { batch: 1, dedupe: 1 }, { batch: 1, dedupe: 1, memo: 1 }, { wrong: 1 }, { batch: 1, dedupe: 1, memo: 1, sort: 1 }, { batch: 1, dedupe: 1, memo: 1, sort: 1, bsearch: 1 }, { tag: 'a' }, { tag: 'b' }, { tag: 'c' }, { tag: 'd' }],
      w04: [{ sort: 1 }, { sort: 1, tag: 'same-cost' }, { sort: 1, table: 1 }, { sort: 1, table: 1, memo: 1 }, { sort: 1, table: 1, memo: 1, batch: 1 }, { sort: 1, table: 1, memo: 1, batch: 1, dedupe: 1 }, { tag: 'e' }, { tag: 'f' }, { tag: 'g' }],
    }
    const received: Record<string, string[]> = {}
    const writer = async (id: string) => {
      received[id] = []
      let session = 0
      let j = await call('join', { run_id: run.run_id, writer_id: id, session })
      expect(j.work_dir).toBe(path.join(run.run_dir, 'writers', id, 'work'))
      let cursor = 0
      for (const flags of plans[id]) {
        fs.writeFileSync(path.join(j.work_dir, 'solution.js'), makeSolution(flags))
        let r = await call('evaluate', { run_id: run.run_id, writer_id: id, note: Object.keys(flags).join('+') })
        if (r.error === 'hand_off_required') {
          j = await call('join', { run_id: run.run_id, writer_id: id, session: ++session })
          r = await call('evaluate', { run_id: run.run_id, writer_id: id, note: Object.keys(flags).join('+') })
        }
        if (r.error === 'run_closed') break
        while (r.status === 'running') r = await call('get_result', { run_id: run.run_id, writer_id: id, cand_id: r.cand_id, wait_s: 10 })
        expect(r.error, JSON.stringify(r)).toBeUndefined()
        for (const l of r.pushed_lessons ?? []) received[id].push(l.lesson_id)
        if (r.duplicate_of) continue
        if (r.verified_gain) {
          const p = await call('post_lesson', { run_id: run.run_id, writer_id: id, cand_id: r.cand_id, text: `Adding ${Object.keys(flags).pop()} moved api_cost from ${r.reference} to ${r.metric}. My candidate also uses: ${Object.keys(flags).join(', ')}.` })
          expect(p.pushed, JSON.stringify(p)).toBe(true)
        } else if (r.status === 'incorrect') {
          await call('post_lesson', { run_id: run.run_id, writer_id: id, cand_id: r.cand_id, text: `Shifting the first count broke correctness on my candidate (${Object.keys(flags).join(', ')}).` })
        }
        if (r.session?.must_hand_off) j = await call('join', { run_id: run.run_id, writer_id: id, session: ++session })
        const page = await call('read_lessons', { run_id: run.run_id, writer_id: id, cursor })
        if (!page.error) cursor = page.next_cursor
      }
    }
    await Promise.all(run.writers.map(writer))
    // a code-bearing lesson is refused by the server
    const st = await call('status', { run_id: run.run_id })
    const rep = await call('confirm', { run_id: run.run_id })
    expect(rep.winner).not.toBeNull()
    expect(rep.winner.confirmed_metric).toBeLessThan(run.baseline.metric)
    expect(rep.winner.replays).toHaveLength(3)
    expect(fs.existsSync(path.join(rep.winner.path, 'solution.js'))).toBe(true)
    expect(rep.isolation).toBe('unenforced') // no hooks in this test
    expect(rep.team.lessons.pushed).toBeGreaterThan(3)
    expect(st.evals.counted).toBeLessThanOrEqual(EVAL_CAP)

    const evs = readJsonl(path.join(run.run_dir, 'events.jsonl'))
    const lessons = readJsonl(path.join(run.run_dir, 'lessons.jsonl'))
    const results = new Map(evs.filter((e) => e.type === 'eval_result').map((e) => [e.cand_id, e]))
    // 1. every pushed lesson sits on a verified-gain candidate
    const pushed = lessons.filter((l) => l.pushed)
    expect(pushed.length).toBeGreaterThan(0)
    for (const l of pushed) expect(results.get(l.cand_id).verified_gain, l.lesson_id).toBe(true)
    expect(lessons.some((l) => !l.pushed && l.evidence.status === 'incorrect')).toBe(true)
    // 2. no lesson is delivered to its author; 3. at most once per (lesson, writer)
    const author = new Map(lessons.map((l) => [l.lesson_id, l.writer_id]))
    const seen = new Set<string>()
    const delivered = evs.filter((e) => e.type === 'lesson_delivered')
    expect(delivered.length).toBeGreaterThan(0)
    for (const d of delivered) {
      expect(author.get(d.lesson_id)).not.toBe(d.to)
      expect(lessons.find((l) => l.lesson_id === d.lesson_id).pushed).toBe(true)
      const k = d.lesson_id + '>' + d.to
      expect(seen.has(k), k).toBe(false)
      seen.add(k)
    }
    for (const id of run.writers) expect(new Set(received[id]).size).toBe(received[id].length)
    // 4. the snapshot hash equals the hash of the directory that was evaluated (and of what is on disk now)
    for (const s of evs.filter((e) => e.type === 'eval_submitted')) {
      const r = results.get(s.cand_id)
      expect(r, s.cand_id).toBeDefined()
      expect(r.evaluated_hash).toBe(s.hash)
      expect(hashDir(path.join(run.run_dir, 'candidates', s.cand_id, 'src'))).toBe(s.hash)
    }
    // 5. counted evaluations never exceed the cap
    const counted = [...results.values()].filter((r) => r.counted)
    expect(counted.length).toBeLessThanOrEqual(EVAL_CAP)
    expect(counted.every((r) => r.status === 'ok' || r.status === 'incorrect')).toBe(true)
    expect(evs.find((e) => e.type === 'run_closed').reason).toBe('evals')
    // 6. each writer's best never gets worse
    const best: Record<string, number> = {}
    for (const r of results.values()) {
      if (!r.is_own_best) continue
      if (best[r.writer_id] != null) expect(r.metric).toBeLessThan(best[r.writer_id])
      best[r.writer_id] = r.metric
    }
    // report carries all diagnostics of section 13.3
    const md = fs.readFileSync(path.join(run.run_dir, 'report.md'), 'utf8')
    for (const s of ['Lesson verified rate', 'Catch-up time', 'Characters read per writer', 'Share of reads before own correct', 'Implementation families', 'Evaluation queue share', 'Evaluations per session']) expect(md).toContain(s)
    expect(rep.diagnostics.behavior.lesson_after_verified_gain_rate).toBe(1)
    expect(rep.diagnostics.evals_per_session.sessions).toBeGreaterThan(4) // hand-offs happened
  }, 120000)

  it('CLI reads the same run', () => {
    const cli = (...a: string[]) => spawnSync('node', [path.join(DIST, 'cli.js'), ...a], { cwd: dir, encoding: 'utf8' })
    expect(cli('runs').stdout).toMatch(new RegExp(`${run.run_id}\\s+lessonshare\\s+n=4\\s+confirmed`))
    expect(cli('board', run.run_id).stdout).toMatch(/L0001 .*PUSHED.*verified gain\]/)
    expect(cli('report', run.run_id).stdout).toMatch(/# LessonShare report: toy-catalog-report/)
    const ev = cli('eval', '.lessonshare/task.json', 'toy/baseline')
    expect(ev.stdout).toMatch(/"status": "ok",\s+"metric": 30768/)
    const cal = cli('calibrate', '.lessonshare/task.json', '--runs', '3')
    expect(cal.stdout).toMatch(/"noise": 0,/)
  }, 30000)
})

describe('hook-stamp.js', () => {
  const stamp = (input: unknown) => spawnSync('node', [path.join(DIST, 'hook-stamp.js')], { input: JSON.stringify(input), encoding: 'utf8' })
  it('prints nothing for init_run and for unrelated tools', () => {
    for (const tool_name of ['mcp__plugin_lessonshare_board__init_run', 'Read', 'mcp__other__evaluate']) {
      const r = stamp({ tool_name, tool_input: { task_path: 'x' }, agent_id: 'a1' })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
  it('allows other board tools and keeps every original input field', () => {
    const r = stamp({ tool_name: 'mcp__plugin_lessonshare_board__evaluate', tool_input: { run_id: 'r1', writer_id: 'w03', note: 'tile K by 512' }, agent_id: 'abc', agent_type: 'lessonshare:writer' })
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'lessonshare board call', updatedInput: { run_id: 'r1', writer_id: 'w03', note: 'tile K by 512', _harness_agent_id: 'abc', _harness_agent_type: 'lessonshare:writer' } },
    })
    const main = JSON.parse(stamp({ tool_name: 'mcp__plugin_lessonshare_board__status', tool_input: { run_id: 'r1' } }).stdout)
    expect(main.hookSpecificOutput.updatedInput).toEqual({ run_id: 'r1', _harness_agent_id: null, _harness_agent_type: null })
  })
})

describe('hook-guard.js', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-guard-')))
  const runDir = path.join(proj, '.lessonshare', 'runs', 'r1')
  const own = path.join(runDir, 'writers', 'w01')
  const ctx = path.join(proj, 'docs', 'api.md')
  beforeAll(() => {
    for (const d of [path.join(own, 'work'), path.join(runDir, 'writers', 'w02', 'work'), path.join(runDir, 'agents'), path.join(runDir, 'candidates'), path.join(runDir, 'shared'), path.join(proj, 'docs')]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(ctx, 'api')
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), '')
    fs.symlinkSync(path.join(runDir, 'writers', 'w02'), path.join(own, 'work', 'peek'))
    fs.writeFileSync(path.join(runDir, 'agents', 'ag1.json'), JSON.stringify({ run_id: 'r1', run_dir: runDir, writer_id: 'w01', mode: 'lessonshare', start_ms: Date.now(), writer_dir: own, context_files: [ctx], shared_dir: null }))
    fs.writeFileSync(path.join(runDir, 'agents', 'ag2.json'), JSON.stringify({ run_id: 'r1', run_dir: runDir, writer_id: 'w02', mode: 'workspace', start_ms: Date.now(), writer_dir: path.join(runDir, 'writers', 'w02'), context_files: [], shared_dir: path.join(runDir, 'shared') }))
  })
  const guard = (tool_name: string, tool_input: unknown, over: Record<string, unknown> = {}) => {
    const r = spawnSync('node', [path.join(DIST, 'hook-guard.js')], { input: JSON.stringify({ tool_name, tool_input, agent_id: 'ag1', agent_type: 'lessonshare:writer', cwd: proj, ...over }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } })
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null }
  }
  it('stays silent for agents that are not LessonShare writers', () => {
    expect(guard('Read', { file_path: '/etc/passwd' }, { agent_type: 'general-purpose' })).toEqual({ status: 0, out: null })
    expect(guard('Read', { file_path: '/etc/passwd' }, { agent_type: undefined })).toEqual({ status: 0, out: null })
  })
  it('denies everything before join', () => {
    const r = guard('Read', { file_path: path.join(own, 'NOTES.md') }, { agent_id: 'unknown' })
    expect(r.out.permissionDecision).toBe('deny')
    expect(r.out.permissionDecisionReason).toMatch(/join first/)
  })
  it('applies the read/write table', () => {
    const d = (tool: string, input: unknown, over = {}) => guard(tool, input, over).out.permissionDecision
    expect(d('Write', { file_path: path.join(own, 'work', 'kernel.py') })).toBe('allow')
    expect(d('Edit', { file_path: path.join(own, 'NOTES.md') })).toBe('allow')
    expect(d('Read', { file_path: path.join(own, 'work', 'kernel.py') })).toBe('allow')
    expect(d('Grep', { pattern: 'x', path: path.join(own, 'work') })).toBe('allow')
    expect(d('Read', { file_path: ctx })).toBe('allow')
    expect(d('Write', { file_path: ctx })).toBe('deny')
    expect(d('Read', { file_path: path.join(runDir, 'writers', 'w02', 'work', 'kernel.py') })).toBe('deny')
    expect(d('Read', { file_path: path.join(own, 'work', 'peek', 'work', 'kernel.py') })).toBe('deny') // symlink into a peer
    expect(d('Read', { file_path: path.join(own, '..', 'w02', 'NOTES.md') })).toBe('deny')
    expect(d('Glob', { pattern: '**', path: path.join(runDir, 'candidates') })).toBe('deny')
    expect(d('Read', { file_path: path.join(runDir, 'lessons.jsonl') })).toBe('deny')
    expect(d('Read', { file_path: path.join(runDir, 'events.jsonl') })).toBe('deny')
    expect(d('Read', { file_path: '/etc/passwd' })).toBe('deny')
    expect(d('Glob', { pattern: '**/*.py' })).toBe('deny') // no explicit path
    expect(d('Read', { file_path: path.join(runDir, 'shared', 'index.tsv') })).toBe('deny') // not workspace mode
    expect(d('Read', { file_path: path.join(runDir, 'shared', 'index.tsv') }, { agent_id: 'ag2' })).toBe('allow')
    expect(d('Write', { file_path: path.join(runDir, 'shared', 'index.tsv') }, { agent_id: 'ag2' })).toBe('deny')
  })
  it('records denials in the event log and explains the allowed scope', () => {
    const r = guard('Read', { file_path: '/etc/hosts' })
    expect(r.out.permissionDecisionReason).toContain(own)
    const evs = readJsonl(path.join(runDir, 'events.jsonl')).filter((e) => e.type === 'guard_denied')
    expect(evs.length).toBeGreaterThan(5)
    expect(evs[evs.length - 1]).toMatchObject({ agent_id: 'ag1', writer_id: 'w01', tool: 'Read', path: '/etc/hosts' })
  })
  it('verifier role: reads the whole run, writes only its scratch directory', () => {
    fs.mkdirSync(path.join(runDir, 'verifier'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'agents', 'ver1.json'), JSON.stringify({ role: 'verifier', run_id: 'r1', run_dir: runDir, start_ms: Date.now(), scratch_dir: path.join(runDir, 'verifier'), context_files: [ctx] }))
    const d = (tool: string, input: unknown, over = {}) => guard(tool, input, { agent_id: 'ver1', agent_type: 'lessonshare:verifier', ...over }).out.permissionDecision
    expect(d('Read', { file_path: path.join(runDir, 'writers', 'w02', 'work', 'kernel.py') })).toBe('allow')
    expect(d('Glob', { pattern: '**', path: path.join(runDir, 'candidates') })).toBe('allow')
    expect(d('Read', { file_path: ctx })).toBe('allow')
    expect(d('Write', { file_path: path.join(runDir, 'verifier', 'notes.md') })).toBe('allow')
    expect(d('Write', { file_path: path.join(runDir, 'writers', 'w02', 'work', 'kernel.py') })).toBe('deny')
    expect(d('Edit', { file_path: path.join(runDir, 'lessons.jsonl') })).toBe('deny')
    expect(d('Read', { file_path: '/etc/passwd' })).toBe('deny')
    expect(d('Read', { file_path: path.join(runDir, 'run.json') }, { agent_id: 'nobody' })).toBe('deny') // not registered yet
  })
  it('exits non-zero but non-blocking on malformed input', () => {
    const r = spawnSync('node', [path.join(DIST, 'hook-guard.js')], { input: 'not json', encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
  })
})
