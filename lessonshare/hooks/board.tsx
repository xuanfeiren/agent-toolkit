// The lesson board as a pane inside Claude Code. Reads the newest run under .lessonshare/runs every few
// seconds (lessons.jsonl, events.jsonl, run.json) and draws one card per lesson. Read-only: it never
// writes to a run and never calls a board tool.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardLesson, BoardRun, BoardView } from '../types'

const PANE = 'lesson-board'
const TITLE = 'Lesson board'
const POLL_MS = 3000
const MAX_CARDS = 60

const runAtom = atom({ plugin: 'lessonshare', key: 'run' } as const, null, { shape: 'run-1' })
const viewAtom = atom({ plugin: 'lessonshare', key: 'view' } as const, { filter: 'all', isNewestFirst: true } as BoardView, { shape: 'view-1' })

const jsonl = (text: string): any[] => {
  const out: any[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a line still being written */
    }
  }
  return out
}

function settingsLine(cfg: any): string {
  const boardOn = cfg.board?.enabled !== false
  const parts = [
    cfg.shared?.enabled ? 'agents see each other' : 'agents isolated',
    `push ${boardOn ? cfg.push?.policy : 'none'}`,
    cfg.verify?.kind === 'command' ? 'checked by evaluator' : cfg.verifier?.enabled === false ? 'not checked' : 'checked by verifier',
    !boardOn ? 'board off' : `board ${cfg.board?.show ?? 'all'}${cfg.board?.pull === false ? ', no pull' : ''}`,
    `≤${cfg.lesson?.max_chars} chars`,
  ]
  return parts.join(' · ')
}

async function load($: any, runsDir: string, runId: string): Promise<BoardRun | null> {
  const dir = `${runsDir}/${runId}`
  let file: any
  try {
    file = JSON.parse(await $.fs.read(`${dir}/run.json`))
  } catch {
    return null
  }
  const lessons = (await $.fs.exists(`${dir}/lessons.jsonl`)) ? jsonl(await readAll($, `${dir}/lessons.jsonl`)) : []
  const events = (await $.fs.exists(`${dir}/events.jsonl`)) ? jsonl(await readAll($, `${dir}/events.jsonl`)) : []
  const verdicts = new Map<string, any>()
  const delivered = new Map<string, string[]>()
  let state = 'open'
  let minute = 0
  let rejected = 0
  let rejectedForCopy = 0
  let winner = ''
  for (const e of events) {
    if (typeof e.minute === 'number' && e.minute > minute) minute = e.minute
    if (e.type === 'lesson_verdict') verdicts.set(e.lesson_id, e)
    else if (e.type === 'lesson_delivered') delivered.set(e.lesson_id, [...(delivered.get(e.lesson_id) ?? []), e.to])
    else if (e.type === 'lesson_rejected') {
      rejected++
      if (e.error === 'contains_solution') rejectedForCopy++
    } else if (e.type === 'run_closed') state = `closed: ${e.reason}`
    else if (e.type === 'run_reopened') state = 'open'
    else if (e.type === 'run_confirmed') {
      state = 'confirmed'
      winner = e.winner_writer ? `${e.winner_writer} (${e.winner})` : ''
    }
  }
  const cards: BoardLesson[] = lessons.map((l: any) => {
    const v = verdicts.get(l.lesson_id)
    const status = v ? v.verdict : l.verdict ? l.verdict : l.evidence?.verified_gain ? 'gain' : 'nogain'
    return {
      id: l.lesson_id,
      writer: l.writer_id,
      cand: l.cand_id,
      minute: l.minute,
      status,
      note: v ? v.note : l.verdict ? '' : String(l.header ?? '').replace(/^\[|\]$/g, ''),
      isPushed: v ? !!v.pushed : !!l.pushed,
      deliveredTo: delivered.get(l.lesson_id) ?? [],
      corrects: typeof l.corrects === 'string' ? l.corrects : '',
      correctedBy: [],
      text: l.text,
    }
  })
  // a correction counts against its target once it is visible and not itself in doubt
  for (const c of cards) {
    if (!c.corrects || ['pending', 'withheld', 'refuted', 'unverified'].includes(c.status)) continue
    cards.find(x => x.id === c.corrects)?.correctedBy.push(c.id)
  }
  return { runId, task: file.config?.name ?? '', n: file.config?.n ?? 0, state, minute, settings: settingsLine(file.config ?? {}), rejected, rejectedForCopy, winner, lessons: cards }
}

/** Whole file in 1 MiB ranges: one read is capped at 4 MiB, and an events file can grow past that. */
async function readAll($: any, path: string): Promise<string> {
  const { size } = await $.fs.stat(path)
  const step = 1 << 20
  if (size <= step) return $.fs.read(path)
  const tail = Math.max(0, size - 8 * step) // the newest 8 MiB is plenty for a board
  let out = ''
  for (let offset = tail; offset < size; offset += step) out += await $.fs.read(path, { offset, length: Math.min(step, size - offset) })
  return out
}

async function newestRun($: any): Promise<{ runsDir: string; runId: string } | null> {
  const cwd = await $.session.cwd()
  const runsDir = `${cwd}/.lessonshare/runs`
  if (!(await $.fs.exists(runsDir))) return null
  const names = (await $.fs.list(runsDir)).filter((e: any) => e.kind === 'dir' && e.name.startsWith('r-')).map((e: any) => e.name).sort()
  return names.length ? { runsDir, runId: names[names.length - 1] } : null
}

const UNCHECKED = { mark: '·', label: 'not checked', color: 'inactive' }
const STATUS: Record<string, { mark: string; label: string; color: string }> = {
  verified: { mark: '✔', label: 'verified', color: 'success' },
  partly_verified: { mark: '◐', label: 'partly verified, read the correction', color: 'warning' },
  gain: { mark: '✔', label: 'verified gain', color: 'success' },
  unverified: { mark: '?', label: 'not verified', color: 'warning' },
  unchecked: UNCHECKED,
  nogain: { mark: '·', label: 'no measured gain', color: 'inactive' },
  refuted: { mark: '✘', label: 'refuted', color: 'error' },
  withheld: { mark: '⊘', label: 'withheld (gives away the result)', color: 'error' },
  pending: { mark: '…', label: 'waiting for the verifier', color: 'inactive' },
}
const isVerified = (l: BoardLesson) => l.status === 'verified' || l.status === 'partly_verified' || l.status === 'gain'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lesson-board', description: 'Show the LessonShare lesson board of the newest run in a pane' })
    let seenRun = ''
    let isPrimed = false
    let last = ''
    const poll = async () => {
      try {
        const found = await newestRun($)
        const run = found ? await load($, found.runsDir, found.runId) : null
        if (!run) {
          isPrimed = true
          return
        }
        const text = JSON.stringify(run)
        if (text !== last) {
          last = text
          await update($, runAtom, () => run)
        }
        // A run that starts while this session is open brings its board up by itself.
        if (isPrimed && seenRun !== run.runId && run.state === 'open') void $.ui.open({ id: PANE, title: TITLE })
        seenRun = run.runId
        isPrimed = true
      } catch {
        /* a file mid-write or a run directory being created: the next tick reads it */
      }
    }
    void poll()
    $.clock.every(POLL_MS, () => void poll())
    return next(e)
  })

  on('command.run', { command: 'lesson-board' }, async $ => {
    const found = await newestRun($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: found ? `Lesson board opened for run ${found.runId}.` : 'Lesson board opened. There is no run in this project yet (.lessonshare/runs is empty).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run = (await read($, runAtom)) as BoardRun | null
    const view = (await read($, viewAtom)) as BoardView
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text bold>Lesson board</Text>
          <Text dimColor>No run in this project yet. Start one with /lessonshare:solve and the lessons appear here.</Text>
        </Box>
      )
    }
    const all = run.lessons
    const counts = {
      verified: all.filter(l => isVerified(l) && l.status !== 'partly_verified').length,
      partly: all.filter(l => l.status === 'partly_verified').length,
      corrections: all.filter(l => l.corrects !== '').length,
      pending: all.filter(l => l.status === 'pending').length,
      pushed: all.filter(l => l.isPushed).length,
      withheld: all.filter(l => l.status === 'withheld').length,
    }
    let shown = all.filter(l => (view.filter === 'verified' ? isVerified(l) : view.filter === 'pending' ? l.status === 'pending' : true))
    if (view.isNewestFirst) shown = [...shown].reverse()
    const hidden = Math.max(0, shown.length - MAX_CARDS)
    shown = shown.slice(0, MAX_CARDS)
    const nextFilter: BoardView['filter'] = view.filter === 'all' ? 'verified' : view.filter === 'verified' ? 'pending' : 'all'

    return (
      <Box flexDirection="column">
        <Text bold>
          {run.task || 'run'} · {run.n} agents · {run.state} · min {run.minute.toFixed(1)}
        </Text>
        <Text dimColor>{run.runId}</Text>
        <Text dimColor>{run.settings}</Text>
        <Text>
          {all.length} lessons · <Text color="success">{counts.verified} verified</Text>
          {counts.partly ? ` · ${counts.partly} partly` : ''} · {counts.pushed} pushed · {counts.pending} waiting
          {counts.corrections ? ` · ${counts.corrections} corrections` : ''}
          {counts.withheld ? ` · ${counts.withheld} withheld` : ''}
          {run.rejected ? ` · ${run.rejected} rejected by the host${run.rejectedForCopy ? ` (${run.rejectedForCopy} pasted the result)` : ''}` : ''}
        </Text>
        {run.winner !== '' && <Text color="success">winner: {run.winner}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button key="filter" hotkey="f" onPress={() => update($, viewAtom, v => ({ ...v, filter: nextFilter }))}>
            show: {view.filter}
          </Button>
          <Button key="order" hotkey="o" onPress={() => update($, viewAtom, v => ({ ...v, isNewestFirst: !v.isNewestFirst }))}>
            {view.isNewestFirst ? 'newest first' : 'oldest first'}
          </Button>
        </Box>
        {shown.length === 0 && <Text dimColor>{all.length === 0 ? 'No lessons yet.' : 'No lesson matches this filter.'}</Text>}
        {shown.map(l => {
          const s = STATUS[l.status] ?? UNCHECKED
          return (
            <Box key={l.id} flexDirection="column" borderStyle="round" borderColor={s.color} paddingX={1}>
              <Text>
                <Text bold>{l.id}</Text> · {l.writer} · {l.cand} · min {l.minute}
              </Text>
              <Text color={s.color}>
                {s.mark} {s.label}
                {l.status === 'withheld' ? '' : l.isPushed ? (l.deliveredTo.length ? ` · pushed → ${l.deliveredTo.join(', ')}` : ' · pushed, not yet delivered') : ' · on the board, not pushed'}
              </Text>
              {l.corrects !== '' && <Text color="warning">corrects {l.corrects}</Text>}
              {l.correctedBy.length > 0 && <Text color="error">corrected by {l.correctedBy.join(', ')}: read that lesson first</Text>}
              {l.note !== '' && <Text dimColor>{l.status === 'gain' || l.status === 'nogain' ? '' : 'verifier: '}{l.note}</Text>}
              <Text>{l.text}</Text>
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>{hidden} more not shown. Use the filter, or run: lessonshare board {run.runId}</Text>}
      </Box>
    )
  })
}
