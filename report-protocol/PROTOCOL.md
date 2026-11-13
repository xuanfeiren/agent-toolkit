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

Start with one sentence of status: since your last reply, how many experiments finished, how many are running, how many more are planned, and when everything should be done.

Then give one table covering three parts: what finished since your last reply, what is running now, and what is planned next. List them top to bottom in that order, one experiment per row:

| # | Experiment | Status | Result / ETA | Notes |
|---|---|---|---|---|
| 1 | … | ✅ done | key metrics | |
| 2 | … | ❌ failed | cause; rerun or not | |
| 3 | … | 🔄 running | progress, ETA HH:MM | |
| 4 | … | ⏳ planned | expected start and finish | |

- Finished rows (failures included) go in order of finish time and show results. Unfinished rows show an ETA, planned ones included.
- Drop anything that finished before your last reply. Anything that was running then and is still not done stays.
- Many runs from the same batch with the same config may share one row, showing done/total.
- The last row gives the expected finish time for all planned work.

Then add "Changes since your last reply": list every change in that period, most important first.

## 4. Questions for the user
- Number each question (Q1, Q2, …). List the options, and mark your default with a short reason.
- If the user has not replied 30 minutes after you ask, apply your default and keep working.
- Never apply a default for the cases below. List them, wait for the user, and keep doing other work they don't block:
  - outward-facing actions: push, open a PR, publish, or message other people. Messages between the user's own agents are not outward-facing and need no approval;
  - deleting data that cannot be recovered;
  - anything the user said they will decide themselves.

## 5. Ending of every report
Whenever any question is open, end every report with:

**Needs your reply**
1. Done by default (reversible): **every** default decision since your last reply, each with number, question, what I did, and how to undo it.
2. Still waiting on you: **every** open question, each with number, question, options, my default, and why I can't decide it myself.

After the user replies, drop the items they handled from the next report and keep listing the rest.

If nothing is open, end with "No reply needed."

If there are pinned answers (section 6), put them after this block, as the very last part of the report.

## 6. Pin answers until the user confirms seeing them
When the user sends a message between reports with a specific question, the agent answers it on the spot, but the user may already have left and never seen the answer. So:

- Pin such answers to the very end of **every** following report (after "Needs your reply" or "No reply needed") until the user confirms seeing them.
- What counts as confirmation: the user says "seen" (confirms all), or "A1 seen" (confirms just that one), or their next message clearly builds on the answer (a follow-up question, or an instruction based on it). An unrelated message from the user does not count.
- The agent decides which answers to pin. The test: **if the user never saw this answer, would they miss information they wanted, or make a wrong decision because of it?** If yes, pin it.
  - Pin: a specific fact or number ("is X done?", "what did Y score?"); a request for a cause, analysis, judgment, or recommendation; an instruction whose outcome differs from what the user expected (couldn't do it, did it differently, found a problem).
  - Don't pin: greetings and pleasantries ("hi", "thanks", "ok"); a simple instruction that was carried out and already shows in the table or "Changes"; an answer that is itself an open question — that goes under "Needs your reply" in section 5, not listed twice.

Format:

**Your earlier questions (reply "seen" once read)**
- **A1** · HH:MM <TZ> You asked: <one-line restatement of the question>
  Answer: <full answer>

- Number each item (A1, A2, …) and give the time asked, the question, and the full answer. Section 2 applies: never write "see above" or "same as my earlier reply". For long answers, give the full conclusion and key evidence, and point to a file for details.
- If things change after the answer was given (new data overturns the conclusion, an ETA moves), rewrite the pinned item with the current answer and note "(updated; originally said …)".
- After the user confirms, drop those items from the next report.

## 7. Keep going
- When the plan changes (items added, dropped, or reordered), update the table and ETAs, and note it under "Changes since your last reply".
- The user's reply overrides any default. Revert an overridden decision immediately, and say so in the next report.
