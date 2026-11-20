---
name: solve
description: Put a team of subagents on one open problem. N agents attempt the same task in isolation and share only a board of short lessons; a verifier agent checks each lesson and pushes the verified ones. Works for any task: research questions, proofs, designs, analyses, puzzles, optimization. No evaluator needed.
when_to_use: Triggers include "have several agents work on this", "team of agents on this problem", "open discovery", "lessonshare this", "solve this with N agents".
argument-hint: "<the task, in your own words> [N agents] [minutes]"
---

# Put a LessonShare team on one task

You are in the main conversation. The user gives a task; you turn it into a task file, show a short summary,
and start the team. Keep it quick: ask only for what is missing and cannot be inferred.

User input: $ARGUMENTS

## How the team works (tell the user in two sentences if they have not used it before)

Every writer attempts the whole task alone in a private directory and cannot read anyone else's work. They
share one board of short prose lessons; a verifier agent checks each lesson against its author's work and only
verified lessons are pushed to the others. Lessons are length-limited and may not contain the author's result.

## 1. Decide how lessons are verified

- The task has a command that scores a result automatically (tests, a benchmark, a checker that prints a
  number): use the evaluator path. Follow `/lessonshare:plan` instead of this skill and stop here.
- Otherwise (the usual case for open problems): `verify.kind` is `"agent"`. Continue.

Do not use a team when the work splits into independent pieces (use a plain workflow fan-out), or when the
task is small enough for one agent in a few minutes.

## 2. Write `.lessonshare/task.json`

```json
{
  "name": "short-kebab-name",
  "goal": "The task, stated completely for someone with no other context. Say what to deliver and in which file(s) of the work directory.",
  "criteria": "What makes one result better than another, in priority order. The verifier and the final judge use this.",
  "context_files": ["relative/path/to/material.md"],
  "candidate": { "seed": null, "files": ["answer.md"] },
  "verify": { "kind": "agent" }
}
```

- `goal`: write it from the user's words; add the deliverable format ("keep your current best result in
  `answer.md`"). Writers see only this, `criteria` and the context files, not this conversation.
- `criteria`: required in practice. If the user gave none, propose 2-4 concrete criteria and include them in
  the summary for approval. Validity before ambition.
- `context_files`: files in the project the writers should read. Optional.
- `candidate.seed`: a directory to start every writer from. Optional; omit for an empty workspace.
- `candidate.files`: globs of what counts as the result (default: everything in the work directory).
- Writers have Read, Write, Edit, Grep, Glob and the board tools. They cannot run commands or browse. If the
  task needs that, tell the user before starting (see the README, "Giving writers Bash").

Check that `.lessonshare/runs/` is git-ignored if the project is a git repository; offer to add it.
The project directory must not be inside the plugin directory.

## 3. Size

Defaults: N = 8 writers, 60 minutes, plus one verifier. Use what the user asked for.
Mention briefly:

- N below 8: in the paper behind this design, lesson sharing did not beat the alternatives at N = 4.
- Workflows run at most `min(16, CPUs − 2)` agents at once (`nproc`). If N + 1 exceeds that, the user must
  start Claude Code with `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=<N+1>`.
- Rough cost: every writer is a full agent session for the whole duration.

## 4. Confirm and launch

Show: the goal and criteria as written, N, minutes, the team settings in one line (defaults: agents isolated,
verified lessons pushed, verifier on), and that results are judged by an agent, not measured.
After the user agrees, start the workflow `lessonshare:discover` with the Workflow tool:

```json
{ "task": ".lessonshare/task.json", "mode": "lessonshare", "n": 8, "minutes": 60, "settings": {} }
```

### Team settings

Put what the user asked for in `settings`; leave out the rest. If the user said nothing, use the defaults and
do not ask. Project-wide defaults can live in `.lessonshare/settings.json` (same keys); launch settings win.

| Setting | Values (default first) | What it does |
|---|---|---|
| `visibility` | `isolated`, `shared` | `isolated`: a writer reads only its own directory. `shared`: every checkpoint of every writer is readable by all, read-only. |
| `push` | `verified`, `all`, `none` | Which lessons are delivered to teammates with their next result: only checked ones, every lesson that is not withheld, or nothing (writers read the board themselves). |
| `verifier` | `true`, `false` | Open tasks only. `false`: no verifier agent; lessons appear at once, labelled "not checked". Needs `push` `all` or `none`. |
| `board` | `all`, `verified`, `off` | What writers may read: every visible lesson with its label, only verified ones, or no lessons at all. |
| `pull` | `true`, `false` | `false`: writers cannot page through the board; they only get what is pushed. |
| `lesson_chars` | 2000 | Maximum length of one lesson. |
| `lesson_lines` | 15 | Maximum number of non-empty lines in one lesson. |
| `copy_chars` | 40 | A lesson is rejected when it repeats this many consecutive characters of its author's result. 0 turns the check off. |
| `lessons_per_checkpoint` | 2 | Lessons one checkpoint or candidate may carry. |
| `push_batch` | 5 | At most this many lessons are delivered with one result. |
| `session_checkpoints` | 200 without an evaluator, 25 with | Checkpoints or evaluations before a writer hands off to a fresh session. |
| `keep_working` | 8 | How many times a writer that tries to return while the run is open is sent back to work. 0 lets writers end sessions freely. |
| `read_after_own_result` | `false`, `true` | Evaluator runs: the board unlocks for a writer only after its own first correct result. |

Map the user's words: "let them see each other" is `visibility: shared`; "push everything" is `push: all`;
"no pushing, they read the board" is `push: none`; "no verifier" is `verifier: false` with `push: all`;
"shorter lessons" is `lesson_chars`; "stricter about pasting the answer" is a lower `copy_chars`.

Other args: `overrides` (configuration keys, see `skills/plan/reference.md`), `resume_run_id` (reopen a run
for `minutes` more; with `"recover": true` instead, continue an open run with the deadline it has; never pass `n` with it), `mode` (`independent` for a no-sharing control run). There is one permission prompt, for
`init_run`. The workflow runs in the background; do not start it twice. The lesson board opens as a pane
beside the chat when the run starts (one card per lesson; `/lesson-board` reopens it). In a plain terminal:
`lessonshare board <run_id> --follow`. The progress list shows one row per writer session: normally N writers
plus the verifier; a new row appears only when a writer session ends and the next one takes over.

## 5. Wrap up

When the workflow returns, show: the judge's ranking with reasons, the winner's files (`winner.path`), how
many lessons were verified, partly verified, refuted and withheld, how many corrections were posted, and the
warnings. If `no_validated_winner` is true, say that the judge found no result good enough to rely on and name
the highest-ranked one (`top_ranked`); do not present it as a winner. Say plainly that the ranking and the
lesson verdicts are judgments by agents, not measurements, and that checkpoints are saved versions the host
never executed, so the user should check the result. Do not turn the counts into claims they do not support:
deliveries are not uses, the verified share is not a correctness rate, and "lexical families" counts wording,
not methods. `lessonshare report <run_id>` prints the full
report. Copy files out of the winner directory only when the user asks.

## Never

- Never apply a result to the workspace automatically.
- Never add a coordinator or let any agent rewrite, merge or summarize lessons. The verifier only gives verdicts.
- Never start before the user has seen the goal and criteria as the writers will see them.
