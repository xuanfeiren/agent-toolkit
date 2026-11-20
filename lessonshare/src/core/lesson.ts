import type { Config } from './config'
import { fmtNum } from './util'

export const REJECT_MESSAGE = 'Lessons are short prose. State the design insight and its measured effect in words, without code.'

export interface Evidence {
  status: string
  metric: number | null
  reference: number | null
  gain: number | null
  verified_gain: boolean
}

const codeLineNumbers = (text: string, lc: Config['lesson']): number[] => {
  const code = lc.code_patterns.map((p) => new RegExp(p))
  const out: number[] = []
  text.split('\n').forEach((l, i) => {
    if (l.trim() !== '' && code.some((r) => r.test(l))) out.push(i + 1)
  })
  return out
}

/** Rules 3-6 of section 6.5. Returns the error code of the first failing rule, or null. */
export function validateLessonText(text: string, lc: Config['lesson']): string | null {
  if (text.length > lc.max_chars) return 'too_long'
  if (text.includes('```') || text.includes('~~~')) return 'code_block'
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length > lc.max_lines) return 'too_many_lines'
  if (codeLineNumbers(text, lc).length >= lc.max_code_lines) return 'looks_like_code'
  const hasDef = lc.def_patterns.some((p) => new RegExp(p).test(text))
  const hasApi = lc.api_patterns.some((p) => new RegExp(p).test(text))
  if (hasDef && hasApi) return 'looks_like_code'
  return null
}

/** Which rule a rejected lesson hit, where, and how to fix it. The author gets this back with the rejection. */
export function explainReject(code: string, text: string, lc: Config['lesson']): { rule: string; lines: number[]; message: string } {
  if (code === 'too_long') return { rule: `lesson_chars=${lc.max_chars}`, lines: [], message: `The lesson has ${text.length} characters; the limit is ${lc.max_chars}. Cut it down to the insight.` }
  if (code === 'too_many_lines') return { rule: `lesson_lines=${lc.max_lines}`, lines: [], message: `The lesson has ${text.split('\n').filter((l) => l.trim() !== '').length} non-empty lines; the limit is ${lc.max_lines}. Join lines into sentences.` }
  if (code === 'code_block') return { rule: 'code_block', lines: [], message: 'The lesson contains a fenced block (``` or ~~~). Lessons are prose: say it in words.' }
  const lines = codeLineNumbers(text, lc)
  if (lines.length >= lc.max_code_lines) return { rule: `max_code_lines=${lc.max_code_lines}`, lines, message: `Lines ${lines.join(', ')} of your lesson look like code or raw notation to the filter (they start with a keyword such as def/return/import, or end with "{" or ";" or "):"). ${lines.length} such lines reach the limit of ${lc.max_code_lines}. Rewrite those lines as sentences; formulas inside a sentence are fine.` }
  return { rule: 'definition_with_api_call', lines: [], message: REJECT_MESSAGE }
}

/** The host-written evidence header. Built only from the host's own evaluation record. */
export function lessonHeader(writerId: string, candId: string, ev: Evidence, metric: Config['metric']): string {
  const parts = [writerId, candId, ev.status]
  if (ev.status === 'ok' && ev.metric != null) {
    if (ev.reference != null && ev.gain != null) {
      const pct = Math.abs(ev.gain * 100).toFixed(1)
      const word = ev.gain > 0 ? 'better' : ev.gain < 0 ? 'worse' : 'same'
      parts.push(`${metric.name} ${fmtNum(ev.reference)} → ${fmtNum(ev.metric)} (${word === 'same' ? 'no change' : pct + '% ' + word})`)
    } else parts.push(`${metric.name} ${fmtNum(ev.metric)}`)
    parts.push(ev.verified_gain ? 'verified gain' : 'no gain')
  }
  return '[' + parts.join(' · ') + ']'
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

/**
 * "A lesson must not paste the solution": true when the lesson contains a verbatim span of at least
 * `minChars` characters (whitespace-insensitive) taken from the author's own work files.
 */
export function copiedSpan(text: string, workTexts: string[], minChars: number): { at: number; excerpt: string } | null {
  if (minChars <= 0) return null
  const lesson = squash(text)
  if (lesson.length < minChars) return null
  const hay = workTexts.map(squash).filter((w) => w.length >= minChars)
  if (!hay.length) return null
  const step = Math.max(1, Math.floor(minChars / 10))
  const hit = (i: number) => {
    const win = lesson.slice(i, i + minChars)
    return hay.some((w) => w.includes(win)) ? { at: i, excerpt: win.slice(0, 30) } : null
  }
  for (let i = 0; i + minChars <= lesson.length; i += step) {
    const h = hit(i)
    if (h) return h
  }
  return hit(lesson.length - minChars)
}
export function copiesFromWork(text: string, workTexts: string[], minChars: number): boolean {
  return copiedSpan(text, workTexts, minChars) != null
}

export const COPY_MESSAGE = 'A lesson must not paste your own result. Describe the insight in your own words: what you tried, why it works, what you measured or checked. Teammates should be able to apply the idea, not copy the answer.'

export type Verdict = 'pending' | 'verified' | 'partly_verified' | 'unverified' | 'refuted' | 'withheld' | 'unchecked'

/** Header for lessons checked by the verifier agent instead of a measured gain. */
export function verdictHeader(writerId: string, candId: string, verdict: Verdict, note: string): string {
  const label = { pending: 'pending verification', verified: 'verified by verifier', partly_verified: 'PARTLY verified by verifier, read the correction', unverified: 'not verified', refuted: 'refuted by verifier', withheld: 'withheld', unchecked: 'not checked' }[verdict]
  return '[' + [writerId, candId, note ? `${label}: ${note}` : label].join(' · ') + ']'
}
