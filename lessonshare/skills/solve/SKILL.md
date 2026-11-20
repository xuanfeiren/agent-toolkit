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

Show: the goal and criteria as written, N, minutes, and that results are judged by an agent, not measured.
After the user agrees, start the workflow `lessonshare:discover` with the Workflow tool:

```json
{ "task": ".lessonshare/task.json", "mode": "lessonshare", "n": 8, "minutes": 60 }
```

Other args: `overrides` (configuration keys, see `skills/plan/reference.md`), `resume_run_id` (continue a run
for `minutes` more), `mode` (`independent` for a no-sharing control run). There is one permission prompt, for
`init_run`. The workflow runs in the background; do not start it twice. The user can watch with
`lessonshare board <run_id> --follow`.

## 5. Wrap up

When the workflow returns, show: the judge's ranking with reasons, the winner's files (`winner.path`), how
many lessons were verified, refuted and withheld, and the warnings. Say plainly that the winner was chosen by
a judge agent against the criteria, so the user should check it. `lessonshare report <run_id>` prints the full
report. Copy files out of the winner directory only when the user asks.

## Never

- Never apply a result to the workspace automatically.
- Never add a coordinator or let any agent rewrite, merge or summarize lessons. The verifier only gives verdicts.
- Never start before the user has seen the goal and criteria as the writers will see them.
