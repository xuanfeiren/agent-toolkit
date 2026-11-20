#!/usr/bin/env node
// Run a LessonShare team from the Claude Agent SDK instead of the interactive CLI.
//
//   cd examples/sdk && npm install
//   node run.mjs --project /path/to/project [--task .lessonshare/task.json] [--mode lessonshare] [-n 3] [--minutes 10]
//
// The project needs a task file (see ../toy and ../toy-open) and must live outside the plugin directory.
// Prints what the lead session does, follows the lesson board while the team works, and ends with the
// workflow's result. Exit code 0 when the run produced a report.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : dflt
}
const project = path.resolve(opt('--project', process.cwd()))
const args = { task: opt('--task', '.lessonshare/task.json'), mode: opt('--mode', 'lessonshare'), n: Number(opt('-n', 3)), minutes: Number(opt('--minutes', 10)) }
if (!fs.existsSync(path.resolve(project, args.task))) {
  console.error(`no task file at ${path.resolve(project, args.task)}`)
  process.exit(1)
}

// Follow the board of the run this session creates, using the plugin's own CLI.
const runsDir = path.join(project, '.lessonshare', 'runs')
const before = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [])
let board = null
const watch = setInterval(() => {
  if (board || !fs.existsSync(runsDir)) return
  const fresh = fs.readdirSync(runsDir).filter((r) => !before.has(r) && fs.existsSync(path.join(runsDir, r, 'run.json')))
  if (!fresh.length) return
  console.log(`\n[run] ${fresh[0]}  (${path.join(runsDir, fresh[0])})\n`)
  board = spawn(process.execPath, [path.join(plugin, 'dist', 'cli.js'), 'board', fresh[0], '--follow'], { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] })
}, 2000)
const stop = () => {
  clearInterval(watch)
  board?.kill()
}

const prompt = `Launch the workflow named "lessonshare:discover" with the Workflow tool, passing args ${JSON.stringify(args)}. It runs in the background for about ${args.minutes + 3} minutes: wait for its completion notification (do not poll, do not start it twice). Then print the returned result verbatim as JSON.`

let ok = false
try {
  for await (const msg of query({
    prompt,
    options: {
      cwd: project,
      plugins: [{ type: 'local', path: plugin }],
      permissionMode: 'default',
      // init_run runs the task's evaluation command, so it is never auto-approved by the plugin: allow it here.
      allowedTools: ['Workflow', 'mcp__plugin_lessonshare_board__init_run'],
      // Without this the session ends 10 minutes after its last turn and takes the workflow with it.
      env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
    },
  })) {
    if (msg.type === 'assistant') {
      for (const c of msg.message.content) {
        if (c.type === 'text' && c.text.trim()) console.log(`[lead] ${c.text.trim()}`)
        if (c.type === 'tool_use') console.log(`[lead] → ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`)
      }
    } else if (msg.type === 'result') {
      ok = msg.subtype === 'success' && !msg.is_error
      console.log(`\n[result] ${msg.subtype}, ${Math.round((msg.duration_ms ?? 0) / 1000)} s`)
      if (msg.result) console.log(msg.result)
    }
  }
} finally {
  stop()
}
process.exit(ok ? 0 : 1)
