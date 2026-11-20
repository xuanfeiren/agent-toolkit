export const meta = {
  name: 'discover',
  description: 'Team search on one task with a shared board of verified lessons',
  whenToUse: 'N writer agents attempt the same task in isolation and exchange verified prose lessons. Lessons are verified by an evaluation command or by a verifier agent. Start it through /lessonshare:solve or /lessonshare:plan.',
  phases: [{ title: 'Init' }, { title: 'Search' }, { title: 'Confirm' }],
}
// Workflow-API assumptions (verified on Claude Code 2.1.328, see docs/spikes.md):
//  - agent(prompt, {label, phase, schema, agentType, stallMs}); agentType may name a plugin agent and composes with schema
//  - parallel(thunks) is a barrier, never rejects; a failed thunk yields null
//  - agent() returns null when the agent is skipped or dies
//  - no Date.now()/Math.random()/I/O here: the host (MCP server "board") owns clock, budget and all protocol logic
//  - resume replays agent() calls in start order, so prompts depend only on run_id, run_dir, writer_id, session
//  - the writers of a run are the ones the host returns from init_run; resuming a run never changes them

// args must be structured data; a JSON string is accepted too, anything else is an error (never silently fall back to N=8 / 120 min)
let input = args
if (typeof input === 'string' && input.trim()) {
  try { input = JSON.parse(input) } catch (e) { throw new Error('args must be a JSON object, e.g. {"n": 8, "minutes": 120}') }
}
if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw new Error('args must be a JSON object')
const cfg = {
  task: '.lessonshare/task.json', mode: 'lessonshare', n: 8, minutes: 120, evals: null,
  max_sessions: 12, settings: {}, overrides: {}, resume_run_id: null, recover: false, agent_type: 'lessonshare:writer',
  verifier_type: 'lessonshare:verifier', verifier_max_sessions: 20,
  ...(input || {}),
}
const T = 'mcp__plugin_lessonshare_board__'
// n given together with resume_run_id is passed on, so the host can refuse a roster that does not match the run
const nGiven = input != null && input.n != null
if (cfg.recover && !cfg.resume_run_id) throw new Error('recover needs resume_run_id')
if (!Number.isInteger(cfg.n) || cfg.n < 1) throw new Error('n must be a positive integer')
if (cfg.n * cfg.max_sessions + cfg.verifier_max_sessions + 2 > 1000) throw new Error('n * max_sessions + verifier sessions + 2 exceeds the 1,000-agent cap of one workflow run')
if (cfg.n > 16) log('n > 16: raise CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS or the extra lanes will queue')
else if (cfg.n > 6) log(`n=${cfg.n}: workflows run at most min(16, CPUs - 2) agents at once; on small machines set CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=${cfg.n} or lanes will queue`)

const INIT_SCHEMA = {
  type: 'object',
  properties: {
    run_id: { type: 'string' }, run_dir: { type: 'string' },
    writers: { type: 'array', items: { type: 'string' } },
    generation: { type: 'integer' }, minutes_left: { type: 'number' },
    baseline: { type: 'object' }, session_base: { type: 'integer' }, verify_kind: { type: 'string' }, verifier: { type: 'boolean' }, settings: { type: 'object' },
    warnings: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
  },
  required: [],
}
const SESSION_SCHEMA = {
  type: 'object',
  properties: {
    writer_id: { type: 'string' }, session: { type: 'integer' }, run_closed: { type: 'boolean' },
    evals_this_session: { type: 'integer' }, best_metric: { type: ['number', 'null'] },
    summary: { type: 'string', maxLength: 600 },
  },
  required: ['writer_id', 'session', 'run_closed', 'evals_this_session', 'best_metric', 'summary'],
}
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    run_id: { type: 'string' }, run_dir: { type: 'string' }, winner: { type: ['object', 'null'] },
    baseline: { type: 'object' }, team: { type: 'object' }, diagnostics: { type: 'object' },
    isolation: { type: 'string' }, hints: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
  },
  required: ['run_id', 'winner', 'baseline', 'team'],
}

function initPrompt(c) {
  const input = c.resume_run_id
    ? { resume_run_id: c.resume_run_id, ...(c.recover ? { recover: true } : { budget: { minutes: c.minutes, evals: c.evals } }), ...(nGiven ? { n: c.n } : {}) }
    : { task_path: c.task, mode: c.mode, n: c.n, budget: { minutes: c.minutes, evals: c.evals }, settings: c.settings, overrides: c.overrides }
  return `Call the tool ${T}init_run exactly once with exactly these arguments:

${JSON.stringify(input)}

Then return its result as your structured output: copy run_id, run_dir, writers, generation, minutes_left, baseline, verify_kind, verifier, settings, session_base and warnings unchanged (leave out the large "config" field).
If the tool returns an object with "error", or the call fails or is denied, return {"error": "<the error code and message>"} instead.
Do not call any other tool. Do not retry. Do not read or edit files.`
}
function writerPrompt(run, id, s) {
  return `run_id: ${run.run_id}
run_dir: ${run.run_dir}
writer_id: ${id}
session: ${s}

Work according to your agent instructions.`
}
const VERIFIER_SCHEMA = {
  type: 'object',
  properties: { session: { type: 'integer' }, run_closed: { type: 'boolean' }, verdicts_this_session: { type: 'integer' }, summary: { type: 'string', maxLength: 400 } },
  required: ['session', 'run_closed', 'verdicts_this_session', 'summary'],
}
function verifierPrompt(run, s) {
  return `task: verify
run_id: ${run.run_id}
run_dir: ${run.run_dir}
session: ${s}

Work according to your agent instructions.`
}
function judgePrompt(run) {
  return `task: judge
run_id: ${run.run_id}
run_dir: ${run.run_dir}

Work according to your agent instructions. Return the report that the final confirm call gives you, unchanged.`
}
function confirmPrompt(run) {
  return `Call the tool ${T}confirm exactly once with {"run_id": ${JSON.stringify(run.run_id)}}. It can take several minutes; wait for it.
Return the JSON object it returns as your structured output, unchanged.
If it returns an object with "error", return {"run_id": ${JSON.stringify(run.run_id)}, "winner": null, "baseline": {}, "team": {}, "error": "<code and message>"}.
Do not call any other tool.`
}

phase('Init')
const run = await agent(initPrompt(cfg), { label: 'init', phase: 'Init', schema: INIT_SCHEMA })
if (!run || run.error || !run.run_id || !run.run_dir) throw new Error(`init failed: ${run ? run.error || 'no run_id returned' : 'agent returned null'}`)
for (const w of run.warnings || []) log(`warning: ${w}`)
log(`run ${run.run_id} · baseline ${run.baseline && run.baseline.metric != null ? run.baseline.metric : 'n/a'} · ${run.run_dir}`)

phase('Search')
const base = Number.isInteger(run.session_base) ? run.session_base : 0
const agentVerify = run.verify_kind === 'agent'
const verifierOn = agentVerify && run.verifier !== false
if (run.settings) log(`settings: ${Object.entries(run.settings).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
// With no evaluator, one verifier lane runs beside the writers. It never talks to them: it only records verdicts
// with the host, which pushes verified lessons. It ends when the host closes the run.
const verifierLane = !verifierOn ? null : (async () => {
  let misses = 0, sessions = 0, verdicts = 0
  for (let k = 0; k < cfg.verifier_max_sessions; k++) {
    const r = await agent(verifierPrompt(run, base + k), {
      label: `verifier s${base + k}`, phase: 'Search', agentType: cfg.verifier_type,
      schema: VERIFIER_SCHEMA, stallMs: 1800000,
    })
    if (!r) { if (++misses >= 2) break; continue }
    sessions++
    verdicts += r.verdicts_this_session || 0
    if (r.run_closed) break
  }
  return { sessions, verdicts }
})().catch(() => null)
// The roster is the host's, not this script's default: a resumed five-writer run gets five lanes, whatever n says here.
if (!Array.isArray(run.writers) || !run.writers.length || !run.writers.every(w => typeof w === 'string' && /^w\d+$/.test(w))) throw new Error('init returned no writer list; refusing to guess the roster')
const ids = run.writers
if (!cfg.resume_run_id && ids.length !== cfg.n) throw new Error(`init created ${ids.length} writers but n is ${cfg.n}`)
if (ids.length * cfg.max_sessions + cfg.verifier_max_sessions + 2 > 1000) throw new Error('writers * max_sessions + verifier sessions + 2 exceeds the 1,000-agent cap of one workflow run')
if (cfg.resume_run_id) log(`resumed with ${ids.length} writers (${ids[0]}..${ids[ids.length - 1]}), round ${(run.generation || 0) + 1}${run.minutes_left != null ? `, ${run.minutes_left} min left` : ''}`)
const lanes = await parallel(ids.map(id => async () => {
  let last = null, misses = 0, sessions = 0
  for (let k = 0; k < cfg.max_sessions; k++) {
    const s = base + k
    const r = await agent(writerPrompt(run, id, s), {
      label: `${id} s${s}`, phase: 'Search', agentType: cfg.agent_type,
      schema: SESSION_SCHEMA, stallMs: 1800000,
    })
    if (!r) { if (++misses >= 2) break; continue }
    last = r
    sessions++
    if (r.run_closed) break
  }
  return { writer_id: id, sessions, last }
}))

phase('Confirm')
// confirm closes the run, which also ends the verifier lane
const report = agentVerify
  ? await agent(judgePrompt(run), { label: 'judge', phase: 'Confirm', agentType: cfg.verifier_type, schema: REPORT_SCHEMA })
  : await agent(confirmPrompt(run), { label: 'confirm', phase: 'Confirm', schema: REPORT_SCHEMA })
const verifier = verifierLane ? await verifierLane : null
if (!report) return { error: 'confirm agent returned null', run_id: run.run_id, run_dir: run.run_dir }
return { ...report, run_dir: report.run_dir || run.run_dir, verifier, lanes: lanes.map(l => l && { writer_id: l.writer_id, sessions: l.sessions, summary: l.last ? l.last.summary : null }) }
