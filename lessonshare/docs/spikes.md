# Spikes (M0)

Environment: Claude Code **2.1.328**, Node **v22.23.2** (bundle target Node 20), Linux, 8 CPUs.
Dynamic workflows enabled. Date: 2026-11-19 (UTC).

Method: a throwaway plugin named `lessonshare` (`spikes/plugin/`) with a hand-rolled echo MCP server `board`,
two logging PreToolUse hooks, a `writer` agent with a `tools` whitelist, and `workflows/spike.js`.
Run headless from `spikes/proj/`:

    claude -p "Run the /lessonshare:spike workflow with args {...}" --plugin-dir ../plugin --allowedTools Workflow [--permission-mode default]

Evidence files were written to `spikes/proj/spike-out/` (server log, one JSON dump of hook stdin per tool call); the
relevant lines are quoted below.

| # | Assumption | Result | Evidence |
|---|---|---|---|
| S1 | Workflow agents can call plugin MCP tools | **Holds** | Default workflow agent called `mcp__plugin_lessonshare_board__echo` and got `{"pid":2626743,...}` back. With `alwaysLoad: true` the tool was directly available (no ToolSearch). |
| S2 | One board process per session, shared by all agents | **Holds** | 1 default agent + 4 concurrent writer agents all saw `pid=2626743`; `server.log` has a single `start` line per session. |
| S3 | Plugin hooks fire inside workflow agents; stdin has `agent_id`; `agent_type` is `lessonshare:writer` | **Holds** | Hook stdin: `"agent_id":"aee15bac37531f1b6","agent_type":"lessonshare:writer"`. Default workflow agents report `"agent_type":"workflow-subagent"`. Hook env has `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`. MCP calls also carry `mcp_server: {name: "plugin:lessonshare:board"}`. |
| S4 | A 5-minute blocking MCP call in an agent is not aborted and does not trigger a stall restart | **Holds** | `sleep` 310 s: `02:23:00 call sleep` → `02:28:10 sleep done`, agent received `{"slept":310,...}`, no restart (single `join` in the log). Claude Code passes a `progressToken` on every call, so the 30 s progress heartbeat is usable. |
| S5 | With `alwaysLoad`, writers call board tools without tool search; MCP full names work in the `tools` whitelist | **Holds** | Writers listed exactly `Read, Write, Edit, Grep, Glob, mcp__plugin_lessonshare_board__{join,echo,sleep}, StructuredOutput`; first `join` succeeded directly. |
| S6 | A PreToolUse `allow` removes permission prompts for workflow agents (MCP calls and file writes) | **Holds** | Re-run with `--permission-mode default` (hook stdin shows `"permission_mode":"default"`): MCP calls, `Write`, `Read`, `Glob`, `Grep` inside the allowed directory all succeeded headless; the `deny` for a path outside it surfaced to the agent as `PreToolUse:Read hook error: <reason>`. `updatedInput` reached the server (`_harness_agent_id` present in the received arguments). |
| S7 | `agentType` can point at a plugin agent and coexists with `schema`; `phase`, `stallMs`; `parallel()` takes thunks | **Holds** | `agentType: 'lessonshare:writer'` + `schema` returned validated objects; the agent's system prompt was the plugin agent body (marker string echoed back); `StructuredOutput` is added on top of the `tools` whitelist, so the whitelist does not block structured output. `phase` and thunk-array `parallel()` are confirmed by the `/workflow-authoring` reference. `stallMs` is accepted (official docs) but is not listed in that reference. |
| S8 | `tool_input` field names: `file_path` for Read/Write/Edit, `path` for Grep/Glob | **Holds** | Hook dumps: `Read {"file_path"}`, `Write {"file_path","content"}`, `Glob {"pattern","path"}`, `Grep {"pattern","path"}`. |

No fallback was needed. Sections 7.6 (inline prompt), 9.5 (hook degradation) and the CLI transport fallback of S1 are **not** used.
`lessonshare call <tool> '<json>'` exists in the CLI anyway as a manual escape hatch.

## Differences from the spec found while spiking

1. **Concurrency cap.** The workflow reference states the cap is `min(16, CPUs - 2)`. On this 8-CPU machine that is 6,
   so N=8 lanes do not all run at once unless `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` is raised.
   `discover.js` logs a note for every run and the skill tells the user (spec 7.1 only warned for n > 16).
2. **Headless skill permission.** In `--permission-mode default` headless runs, invoking `/lessonshare:discover` as a
   skill needs `Skill(lessonshare:discover)`; launching the same workflow by name through the Workflow tool needs
   `Workflow`. README lists both rules.
3. **Headless default permission mode.** This machine's settings default headless sessions to `bypassPermissions`,
   so S6 was verified separately with an explicit `--permission-mode default`.
4. **Resume and session numbers.** `init_run` returns `session_base` (0 for a new run; highest joined session + 1 on
   `resume_run_id`) and `discover.js` numbers sessions from it. Without this a resumed run would burn its
   `max_sessions` budget re-joining exhausted sessions. This extends spec 7.4.

5. **Projects inside the plugin directory do not work.** First smoke attempt: the test project lived at
   `<plugin>/.smoke/proj`. Every `Write`/`Edit` by a writer was refused with "Claude requested permissions to edit
   ... which is a sensitive file" although the guard hook returned `allow`. A control run with the same paths in a
   project outside any plugin directory succeeded for all eight path shapes tried (`.lessonshare/runs/.../work/a.txt`,
   `NOTES.md`, dot-directories). Conclusion: files under a loaded plugin's root are protected and a PreToolUse
   `allow` does not override that check. README troubleshooting documents it; the smoke project now lives outside.

## Workflow API facts used by `workflows/discover.js`

Verified against the `/workflow-authoring` reference on Claude Code 2.1.328:
`export const meta` literal first; `agent(prompt, {label, phase, schema, agentType})`; `parallel(thunks)` never rejects
and yields `null` for a failed thunk; `phase()`, `log()`, `args`; no `Date.now()`/`Math.random()`; resume replays
the longest unchanged prefix of `agent()` calls.
