import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

/** A business-level refusal. Returned to the caller as {"error": code, "message": ...}. */
export class HostError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message)
  }
}
/** Invalid parameters. Surfaced as an MCP isError result. */
export class ArgError extends Error {}

export interface Clock {
  now(): number
}
export const realClock: Clock = { now: () => Date.now() }

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/** Resolve the deepest existing ancestor through symlinks, then re-append the rest. */
export function realResolve(p: string): string {
  let cur = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      tail.unshift(path.basename(cur))
      cur = parent
    }
  }
}

/** Resolve `rel` against `root` and refuse anything that lands outside `root`. */
export function resolveInside(root: string, rel: string, what: string): string {
  if (typeof rel !== 'string' || rel === '') throw new HostError('bad_path', `${what}: empty path`)
  const abs = realResolve(path.resolve(root, rel))
  if (!isInside(realResolve(root), abs)) throw new HostError('path_escape', `${what}: "${rel}" resolves outside the project directory`)
  return abs
}

export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

/** Relative posix paths of all regular files under dir, sorted. Symlinks are skipped. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, prefix: string) => {
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const rel = prefix ? prefix + '/' + e.name : e.name
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(path.join(d, e.name), rel)
      else if (e.isFile()) out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

export function matchFiles(dir: string, globs: string[]): string[] {
  const res = globs.map(globToRegex)
  return listFiles(dir).filter((f) => res.some((r) => r.test(f)))
}

export interface FileBlob {
  rel: string
  data: Buffer
}
export function readBlobs(dir: string, rels: string[]): FileBlob[] {
  return rels.map((rel) => ({ rel, data: fs.readFileSync(path.join(dir, rel)) }))
}
export function hashBlobs(blobs: FileBlob[]): string {
  const h = crypto.createHash('sha256')
  for (const b of blobs) {
    h.update(b.rel)
    h.update('\0')
    h.update(String(b.data.length))
    h.update('\0')
    h.update(b.data)
  }
  return h.digest('hex')
}
export function hashDir(dir: string): string {
  return hashBlobs(readBlobs(dir, listFiles(dir)))
}
export function writeBlobs(dir: string, blobs: FileBlob[]): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const b of blobs) {
    const dst = path.join(dir, b.rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, b.data)
  }
}
export function copyDir(src: string, dst: string): void {
  writeBlobs(dst, readBlobs(src, listFiles(src)))
}

/**
 * Append one JSON line. If the file does not end with a newline (a writer died mid-line), a newline goes first,
 * so the new record never fuses with the torn one. Safe for every writer of a log, in any process.
 */
export function appendLineSync(file: string, obj: unknown, sync = true): void {
  const fd = fs.openSync(file, 'a+')
  try {
    const size = fs.fstatSync(fd).size
    let lead = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      fs.readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== 0x0a) lead = '\n'
    }
    fs.writeSync(fd, lead + JSON.stringify(obj) + '\n')
    if (sync) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
export function readJsonlChecked<T = any>(file: string): { rows: T[]; bad: number } {
  let txt: string
  try {
    txt = fs.readFileSync(file, 'utf8')
  } catch {
    return { rows: [], bad: 0 }
  }
  const rows: T[] = []
  let bad = 0
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      bad++
    }
  }
  return { rows, bad }
}
export function readJsonl<T = any>(file: string): T[] {
  return readJsonlChecked<T>(file).rows
}
/**
 * Repair the end of a JSON-lines log. Call only while holding the run's lock. A last line without a newline is
 * either a complete record (the newline is added) or a torn one: the torn bytes move to `<file>.corrupt` and the
 * log is cut back to its last complete line. Damaged lines in the middle are left in place and counted.
 */
export function repairJsonl(file: string): { torn_bytes: number; bad_lines: number } {
  let buf: Buffer
  try {
    buf = fs.readFileSync(file)
  } catch {
    return { torn_bytes: 0, bad_lines: 0 }
  }
  let torn = 0
  if (buf.length && buf[buf.length - 1] !== 0x0a) {
    const cut = buf.lastIndexOf(0x0a) + 1
    const tail = buf.subarray(cut)
    let whole = true
    try {
      JSON.parse(tail.toString('utf8'))
    } catch {
      whole = false
    }
    if (whole) fs.appendFileSync(file, '\n')
    else {
      fs.appendFileSync(file + '.corrupt', JSON.stringify({ t: new Date().toISOString(), offset: cut, bytes: tail.length, base64: tail.toString('base64') }) + '\n')
      fs.truncateSync(file, cut)
      torn = tail.length
    }
  }
  return { torn_bytes: torn, bad_lines: readJsonlChecked(file).bad }
}
export function writeJson(file: string, obj: unknown): void {
  const tmp = file + '.tmp' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
export function readJson<T = any>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x)
  return String(Number(x.toPrecision(4)))
}
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (!n) return NaN
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}
export function round(x: number, d = 1): number {
  const k = 10 ** d
  return Math.round(x * k) / k
}

export function isObj(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base
  const out: any = isObj(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

export class Deferred<T> {
  promise: Promise<T>
  resolve!: (v: T) => void
  done = false
  constructor() {
    this.promise = new Promise<T>((r) => {
      this.resolve = (v) => {
        this.done = true
        r(v)
      }
    })
  }
}
