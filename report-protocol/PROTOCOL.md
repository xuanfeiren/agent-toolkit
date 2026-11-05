# Default Report Protocol

Takes effect on receipt and stays in effect until the user says stop.

## 1. Cadence
- Report every 30 minutes. Use a scheduled wakeup, not busy polling.
- State all times in one fixed timezone, and name the zone in every timestamp.

## 2. Every report is complete
- The user reads only the latest report, and it must be enough to handle everything.
- If the user has not replied since their last reply, assume they read none of the reports since then. Put everything from that period into the new report.
- Never write "same as before" or "see last report". Write the content out in full.
- Below, "last reply" means the user's most recent reply. If the user has never replied, count from when this protocol took effect.

## 3. Report format

**Report · HH:MM <TZ>**

Start with one sentence of status: how many experiments this wave has, how many are done, and when the whole wave should finish.

Then give a table of **every experiment in the current wave**, first to last, one row each:

| # | Experiment | Status | Result / ETA | Notes |
|---|---|---|---|---|
| 1 | … | ✅ done | key metrics | |
| 2 | … | 🔄 running | progress, ETA HH:MM | |
| 3 | … | ⏳ queued | ETA HH:MM | |
| 4 | … | ❌ failed | cause; rerun or not | |

- Finished rows show results. Unfinished rows show an ETA.
- The last row gives the expected finish time for the whole wave.

Then add "Changes since your last reply": list every change in that period, most important first.

## 4. Questions for the user
- Number each question (Q1, Q2, …). List the options, and mark your default with a short reason.
- If the user has not replied 30 minutes after you ask, apply your default and keep working.
- Never apply a default for the cases below. List them, wait for the user, and keep doing other work they don't block:
  - outward-facing actions: push, open a PR, publish, or message other people. Messages between the user's own agents are not outward-facing and need no approval;
  - deleting data that cannot be recovered;
  - new spending clearly beyond the original plan;
  - anything the user said they will decide themselves.

## 5. Ending of every report
Whenever any question is open, end every report with:

**Needs your reply**
1. Done by default (reversible): **every** default decision since your last reply, each with number, question, what I did, and how to undo it.
2. Still waiting on you: **every** open question, each with number, question, options, my default, and why I can't decide it myself.

After the user replies, drop the items they handled from the next report and keep listing the rest.

If nothing is open, end with "No reply needed."

## 6. Keep going
- When a new wave starts, the table switches to all experiments of the new wave.
- The user's reply overrides any default. Revert an overridden decision immediately, and say so in the next report.
