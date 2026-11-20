const stamp = {
  _harness_agent_id: { type: 'string', description: 'Filled in by the host. Callers leave this empty.' },
  _harness_agent_type: { type: 'string', description: 'Filled in by the host. Callers leave this empty.' },
}
const run_id = { type: 'string', description: 'The run id given in your starting message.' }
const writer_id = { type: 'string', description: 'Your writer id, e.g. w03.' }
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: { ...properties, ...stamp }, required })

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'init_run',
    description: 'Create a LessonShare run from a task file: validates it, copies the seed to every writer, evaluates the seed for a baseline. Executes the evaluation command from the task file. Pass resume_run_id to reopen an existing run instead.',
    inputSchema: obj(
      {
        task_path: { type: 'string', description: 'Task file path relative to the project root. Default .lessonshare/task.json' },
        mode: { type: 'string', enum: ['independent', 'lessonshare', 'lessonshare-pull', 'workspace'] },
        n: { type: 'integer', description: 'Number of writers. Default 8.' },
        budget: { type: 'object', properties: { minutes: { type: ['number', 'null'] }, evals: { type: ['integer', 'null'] } } },
        overrides: { type: 'object', description: 'Partial overrides of configuration keys.' },
        resume_run_id: { type: ['string', 'null'], description: 'Reopen this run for budget.minutes more minutes instead of creating one.' },
      },
      [],
    ),
  },
  {
    name: 'join',
    description: 'Register a writer session. Call first in every session. Returns goal, work_dir, notes_path, budget and session state.',
    inputSchema: obj({ run_id, writer_id, session: { type: 'integer', description: 'Session number from your starting message.' } }, ['run_id', 'writer_id', 'session']),
  },
  {
    name: 'evaluate',
    description: 'Snapshot your work_dir and evaluate it. Blocks until the result is ready (or returns status "running" with a cand_id). In runs without an evaluator it records a checkpoint instead. The result carries lessons pushed by teammates.',
    inputSchema: obj({ run_id, writer_id, note: { type: 'string', description: 'One line: what changed versus your previous candidate. Max 200 characters.' } }, ['run_id', 'writer_id']),
  },
  {
    name: 'get_result',
    description: 'Fetch the result of an evaluation that returned status "running".',
    inputSchema: obj({ run_id, writer_id, cand_id: { type: 'string' }, wait_s: { type: 'number', description: 'Seconds to wait for the result.' } }, ['run_id', 'writer_id', 'cand_id']),
  },
  {
    name: 'post_lesson',
    description: 'Post a short prose lesson attached to one of your evaluated candidates. No code. Max 2,000 characters.',
    inputSchema: obj({ run_id, writer_id, cand_id: { type: 'string', description: 'Your evaluated candidate this lesson is about.' }, text: { type: 'string' } }, ['run_id', 'writer_id', 'cand_id', 'text']),
  },
  {
    name: 'read_lessons',
    description: "Page through teammates' lessons on the board, including failures. Keep the returned next_cursor yourself.",
    inputSchema: obj({ run_id, writer_id, cursor: { type: 'integer', description: 'next_cursor from your previous call; 0 to start.' }, limit: { type: 'integer', description: 'Default 10, max 20.' } }, ['run_id', 'writer_id']),
  },
  {
    name: 'status',
    description: 'Budget and results overview. With writer_id: that writer only.',
    inputSchema: obj({ run_id, writer_id }, ['run_id']),
  },
  {
    name: 'confirm',
    description: 'Close the run, replay the top candidates, pick the winner and write the report. Call only when no writer is running.',
    inputSchema: obj({ run_id, top_k: { type: 'integer' }, replays: { type: 'integer' }, ranking: { type: 'array', description: 'Only for runs without an evaluator, on the second call: [{writer_id, score (0-10), reason}] for every writer.', items: { type: 'object' } } }, ['run_id']),
  },
  {
    name: 'next_lesson',
    description: 'Verifier only. Returns the next lesson that needs a verdict, with the paths of its author\'s checkpoint. Waits when none is pending.',
    inputSchema: obj({ run_id, session: { type: 'integer', description: 'Verifier session number from your starting message.' }, wait_s: { type: 'number' } }, ['run_id', 'session']),
  },
  {
    name: 'verdict',
    description: 'Verifier only. Record the verdict on one lesson. verified: you checked the claim and it holds (pushed to the team). unverified: you could not confirm it. refuted: you checked and it is wrong. withheld: it hands over the result instead of an insight (hidden from the board).',
    inputSchema: obj({ run_id, lesson_id: { type: 'string' }, verdict: { type: 'string', enum: ['verified', 'unverified', 'refuted', 'withheld'] }, note: { type: 'string', description: 'One sentence: what you checked and what you found. Max 300 characters, no code.' } }, ['run_id', 'lesson_id', 'verdict', 'note']),
  },
]
