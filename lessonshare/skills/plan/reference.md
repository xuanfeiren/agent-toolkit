# LessonShare reference

## Task file (`.lessonshare/task.json`)

```json
{
  "name": "mla-decode",
  "goal": "Minimize kernel latency while keeping the output correct.",
  "context_files": ["docs/api.md", "reference/impl.py"],
  "candidate": { "seed": "baseline/", "files": ["kernel.py"], "max_bytes": 1048576 },
  "eval": { "command": ["python", "tools/eval.py", "--candidate", "{candidate_dir}"], "cwd": ".", "timeout_s": 600, "concurrency": 1, "precheck": null },
  "metric": { "name": "latency_ms", "direction": "min", "target": 1.9, "min_gain": 0.01 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Task name for reports |
| `goal` | yes | Task statement given verbatim to every writer |
| `context_files` | no | Reference files writers may read (spec, reference implementation, API docs), relative to the project root |
| `candidate.seed` | yes | Initial candidate directory; copied into every writer's `work/` |
| `candidate.files` | no | Globs (relative to `work/`) of files writers may change; only these are snapshotted. Default: every file in the seed |
| `candidate.max_bytes` | no | Snapshot size limit, default 1 MiB |
| `eval.command` | yes | argv array, no shell. Placeholders: `{candidate_dir}` (absolute snapshot path), `{run_dir}`, `{cand_id}` |
| `eval.cwd` | no | Working directory relative to the project root |
| `eval.timeout_s` | no | Per-evaluation timeout, default 600 |
| `eval.concurrency` | no | Evaluations running at once, default 1. Keep 1 for latency or throughput metrics |
| `eval.precheck` | no | Optional `{command, cwd, timeout_s}` run before queuing (e.g. compile only); may run in parallel; non-zero exit = `build_error` |
| `metric.name` | yes | Display name and unit |
| `metric.direction` | yes | `min` or `max` |
| `metric.target` | no | Reaching it counts as success (and closes the run unless `stop.on_target` is false) |
| `metric.min_gain` | no | Relative threshold for a verified gain, default 0.01. Must exceed evaluation noise |

All paths must stay inside the project directory. The task file is code the user agrees to execute.

### Tasks without an evaluator

Leave out `eval` (or set `"verify": {"kind": "agent"}`): lessons are then checked by the verifier agent and
results are ranked by a judge.

```json
{
  "name": "divisor-chain",
  "goal": "The task, complete for a reader with no other context. Say what to deliver and in which file.",
  "criteria": "What makes a result better, in priority order. Used by the verifier and the judge.",
  "context_files": ["problem.md"],
  "candidate": { "seed": null, "files": ["answer.md"] },
  "verify": { "kind": "agent" }
}
```

| Field | Meaning |
|---|---|
| `criteria` | How results are judged. Strongly recommended; without it only the goal is available |
| `candidate.seed` | Optional starting directory. Omitted: writers start with an empty `work/` |
| `candidate.files` | Globs of what counts as the result. Default: everything in `work/` |
| `verify.kind` | `agent` or `command`. Default: `command` when `eval.command` is set, otherwise `agent` |
| `metric` | Not used. `metric.target` and `eval.precheck` are rejected |

`evaluate` records a checkpoint (status `recorded`); checkpoints count toward `session.eval_quota` and
`budget.evals`. `confirm` freezes each writer's `work/` as `candidates/final-<writer>/` and needs a ranking.

## Evaluation contract

The last non-empty stdout line of the evaluation command is one JSON object:

```json
{"status": "ok", "metric": 1.12, "detail": "all 4 inputs match; median of 5 runs"}
```

| status | Meaning | metric | Counts toward `budget.evals` |
|---|---|---|---|
| `ok` | Built and correct | required, finite | yes |
| `incorrect` | Runs, wrong result | ignored | yes |
| `build_error` | Build/compile/load failed | ignored | no |

Non-zero exit, timeout, a last line that is not JSON, or another status: `infra_error`, retried once, never counted.
`detail` (≤ 2,000 characters) is returned to the writer verbatim: give build diagnostics, what mismatched, the
measured value. Never put hidden test inputs in it. Other output goes to `candidates/<id>/eval.log`.

The command must: decide correctness itself; run in a fresh process with no cache from earlier candidates;
treat `{candidate_dir}` as read-only; take the median of several runs itself when the metric is noisy;
defend against cheating (file/process access, cross-call caches, probing inputs, aliasing outputs).
The host does no static audit.

## Modes

| Mode | Board | Push | Shared dir | Use |
|---|---|---|---|---|
| `independent` | off | none | off | Control; choice for small N |
| `lessonshare` | on | verified gains only | off | Default |
| `lessonshare-pull` | on | none | off | Ablation |
| `workspace` | off | none | read-only copy of every evaluated candidate | Shared-workspace comparison |

## Configuration keys

Merge order: built-in defaults, task file, mode preset, `overrides` passed to the workflow. Keys marked
"spec" have no experimental backing; change them freely.

| Key | Default | Source |
|---|---|---|
| `metric.min_gain` | 0.01 | paper |
| `gate.reference` | `author_best` (or `team_best_seen`) | paper |
| `baseline_runs` | 3 | spec |
| `lesson.max_chars` / `max_lines` | 2000 / 15 | paper |
| `lesson.max_code_lines` | 3 | spec |
| `lesson.code_patterns`, `lesson.def_patterns` | built-in regex lists | spec |
| `lesson.api_patterns` | `[]` (function definition + API pattern = rejected) | paper rule, generalized |
| `lesson.max_per_candidate` | 2 | spec |
| `lesson.max_copy_chars` | 40 (0 disables): longest verbatim span a lesson may share with its author's own files | this implementation |
| `verify.kind` | `command` with an evaluator, else `agent` | this implementation |
| `verifier.session_quota` / `wait_s` / `note_max_chars` | 30 verdicts / 600 s / 300 | this implementation |
| `push.policy` | `verified` (`all`, `none` for ablation) | paper |
| `push.max_per_delivery` | 5 | spec |
| `read.require_own_correct` | false | paper config; true is an untested remedy |
| `eval.concurrency` / `timeout_s` / `block_s` | 1 / 600 / 300 | spec |
| `eval.max_pending` | 2 | paper has the limit, no value |
| `eval.max_candidates` | 384 per writer | paper |
| `candidate.max_bytes` | 1048576 | paper |
| `session.eval_quota` / `session.grace` | 25 / 3 | spec |
| `budget.minutes` / `budget.evals` | 120 / none | paper |
| `stop.on_target` | true when a target is set | spec (paper always ran full length) |
| `confirm.replays` / `top_k` / `max_candidates` | 3 / 3 / 10 | paper / spec / spec |
| `writer.extra_tools` | `[]` | spec |

## Reading the report: symptom table

| Symptom | Likely bottleneck | Try |
|---|---|---|
| Long catch-up time; winner lacks techniques peers had | Discoveries not spreading | Confirm mode is `lessonshare`; check `lesson_delivered` events |
| Very low verified rate | Few verified gains, or no lesson after them | Check "lesson after verified gain"; is `min_gain` above the real step size? |
| A direction was dropped after one negative lesson | Unverified negative claim spread | `read.require_own_correct=true`; re-read the prompt rules on negative lessons |
| High implementation similarity | Team copies one implementation | Is the guard active (`isolation: enforced`)? Not `workspace` mode? |
| Pushes delivered, nobody finds the key technique | Discovery itself | More writers or more time; the channel is not the problem |
| High evaluation queue share | Evaluator throughput | Smaller N; raise `eval.concurrency` if the metric tolerates it |

## CLI

```
lessonshare runs
lessonshare board <run_id> [--follow]
lessonshare report <run_id>
lessonshare eval <task.json> <candidate_dir>
lessonshare calibrate <task.json> [--runs 10]
```
