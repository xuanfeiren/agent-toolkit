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

export function appendLineSync(file: string, obj: unknown): void {
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
export function readJsonl<T = any>(file: string): T[] {
  let txt: string
  try {
    txt = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* torn last line after a crash: ignore */
    }
  }
  return out
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
