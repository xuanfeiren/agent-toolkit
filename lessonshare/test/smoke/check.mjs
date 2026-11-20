#!/usr/bin/env node
// Checks the pass conditions of the real-agent smoke test (spec 14.3 and 8.4) on a finished run directory.
// usage: node test/smoke/check.mjs <run_dir>
import fs from 'node:fs'
import path from 'node:path'
const dir = process.argv[2]
if (!dir) { console.error('usage: check.mjs <run_dir>'); process.exit(64) }
const jl = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ev = jl('events.jsonl')
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
const rep = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))
const min = run.config.metric.direction === 'min'
const notWorse = (a, b) => (min ? a <= b : a >= b)
const checks = []
const check = (name, ok, info = '') => checks.push({ name, ok: !!ok, info })

check('workflow returned a report with a winner better than baseline', rep.winner && (min ? rep.winner.confirmed_metric < rep.baseline.metric : rep.winner.confirmed_metric > rep.baseline.metric), rep.winner ? `${rep.baseline.metric} -> ${rep.winner.confirmed_metric} (${rep.winner.cand_id}, ${rep.winner.writer_id})` : 'no winner')

const lessons = fs.existsSync(path.join(dir, 'lessons.jsonl')) ? jl('lessons.jsonl') : []
const others = (w) => run.writers.filter((x) => x !== w)
const full = lessons.filter((l) => l.pushed).filter((l) => others(l.writer_id).every((o) => ev.some((e) => e.type === 'lesson_delivered' && e.lesson_id === l.lesson_id && e.to === o)))
check('at least one lesson was pushed and delivered to every other writer', full.length > 0, `${lessons.filter((l) => l.pushed).length} pushed, ${full.length} delivered to all others`)

// session hand-off: first candidate of a later session is not worse than the best of the earlier sessions
const res = ev.filter((e) => e.type === 'eval_result')
let handoffs = 0, good = 0
const detail = []
for (const w of run.writers) {
  const mine = res.filter((r) => r.writer_id === w)
  const sessions = [...new Set(mine.map((r) => r.session))].sort((a, b) => a - b)
  for (const s of sessions.slice(1)) {
    const prevOk = mine.filter((r) => r.session < s && r.status === 'ok').map((r) => r.metric)
    const first = mine.find((r) => r.session === s)
    if (!prevOk.length || !first) continue
    handoffs++
    const prevBest = min ? Math.min(...prevOk) : Math.max(...prevOk)
    const ok = first.status === 'ok' && notWorse(first.metric, prevBest)
    if (ok) good++
    detail.push(`${w} s${s}: first ${first.status} ${first.metric} vs previous best ${prevBest}${ok ? '' : ' (worse)'}`)
  }
}
check('a lane handed off between sessions and the next session started from the previous best', handoffs > 0 && good > 0, `${good}/${handoffs} hand-offs kept the best; ${detail.join('; ')}`)

const b = rep.diagnostics.behavior
check('8.4a lesson posted after a verified gain before the next evaluate, at least 80%', b.verified_gains > 0 && b.lesson_after_verified_gain_rate >= 0.8, `${b.lesson_after_verified_gain_rate} of ${b.verified_gains}`)
check('8.4b lesson rejection rate below 20%', (b.lesson_rejection_rate ?? 0) < 0.2, String(b.lesson_rejection_rate))
const notes = run.writers.map((w) => { const f = path.join(dir, 'writers', w, 'NOTES.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null })
check('8.4c NOTES.md exists for every writer and names a best candidate and a cursor', notes.every((n) => n && /c\d{4}/.test(n) && /cursor/i.test(n)), notes.map((n, i) => `${run.writers[i]}:${n ? n.length + ' chars' : 'missing'}`).join(' '))
check('8.4d no guard denials', b.guard_denied === 0, String(b.guard_denied))
check('M4: isolation enforced (every writer session stamped by the hook)', rep.isolation === 'enforced', rep.isolation)
const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8')
const need = ['Lesson verified rate', 'Catch-up time', 'Characters read per writer', 'Share of reads before own correct', 'Implementation families', 'Evaluation queue share', 'Evaluations per session']
check('M4: report.md contains every diagnostic of section 13.3', need.every((s) => md.includes(s)))
const ids = ev.filter((e) => e.type === 'eval_submitted').map((e) => e.cand_id)
check('candidate ids are unique', new Set(ids).size === ids.length, `${ids.length} candidates`)

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? '  [' + c.info + ']' : ''}`)
process.exit(checks.every((c) => c.ok) ? 0 : 1)
