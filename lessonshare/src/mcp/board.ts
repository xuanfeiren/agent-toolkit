// MCP front end for the LessonShare host. stdout carries protocol only; logs go to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Host } from '../core/host'
import { TOOLS } from '../core/tools'
import { ArgError } from '../core/util'

const log = (m: string) => process.stderr.write(`[lessonshare board ${process.pid}] ${m}\n`)

function projectDir(): string {
  const p = process.env.LESSONSHARE_PROJECT_DIR
  return p && !p.includes('${') ? p : process.cwd()
}

async function main() {
  const host = new Host({ projectDir: projectDir() })
  const server = new Server({ name: 'board', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params
    const token = req.params._meta?.progressToken
    let n = 0
    // keep long evaluate/get_result/confirm calls alive under the stdio idle timeout
    const beat =
      token !== undefined
        ? setInterval(() => {
            extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: 'working' } }).catch(() => {})
          }, 30_000)
        : null
    try {
      const out = await host.call(name, args ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    } catch (e) {
      const msg = e instanceof ArgError ? e.message : `internal error: ${(e as Error).stack ?? e}`
      if (!(e instanceof ArgError)) log(msg)
      return { content: [{ type: 'text', text: JSON.stringify({ error: e instanceof ArgError ? 'invalid_arguments' : 'internal_error', message: msg }) }], isError: true }
    } finally {
      if (beat) clearInterval(beat)
    }
  })
  const timer = setInterval(() => host.tick(), 2000)
  timer.unref()
  const shutdown = () => {
    host.releaseLocks()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdin.on('close', shutdown)
  process.on('exit', () => host.releaseLocks())
  await server.connect(new StdioServerTransport())
  log(`ready, project=${host.projectDir}`)
}

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e}`)
  process.exit(1)
})
