# report-protocol

A drop-in reporting contract for long-running agents. Every 30 minutes the agent posts:
- one table covering the whole current wave of experiments, with results for finished runs and ETAs for the rest;
- a closing list of what it decided by default and what still needs you.

When you don't answer a question within 30 minutes, the agent applies its stated default and keeps going. Outward-facing actions, irreversible deletes, and big new spend always wait for you.

- [PROTOCOL.md](PROTOCOL.md): English
- [PROTOCOL.zh.md](PROTOCOL.zh.md): 中文

## Use

Put the file where the agent can read it, then tell the agent:

> Read PROTOCOL.md and report by it from now on until I say stop.

To change the rules for every agent, edit the file and ask the agents to re-read it.

Adjust two things to taste:
- **Timezone:** the English version leaves the zone open; the Chinese version uses US Central (CST).
- **Spending threshold:** "clearly beyond the original plan" can become a fixed amount, such as $1,000.
