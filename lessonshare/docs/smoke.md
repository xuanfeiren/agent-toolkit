# Real-agent smoke tests (M3, M4)

Claude Code 2.1.328, headless (`claude -p ... --plugin-dir <plugin> --permission-mode default
--allowedTools Workflow mcp__plugin_lessonshare_board__init_run`), writers on Claude Opus 5.5 (the session model).
Checker: `node test/smoke/check.mjs <run_dir>` (conditions of spec 14.3 and 8.4).

## Smoke run

Toy task, mode `lessonshare`, N=3, `minutes: 15`, `session.eval_quota: 8`, `stop.on_target: false`,
`max_sessions: 8`. Run `r-20261119-024549-3ec`: 1 init + 24 writer sessions + 1 confirm agent.

| Condition | Result |
|---|---|
| Workflow returns a report; winner better than baseline | PASS: 30768 → 2195 (c0131, w01), replays 2195 ×3 |
| A lesson is pushed and delivered to the other two writers | PASS: 4 pushed, all 4 delivered to both others (8 deliveries) |
| Session hand-off; next session's first candidate not worse than the previous best | PASS: 20 hand-offs, 11 started at or better than the previous best; the others started with a new idea that came out slightly worse (e.g. 2203 vs 2202), not from the seed (30768) |
| 8.4 lesson posted after verified gain before the next evaluate ≥ 80% | PASS: 4/4 |
| 8.4 lesson rejection rate < 20% | PASS: 0/28 |
| 8.4 NOTES.md has best candidate and cursor | PASS for all three writers |
| 8.4 guard denials = 0 | **FAIL: 1.** w01 read `<parent>/toy/API.md` instead of `<parent>/proj/toy/API.md`: a mistyped path to an allowed context file, correctly denied |
| M4 isolation `enforced`, no permission prompts | PASS: every session stamped; headless default-permission run never paused |
| M4 report.md has all diagnostics of 13.3 | PASS |

Notes:

- The run ended after 9.6 minutes with `closed_reason: confirm`, not at the 15-minute budget: every lane used all
  8 sessions (evaluations take 40 ms and writers are fast). For real tasks `max_sessions × eval_quota` should cover
  the time budget; the defaults give 12 × 25 = 300 evaluations per writer.
- The toy task is easy for this model: each writer found all four techniques in its first candidate (≈2250), so
  only 4 of 28 lessons were verified gains (14%). Grafting was still visible: w03's interpolation-search lesson
  (L0005, verified) was applied by w02 two candidates later.
- An earlier attempt with the project placed inside the plugin directory failed: see `docs/spikes.md`, difference 5.

## Recovery test

Toy task, N=3, `minutes: 8`, quota 8. Run `r-20261119-025558-7c2` in `proj2`.

1. The headless Claude session (and with it the board server, pid 2881897) was killed with SIGKILL after 14
   evaluations.
2. A new session started the same workflow script with `{"resume_run_id": "r-20261119-025558-7c2", "minutes": 3}`.
   The new board server (pid 2891357) logged `run loaded from disk`, took over the stale lock and reopened the
   run. Result: same `run_id`, confirmed normally, but **no new evaluations**: all writer sessions returned at once
   because they saw under 3 minutes left. The writer prompt now says that little remaining time is not a reason
   to stop.
3. Third session, `{"resume_run_id": ..., "minutes": 5, "max_sessions": 6}`: sessions numbered from
   `session_base` 5; candidates continued c0015…c0110 with no duplicate ids (110 submitted, 110 distinct);
   closed by `time`; confirmed winner c0110 at 2200.

Pass conditions (same run_id, no duplicate candidate numbers, run ends normally): **met**. This exercises the
`resume_run_id` path with a fresh Claude session. Same-session `resumeFromRunId` replay was not exercised with
real agents; its host side (idempotent `join`, exhausted sessions) is covered by unit tests.

Guard denials in the resumed run: 1, the same path slip by another writer. After that, context files are copied
into each writer's own directory (`writers/<id>/context/...`) so all paths a writer needs share one prefix.

## End-to-end through the skill (M5)

Fresh project created exactly as in the README quick start (`demo/`, toy task), then headless
`/lessonshare:plan` with N=3, 6 minutes, `stop.on_target: false`, confirmation given up front in the prompt
(allowed tools: Skill, Bash, Read, Write, Edit, Workflow, `init_run`). The skill ran the Node check,
`lessonshare eval`, `lessonshare calibrate`, printed the summary with the evaluation command, launched
`lessonshare:discover`, and presented the report.

Run `r-20261119-031327-b36`: winner 30768 → 2196 (c0067, w03), closed by `time` at 6 minutes, 126 candidates,
2 sessions per lane. `test/smoke/check.mjs`: **all 10 checks pass**, including guard denials = 0 (first run with
context files copied into the writer directories) and isolation `enforced`.

## Workspace mode with real agents

Toy task, mode `workspace`, N=3, 6 minutes (run `r-20261119-034630-c40`): winner 2193, closed by `time`,
131 lines in `shared/index.tsv`; writers read `index.tsv` 24 times and opened teammates' `solution.js` files;
guard denials 0, isolation `enforced`.

## Open task with a verifier agent (no evaluator)

`examples/toy-open` (longest divisor chain in 1..48), `verify.kind: agent`, N=4 writers + 1 verifier,
`minutes: 10`, `session.eval_quota: 10`. Run `r-20261119-234122-824`.

| Check | Result |
|---|---|
| Workflow completes: init, 4 writer lanes, verifier lane, judge | Yes. Closed by `confirm` after 8.7 min |
| Lessons invisible until a verdict; verified ones pushed | 14 posted, 14 verdicts (9 verified, 5 not verified), 9 pushed, 27 deliveries; median 0.25 min to a verdict |
| Host rejects lessons that paste the result | 4 rejections at post time (`contains_solution`) |
| Verifier withholds a lesson that hands over the result | Seen in the earlier, interrupted run `open1`: a lesson listing about 25 terms in order was `withheld`; none in this run |
| Judge ranks every writer after checking the results itself | All four finals are valid 39-term sequences (pairs and distinctness rechecked by the judge); ranked 9, 9, 8, 8 on the quality of the upper-bound argument |
| Isolation | `enforced`, guard denials 0 |

Observations:

- Writers ended sessions early once they had a 39-term sequence and an argument that 40 is impossible: each lane
  used all 12 sessions in under 9 minutes (1.7 checkpoints per session on average), so the run ended before
  its time budget. On a task the team can finish, that is the expected ending; on an open-ended task
  `max_sessions` should be sized for it.
- An earlier attempt (`open1`) was cut off at minute 4.6 by the account's usage limit, not by the plugin.

## M6 (independent vs lessonshare, N=8, 30 minutes): not completed

Three attempts, none finished: (1) and (3) were cut off after 7 to 9 minutes by the account's 5-hour usage
limit; (2) was stopped at minute 10 by headless mode's background-task ceiling
(`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, now documented in the README). No comparison data exists yet.
