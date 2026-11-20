// minimal hand-rolled MCP stdio server for spikes
const fs = require('fs'), path = require('path')
const proj = process.env.LESSONSHARE_PROJECT_DIR || process.cwd()
const logf = path.join(proj, 'spike-out', 'server.log')
fs.mkdirSync(path.dirname(logf), { recursive: true })
const started = new Date().toISOString()
const log = (m) => fs.appendFileSync(logf, `${new Date().toISOString()} pid=${process.pid} ${m}\n`)
log('start env.PROJECT=' + proj)
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const idf = { _harness_agent_id: { type: 'string' }, _harness_agent_type: { type: 'string' } }
const tools = [
  { name: 'echo', description: 'Echo back the input with the server pid.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...idf } } },
  { name: 'join', description: 'Echo back the input with the server pid (same as echo).', inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...idf } } },
  { name: 'sleep', description: 'Sleep for N seconds then return.', inputSchema: { type: 'object', properties: { seconds: { type: 'number' }, ...idf }, required: ['seconds'] } },
]
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)) }
})
async function handle(m) {
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'board', version: '0.0.1' } } })
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} })
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } })
  if (m.method === 'tools/call') {
    const { name, arguments: a, _meta } = m.params
    log(`call ${name} args=${JSON.stringify(a)} meta=${JSON.stringify(_meta || null)}`)
    if (name === 'sleep') {
      const t0 = Date.now()
      const iv = _meta && _meta.progressToken !== undefined && a.progress !== false ? setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: _meta.progressToken, progress: Math.round((Date.now() - t0) / 1000), total: a.seconds } }), 30000) : null
      await new Promise((r) => setTimeout(r, a.seconds * 1000))
      if (iv) clearInterval(iv)
      log('sleep done')
      return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ slept: a.seconds, pid: process.pid, had_progress_token: !!iv }) }] } })
    }
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, started, received: a }) }] } })
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })
}
