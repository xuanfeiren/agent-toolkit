const fs = require('fs'), path = require('path')
let s = ''
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const inp = JSON.parse(s)
  const proj = process.env.CLAUDE_PROJECT_DIR || inp.cwd
  const dir = path.join(proj, 'spike-out', 'hooks'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${process.argv[2]}-${inp.tool_name}-${inp.tool_use_id}.json`), JSON.stringify({ stdin: inp, env: { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA } }, null, 1))
  if (process.argv[2] === 'stamp') {
    return console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'spike', updatedInput: { ...inp.tool_input, _harness_agent_id: inp.agent_id ?? null, _harness_agent_type: inp.agent_type ?? null } } }))
  }
  // guard: only for writer agents; allow inside <proj>/sandbox, deny elsewhere
  if (inp.agent_type !== 'lessonshare:writer') return
  const p = inp.tool_input.file_path || inp.tool_input.path || ''
  const ok = path.resolve(p).startsWith(path.join(proj, 'sandbox')) || /sens-test/.test(p)
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny', permissionDecisionReason: ok ? 'inside sandbox' : 'spike guard: only sandbox/ is allowed' } }))
})
