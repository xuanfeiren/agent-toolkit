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
    description: 'Create a LessonShare run from a task file: validates it, copies the seed to every writer, evaluates the seed for a baseline. Executes the evaluation command from the task file. Pass resume_run_id to continue an existing run instead: with recover true it keeps the deadline it has, otherwise it is reopened for budget.minutes more.',
    inputSchema: obj(
      {
        task_path: { type: 'string', description: 'Task file path relative to the project root. Default .lessonshare/task.json' },
        mode: { type: 'string', enum: ['independent', 'lessonshare', 'lessonshare-pull', 'workspace'] },
        n: { type: 'integer', description: 'Number of writers. Default 8.' },
        budget: { type: 'object', properties: { minutes: { type: ['number', 'null'] }, evals: { type: ['integer', 'null'] } } },
        settings: { type: 'object', description: 'Team switches: visibility (isolated|shared), push (verified|all|none), verifier (bool), board (all|verified|off), pull (bool), lesson_chars, lesson_lines, copy_chars, lessons_per_checkpoint, push_batch, session_checkpoints, keep_working, verified_only (bool), keep_rejected (bool), read_after_own_result (evaluator runs). Project defaults come from .lessonshare/settings.json.' },
        overrides: { type: 'object', description: 'Partial overrides of configuration keys.' },
        resume_run_id: { type: ['string', 'null'], description: 'Continue this run instead of creating one. The writers stay the ones it was created with; do not pass n.' },
        recover: { type: 'boolean', description: 'With resume_run_id: continue a run that is still open with the deadline it already has (after a crash or restart). Adds no time; safe to repeat.' },
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
    inputSchema: obj({ run_id, writer_id, note: { type: 'string', description: 'One line: what changed versus your previous candidate. Max 200 characters.' }, used_lessons: { type: 'array', items: { type: 'string' }, description: "Ids of teammates' lessons this candidate builds on, e.g. [\"L0007\"]. Leave out when none." } }, ['run_id', 'writer_id']),
  },
  {
    name: 'get_result',
    description: 'Fetch the result of an evaluation that returned status "running".',
    inputSchema: obj({ run_id, writer_id, cand_id: { type: 'string' }, wait_s: { type: 'number', description: 'Seconds to wait for the result.' } }, ['run_id', 'writer_id', 'cand_id']),
  },
  {
    name: 'post_lesson',
    description: 'Post a short prose lesson attached to one of your evaluated candidates. No code. Max 2,000 characters.',
    inputSchema: obj({ run_id, writer_id, cand_id: { type: 'string', description: 'Your evaluated candidate this lesson is about.' }, text: { type: 'string' }, corrects: { type: 'string', description: 'Id of the lesson this one corrects or retracts: one of yours, or one you received. The correction goes first to everyone who got the original.' } }, ['run_id', 'writer_id', 'cand_id', 'text']),
  },
  {
    name: 'read_lessons',
    description: "Page through teammates' lessons on the board, including failures. Keep the returned next_cursor yourself.",
    inputSchema: obj({ run_id, writer_id, cursor: { type: 'integer', description: 'next_cursor from your previous call; 0 to start.' }, limit: { type: 'integer', description: 'Default 10, max 20.' } }, ['run_id', 'writer_id']),
  },
  {
    name: 'status',
    description: 'Budget and results overview. With writer_id: that writer only. For a writer that has saved at least one checkpoint it also hands over pushed lessons that are waiting.',
    inputSchema: obj({ run_id, writer_id }, ['run_id']),
  },
  {
    name: 'confirm',
    description: 'Close the run, replay the top candidates, pick the winner and write the report. Call only when no writer is running.',
    inputSchema: obj({ run_id, top_k: { type: 'integer' }, replays: { type: 'integer' }, ranking: { type: 'array', description: 'Only for runs without an evaluator, on the second call: one row for every writer, [{writer_id, score (0 to 10), meets_bar (boolean), reason}]. With meets_bar false on every row the report names no winner.', items: { type: 'object' } } }, ['run_id']),
  },
  {
    name: 'next_lesson',
    description: 'Verifier only. Returns the next lesson that needs a verdict, with the paths of its author\'s checkpoint. Waits when none is pending.',
    inputSchema: obj({ run_id, session: { type: 'integer', description: 'Verifier session number from your starting message.' }, wait_s: { type: 'number' } }, ['run_id', 'session']),
  },
  {
    name: 'verdict',
    description: 'Verifier only. Record the verdict on one lesson. verified: you checked the claim and nothing in the lesson needs a correction (pushed to the team). partly_verified: the central claim holds but a stated detail is wrong or unchecked; the note says which (pushed, labelled). unverified: you could not confirm it. refuted: you checked and it is wrong. withheld: it hands over the result instead of an insight (hidden from the board).',
    inputSchema: obj({ run_id, lesson_id: { type: 'string' }, verdict: { type: 'string', enum: ['verified', 'partly_verified', 'unverified', 'refuted', 'withheld'] }, note: { type: 'string', description: 'One sentence: what you checked and what you found. Max 300 characters, no code.' } }, ['run_id', 'lesson_id', 'verdict', 'note']),
  },
]
