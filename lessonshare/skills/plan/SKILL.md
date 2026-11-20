---
name: plan
description: Plan and launch a LessonShare team run. N parallel agents each optimize the same artifact against an evaluator and share verified lessons. Use when the user wants many agents to search for a better solution to one measurable objective such as latency, score, size or pass rate.
when_to_use: Triggers include "optimize this with a team of agents", "lessonshare", "run N agents against this benchmark".
argument-hint: "[task description or path to task.json]"
---

# Plan and launch a LessonShare run

You are in the main conversation. Work through the six steps in order. Do not start the workflow before the
user has seen and confirmed the exact evaluation command (step 5).

Details live next to this file in `reference.md` (task file fields, evaluation contract, selection table,
configuration keys). Read it when you write a task file or an evaluator, or when the user asks about a setting.

User input: $ARGUMENTS

## 0. Preconditions

- Run `node --version`. The host needs Node 20 or newer. Stop and say so if it is missing.
- The CLI is `lessonshare` (on PATH inside this plugin's Bash). If the command is not found, use
  `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` instead.

## 1. Is the task a fit?

Decide with this table. If the task does not fit, explain why, name the alternative, and stop here.

| Task trait | Advice |
|---|---|
| No evaluator that automatically decides correctness and returns one number | Do not start. Help write the evaluator first, or use a plain workflow |
| Work splits up front into independent pieces (per-file migration, per-item audit) | Do not start. Use a plain workflow fan-out |
| Many independently reusable artifacts are wanted (entries of a library) | Out of scope for v1. Use a plain workflow, or run once per entry |
| Single objective, techniques can stack, evaluator exists, N ≥ 8, budget ≥ 1 hour | `lessonshare` |
| Same, but N ≤ 4 | `independent`, or suggest N = 8. Say that in the paper lessons did not win at N = 4 |
| User wants to know whether sharing pays off | Same task, same N and minutes: one `independent` run and one `lessonshare` run |
| One evaluation is slow: fewer than about a dozen evaluations per writer per hour | Warn and suggest a smaller N: the bottleneck is the evaluator, not the agents |

## 2. Task file

Default path `.lessonshare/task.json`. If it does not exist, ask the user for: goal, seed directory, files the
writers may change, evaluation command, metric name and direction, target (optional). Then write the file
(schema in `reference.md`). If the user has no evaluation command, help write one that satisfies the contract
in `reference.md`: last stdout line is a JSON object with `status` and `metric`; fresh process per run;
correctness decided by the evaluator; candidate directory read-only; noisy metrics reduced to a median inside
the evaluator; hidden test inputs never echoed in `detail`.

Check that `.lessonshare/runs/` is git-ignored; offer to add it to `.gitignore`.

## 3. Try the contract and calibrate

1. `lessonshare eval .lessonshare/task.json <seed dir>`: one evaluation, shows the host's parsed view. Fix
   contract problems until the status is `ok` (or a deliberate `incorrect`/`build_error` for a broken seed).
2. `lessonshare calibrate .lessonshare/task.json --runs 10`: prints baseline, noise, a suggested `min_gain`,
   and team evaluations per hour. If noise is not below `metric.min_gain`, tell the user and propose the
   suggested value. Change the task file only with the user's agreement.

## 4. Size and cost

Propose mode, N and minutes (defaults: `lessonshare`, 8, 120). Then tell the user:

- **Cost, order of magnitude only.** The paper measured about $36 (independent) to $48 (lessonshare) per
  writer per hour at Claude Opus 4.8 list prices (N=16, 2 h: $1,150 and $1,527 per run). Quote
  `N × hours × $36–48` and say plainly that these are the paper's model and prices; the real figure is the
  token usage shown in `/workflows`.
- **Throughput.** Evaluations per writer per hour = `3600 × eval.concurrency ÷ seconds per evaluation ÷ N`.
  The paper's writers used about 15 per hour. Warn when the local figure is clearly below that.
- **Warnings.** N < 8: lessons did not beat alternatives at N = 4 in the paper. A team evaluation cap below
  `N × 20`, or less than 60 minutes: sharing mostly paid off in the second hour.
- **Concurrency.** Workflows run at most `min(16, CPUs − 2)` agents at once. If N exceeds that (check with
  `nproc`), the user must start Claude Code with `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=<N>` or lanes
  queue and the team is effectively smaller. Always mention this for N > 16.
- **Permissions.** Writers need no rules: plugin hooks allow their board calls and their own-workspace file
  access. The one prompt during the run is `init_run`, which executes the evaluation command.

## 5. Confirm and launch

Show one summary and wait for an explicit yes:

- the evaluation command, verbatim, and its working directory
- mode, N, minutes, optional evaluation cap, any overrides
- the cost range and throughput from step 4

After the yes, start the workflow `lessonshare:discover` with the Workflow tool and these `args`:

```json
{ "task": ".lessonshare/task.json", "mode": "lessonshare", "n": 8, "minutes": 120, "evals": null, "overrides": {} }
```

Other args: `max_sessions` (default 12 writer sessions per lane), `resume_run_id` (reopen an existing run for
`minutes` more; use this when a run's wall-clock budget ran out while the workflow was paused. With `"recover": true` instead of `minutes`, an open run continues with the deadline it has. Never pass `n` with it: the run keeps its writers).
The workflow runs in the background. Do not start it twice. Tell the user they can watch `/workflows` and
`lessonshare board <run_id> --follow`.

## 6. Wrap up

When the workflow returns, show: winner (candidate, writer, confirmed metric, improvement, target reached or
not), where the winner files are (`winner.path`), the team table, and the `hints` and `warnings` from the
report. `lessonshare report <run_id>` prints the full `report.md`. Use the symptom table in `reference.md`
to explain any hint.

Copy files from the winner directory into the workspace only when the user explicitly asks.

## Never

- Never start the workflow before the user has seen and confirmed the evaluation command.
- Never apply the winner to the workspace automatically.
- Never change `min_gain` or any other threshold without telling the user.
- Never add a coordinator, a curator, or any agent that rewrites lessons.
