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

/** Rules 3-6 of section 6.5. Returns the error code of the first failing rule, or null. */
export function validateLessonText(text: string, lc: Config['lesson']): string | null {
  if (text.length > lc.max_chars) return 'too_long'
  if (text.includes('```') || text.includes('~~~')) return 'code_block'
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length > lc.max_lines) return 'too_many_lines'
  const code = lc.code_patterns.map((p) => new RegExp(p))
  const codeLines = lines.filter((l) => code.some((r) => r.test(l))).length
  if (codeLines >= lc.max_code_lines) return 'looks_like_code'
  const hasDef = lc.def_patterns.some((p) => new RegExp(p).test(text))
  const hasApi = lc.api_patterns.some((p) => new RegExp(p).test(text))
  if (hasDef && hasApi) return 'looks_like_code'
  return null
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
export function copiesFromWork(text: string, workTexts: string[], minChars: number): boolean {
  if (minChars <= 0) return false
  const lesson = squash(text)
  if (lesson.length < minChars) return false
  const hay = workTexts.map(squash).filter((w) => w.length >= minChars)
  if (!hay.length) return false
  const step = Math.max(1, Math.floor(minChars / 10))
  for (let i = 0; i + minChars <= lesson.length; i += step) {
    const win = lesson.slice(i, i + minChars)
    if (hay.some((w) => w.includes(win))) return true
  }
  const tail = lesson.slice(lesson.length - minChars)
  return hay.some((w) => w.includes(tail))
}

export const COPY_MESSAGE = 'A lesson must not paste your own result. Describe the insight in your own words: what you tried, why it works, what you measured or checked. Teammates should be able to apply the idea, not copy the answer.'

export type Verdict = 'pending' | 'verified' | 'unverified' | 'refuted' | 'withheld'

/** Header for lessons checked by the verifier agent instead of a measured gain. */
export function verdictHeader(writerId: string, candId: string, verdict: Verdict, note: string): string {
  const label = { pending: 'pending verification', verified: 'verified by verifier', unverified: 'not verified', refuted: 'refuted by verifier', withheld: 'withheld' }[verdict]
  return '[' + [writerId, candId, note ? `${label}: ${note}` : label].join(' · ') + ']'
}
