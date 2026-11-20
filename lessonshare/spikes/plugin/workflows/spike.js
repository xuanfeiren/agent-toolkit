export const meta = {
  name: 'spike',
  description: 'LessonShare platform spikes S1-S8',
  phases: [{ title: 'Basic' }, { title: 'Writers' }],
}
const cfg = { sleep: 20, n: 4, ...(args ?? {}) }
const T = 'mcp__plugin_lessonshare_board__'
const OUT = { type: 'object', properties: { ok: { type: 'boolean' }, raw: { type: 'string' }, notes: { type: 'string' } }, required: ['ok', 'raw'] }
phase('Basic')
const s1 = await agent(`Call the MCP tool ${T}echo once with {"text":"s1"}. Report in raw the exact JSON text it returned (or the exact error). In notes say whether the tool was directly available or whether you had to use ToolSearch first.`, { label: 'S1 default agent', schema: OUT })
phase('Writers')
const ws = await parallel(Array.from({ length: cfg.n }, (_, i) => async () => agent(
  `You are spike writer ${i}. Steps, in order:
1. Call ${T}join with {"text":"w${i}"} directly (no ToolSearch). Record the exact JSON returned.
2. Write the file sandbox/w${i}.txt (relative to the current working directory; use an absolute path built from your cwd) with content "hello ${i}". Record success or the exact error.
3. Read that file back. Record result.
4. Try to Read the file outside.txt in the current working directory (absolute path). Record exact result or error.
5. Call Glob with pattern "*.txt" and path set to the absolute sandbox directory. Record.
6. Call Grep with pattern "hello" and path set to the absolute sandbox directory. Record.
${i === 0 ? `7. Call ${T}sleep with {"seconds":${cfg.sleep}}. Record the exact JSON returned or exact error.` : ''}
In raw put a JSON string with keys step1..step7 holding what you recorded. In notes list the exact names of all tools available to you, and whether your system prompt contains the text SPIKE-MARKER (quote the number after it).`,
  { label: `w${i}`, phase: 'Writers', agentType: 'lessonshare:writer', schema: OUT, stallMs: 1800000 })))
return { s1, ws }
