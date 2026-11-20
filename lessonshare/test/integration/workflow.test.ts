import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../helpers'

// Runs workflows/discover.js against a mocked workflow runtime: checks control flow only, no model calls.
const src = fs.readFileSync(path.join(ROOT, 'workflows', 'discover.js'), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

async function runScript(args: unknown, agentImpl: (prompt: string, opts: any) => any) {
  const calls: Array<{ prompt: string; opts: any }> = []
  const logs: string[] = []
  const body = src.replace(/^export const meta/m, 'const meta')
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)
  const agent = async (prompt: string, opts: any) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts)
  }
  const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const result = await fn(args, agent, parallel, () => {}, (m: string) => logs.push(m))
  return { result, calls, logs }
}

describe('workflows/discover.js', () => {
  it('starts with a literal meta export and uses no forbidden runtime calls', () => {
    expect(src.startsWith('export const meta = {')).toBe(true)
    expect(src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(\)|\bimport\(|\brequire\(/)
  })
  it('init -> N lanes of sessions -> confirm; prompts depend only on run, writer and session', async () => {
    const perWriter: Record<string, number> = {}
    const { result, calls, logs } = await runScript({ n: 3, minutes: 5, max_sessions: 4, mode: 'independent' }, (prompt, opts) => {
      if (opts.label === 'init') {
        expect(prompt).toContain('"mode":"independent"')
        expect(prompt).toContain('"budget":{"minutes":5,"evals":null}')
        return { run_id: 'r-1', run_dir: '/p/r-1', session_base: 0, warnings: ['small n'], baseline: { metric: 10 } }
      }
      if (opts.label === 'confirm') return { run_id: 'r-1', winner: { cand_id: 'c0001' }, baseline: {}, team: {} }
      const id = /writer_id: (w\d+)/.exec(prompt)![1]
      const s = Number(/session: (\d+)/.exec(prompt)![1])
      perWriter[id] = (perWriter[id] ?? 0) + 1
      expect(opts.agentType).toBe('lessonshare:writer')
      expect(prompt).toBe(`run_id: r-1\nrun_dir: /p/r-1\nwriter_id: ${id}\nsession: ${s}\n\nWork according to your agent instructions.`)
      if (id === 'w02' && s === 0) return null // one dead agent is tolerated
      return { writer_id: id, session: s, run_closed: s >= 2, evals_this_session: 3, best_metric: 5, summary: 'ok' }
    })
    expect(perWriter).toEqual({ w01: 3, w02: 3, w03: 3 })
    expect(calls[0].opts.label).toBe('init')
    expect(calls[calls.length - 1].opts.label).toBe('confirm')
    expect(result).toMatchObject({ run_id: 'r-1', run_dir: '/p/r-1', winner: { cand_id: 'c0001' } })
    expect(result.lanes.map((l: any) => l.sessions)).toEqual([3, 2, 3])
    expect(logs.join('\n')).toMatch(/warning: small n/)
  })
  it('numbers sessions from session_base on resume and stops a lane after two dead agents', async () => {
    const sessions: number[] = []
    const { calls } = await runScript('{"n": 1, "resume_run_id": "r-9", "minutes": 7, "max_sessions": 5}', (prompt, opts) => {
      if (opts.label === 'init') {
        expect(prompt).toContain('{"resume_run_id":"r-9","budget":{"minutes":7,"evals":null}}')
        return { run_id: 'r-9', run_dir: '/p/r-9', session_base: 4 }
      }
      if (opts.label === 'confirm') return null
      sessions.push(Number(/session: (\d+)/.exec(prompt)![1]))
      return null
    })
    expect(sessions).toEqual([4, 5])
    expect(calls).toHaveLength(4)
  })
  it('agent verification: a verifier lane runs beside the writers and a judge confirms', async () => {
    const order: string[] = []
    let closed = false
    const { result, calls } = await runScript({ n: 2, max_sessions: 2 }, async (prompt, opts) => {
      order.push(opts.label)
      if (opts.label === 'init') return { run_id: 'r-2', run_dir: '/p/r-2', session_base: 0, verify_kind: 'agent' }
      if (opts.label === 'judge') {
        expect(opts.agentType).toBe('lessonshare:verifier')
        expect(prompt).toBe('task: judge\nrun_id: r-2\nrun_dir: /p/r-2\n\nWork according to your agent instructions. Return the report that the final confirm call gives you, unchanged.')
        closed = true
        return { run_id: 'r-2', winner: { writer_id: 'w02', judged: true }, baseline: {}, team: {} }
      }
      if (opts.label.startsWith('verifier')) {
        expect(opts.agentType).toBe('lessonshare:verifier')
        const s = Number(/session: (\d+)/.exec(prompt)![1])
        expect(prompt).toBe(`task: verify\nrun_id: r-2\nrun_dir: /p/r-2\nsession: ${s}\n\nWork according to your agent instructions.`)
        while (!closed && s >= 1) await new Promise((r) => setTimeout(r, 5)) // second session lasts until the run closes
        return { session: s, run_closed: closed, verdicts_this_session: 3, summary: '' }
      }
      const s = Number(/session: (\d+)/.exec(prompt)![1])
      return { writer_id: 'w', session: s, run_closed: false, evals_this_session: 1, best_metric: null, summary: '' }
    })
    expect(order[0]).toBe('init')
    expect(order.filter((l) => l.startsWith('verifier'))).toEqual(['verifier s0', 'verifier s1'])
    expect(order.indexOf('verifier s0')).toBeLessThan(order.indexOf('judge'))
    expect(calls.some((c) => c.opts.label === 'confirm')).toBe(false)
    expect(result).toMatchObject({ winner: { writer_id: 'w02' }, verifier: { sessions: 2, verdicts: 6 } })
  })
  it('command verification starts no verifier lane', async () => {
    const { calls, result } = await runScript({ n: 1, max_sessions: 1 }, (p, o) => (o.label === 'init' ? { run_id: 'r', run_dir: '/r', verify_kind: 'command' } : o.label === 'confirm' ? { run_id: 'r', winner: null, baseline: {}, team: {} } : null))
    expect(calls.map((c) => c.opts.label)).toEqual(['init', 'w01 s0', 'confirm'])
    expect(result.verifier).toBeNull()
  })
  it('fails fast on bad input and on a failed init', async () => {
    await expect(runScript({ n: 100, max_sessions: 12 }, () => null)).rejects.toThrow(/1,000-agent cap/)
    await expect(runScript('n=3', () => null)).rejects.toThrow(/JSON object/)
    await expect(runScript([3], () => null)).rejects.toThrow(/JSON object/)
    await expect(runScript({ n: 2 }, () => ({ error: 'baseline_infra_error: boom' }))).rejects.toThrow(/init failed: baseline_infra_error/)
    await expect(runScript({ n: 2 }, () => null)).rejects.toThrow(/agent returned null/)
    const big = await runScript({ n: 20, max_sessions: 1 }, (p, o) => (o.label === 'init' ? { run_id: 'r', run_dir: '/r' } : null))
    expect(big.logs.join('\n')).toMatch(/CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS/)
    expect(big.result).toMatchObject({ error: 'confirm agent returned null', run_id: 'r' })
  })
})
