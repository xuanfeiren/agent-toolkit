# Changelog

## 0.3.0 (2026-11-20)

Changes after a field report from a 5-writer, 120-minute run on an open task.

Fixed
- A reopened run reported the finals and winner of its earlier round. Finals are now frozen per result round
  (`final-<writer>-g<round>`), written atomically with a manifest, and the report is bound to them by hash.
  The earlier report is kept as `report-g<round>.md`.
- `server.lock` could be taken by two live processes at once. It is now created atomically.
- A log record cut off by a crash swallowed the next event. The torn bytes are set aside on recovery and every
  writer of the log starts on a fresh line.
- Resuming a run used the default `n` instead of the run's writers. Lanes now come from the host's roster; a
  conflicting `n` is refused (`roster_mismatch`).
- The final ranking was barely checked. The host now requires every writer exactly once, scores from 0 to 10,
  a reason, and refuses `meets_bar` for a writer without files.

Changed
- A writer's result is its last checkpoint, not whatever is in its work directory when the judge starts.
- Verdict `partly_verified`: the central claim holds, a stated detail does not; pushed with the correction.
- Lessons can correct earlier ones (`corrects`); corrections are delivered first and mark the original.
- Writers declare which lessons a checkpoint builds on (`used_lessons`); reported separately from deliveries.
- The judge can report that no result meets the bar (`no_validated_winner`).
- `recover: true` continues an open run with its existing deadline; `minutes` still reopens with new time.
- `status` hands a writer its waiting pushes (after its first checkpoint) and shows the lead who is waiting.
- Rejections name the rule and the lines or passage; `keep_rejected` keeps rejected texts for auditing.
- A line ending in `}` no longer counts as code (mathematical notation).
- Settings `verified_only` and `keep_rejected`; `read_after_own_result` is refused without an evaluator.
- Report wording: checkpoints are saved versions, verdicts and scores are agent judgments,
  `implementation_families` is now `lexical_families`, early closes and late pushes are called out.
