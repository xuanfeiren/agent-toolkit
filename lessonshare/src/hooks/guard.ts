// PreToolUse hook for file tools. Active only for LessonShare writers: default-deny outside the writer's own directory.
// Runs on every file tool call of the session, so it uses Node built-ins only and exits early when not concerned.
import * as fs from 'node:fs'
import * as path from 'node:path'

const WRITER_TYPE = /^lessonshare[:-]writer/
const VERIFIER_TYPE = /^lessonshare[:-]verifier/
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const WRITE_TOOLS = new Set(['Write', 'Edit'])

function realResolve(p: string): string {
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
function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
function decide(decision: 'allow' | 'deny', reason: string): never {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
  process.exit(0)
}

function findMapping(projectDir: string, agentId: string): any | null {
  const runs = path.join(projectDir, '.lessonshare', 'runs')
  let best: any = null
  let bestM = -1
  let names: string[] = []
  try {
    names = fs.readdirSync(runs)
  } catch {
    return null
  }
  for (const r of names) {
    const f = path.join(runs, r, 'agents', agentId + '.json')
    try {
      const st = fs.statSync(f)
      if (st.mtimeMs > bestM) {
        best = JSON.parse(fs.readFileSync(f, 'utf8'))
        bestM = st.mtimeMs
      }
    } catch {
      /* not in this run */
    }
  }
  return best
}

function main(raw: string) {
  const inp = JSON.parse(raw)
  if (typeof inp.agent_type !== 'string' || !(WRITER_TYPE.test(inp.agent_type) || VERIFIER_TYPE.test(inp.agent_type))) process.exit(0)
  const tool: string = inp.tool_name
  const isRead = READ_TOOLS.has(tool)
  const isWrite = WRITE_TOOLS.has(tool)
  if (!isRead && !isWrite) process.exit(0)
  const agentId = String(inp.agent_id ?? '')
  const projectDir = process.env.CLAUDE_PROJECT_DIR || inp.cwd || process.cwd()
  const map = /^[A-Za-z0-9_.-]+$/.test(agentId) ? findMapping(projectDir, agentId) : null
  if (!map) decide('deny', VERIFIER_TYPE.test(inp.agent_type) ? 'LessonShare: call a board tool (next_lesson or confirm) first. File access opens once you are registered.' : 'LessonShare: call the board tool join first. File access opens once your session is registered.')
  const ti = inp.tool_input ?? {}
  const target: unknown = tool === 'Grep' || tool === 'Glob' ? ti.path : ti.file_path
  if (map.role === 'verifier') return verifierDecision(inp, map, tool, isRead, target, agentId, projectDir)
  const allowedText = `Allowed: read and write under ${map.writer_dir}; read-only: ${[...(map.context_files ?? []), ...(map.shared_dir ? [map.shared_dir] : [])].join(', ') || '(no context files)'}.`
  const deny = (why: string, p: string | null): never => {
    try {
      const now = Date.now()
      fs.appendFileSync(
        path.join(map.run_dir, 'events.jsonl'),
        JSON.stringify({ t: new Date(now).toISOString(), minute: map.start_ms ? Math.round(((now - map.start_ms) / 60000) * 100) / 100 : 0, type: 'guard_denied', agent_id: agentId, writer_id: map.writer_id, tool, path: p }) + '\n',
      )
    } catch {
      /* the audit record is best effort */
    }
    return decide('deny', `LessonShare: ${why} ${allowedText}`)
  }
  if (typeof target !== 'string' || target === '') deny(`${tool} needs an explicit absolute path${tool === 'Grep' || tool === 'Glob' ? ' in the "path" parameter' : ''}.`, null)
  const abs = realResolve(path.isAbsolute(target as string) ? (target as string) : path.resolve(inp.cwd || projectDir, target as string))
  const own = realResolve(map.writer_dir)
  if (inside(own, abs)) decide('allow', 'own LessonShare workspace')
  if (isRead) {
    for (const c of map.context_files ?? []) if (realResolve(c) === abs) decide('allow', 'task context file')
    if (map.shared_dir && inside(realResolve(map.shared_dir), abs)) decide('allow', 'shared workspace (read-only)')
  }
  deny(`${isWrite ? 'writing' : 'reading'} ${abs} is outside your workspace.`, abs)
}

/** The verifier reads everything in its run (and the task context) and writes only in its scratch directory. */
function verifierDecision(inp: any, map: any, tool: string, isRead: boolean, target: unknown, agentId: string, projectDir: string): never {
  const scope = `Allowed: read anything under ${map.run_dir}${(map.context_files ?? []).length ? ' and the context files' : ''}; write only under ${map.scratch_dir}.`
  const deny = (why: string, p: string | null): never => {
    try {
      const now = Date.now()
      fs.appendFileSync(path.join(map.run_dir, 'events.jsonl'), JSON.stringify({ t: new Date(now).toISOString(), minute: map.start_ms ? Math.round(((now - map.start_ms) / 60000) * 100) / 100 : 0, type: 'guard_denied', agent_id: agentId, writer_id: null, role: 'verifier', tool, path: p }) + '\n')
    } catch {
      /* best effort */
    }
    return decide('deny', `LessonShare: ${why} ${scope}`)
  }
  if (typeof target !== 'string' || target === '') deny(`${tool} needs an explicit absolute path.`, null)
  const abs = realResolve(path.isAbsolute(target as string) ? (target as string) : path.resolve(inp.cwd || projectDir, target as string))
  if (isRead) {
    if (inside(realResolve(map.run_dir), abs)) decide('allow', 'LessonShare run directory (verifier)')
    for (const c of map.context_files ?? []) if (realResolve(c) === abs) decide('allow', 'task context file')
    deny(`reading ${abs} is outside the run.`, abs)
  }
  if (inside(realResolve(map.scratch_dir), abs)) decide('allow', 'verifier scratch directory')
  return deny(`writing ${abs} is not allowed.`, abs)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    main(raw)
  } catch (e) {
    // Non-blocking error: isolation is hardening, a hook bug must not kill a run (section 9.3).
    process.stderr.write(`lessonshare guard error: ${(e as Error).message}\n`)
    process.exit(1)
  }
})
