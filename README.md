# Agent toolkit

Skills, protocols, and templates I use when running coding and research agents. Each directory stands on its own: point your agent at it, or copy it into your own setup.

| Directory | What it is |
|---|---|
| [exp-dashboard/](exp-dashboard/) | Skill and single-file HTML dashboard for live experiment campaigns: plan, progress, results, ops. [Demo](exp-dashboard/docs/demo.html). |
| [report-protocol/](report-protocol/) | A 30-minute reporting contract: one table for the whole wave (results or ETAs), then defaults applied versus questions that still need you. Each report is self-contained, so you only read the latest. |
| [lessonshare/](lessonshare/) | Claude Code plugin: N isolated parallel agents work one open task and exchange short, verified lessons through a shared board. Works with an evaluator command or a verifier agent. |

## Using a skill

Skill directories contain a `SKILL.md`. Copy or link the whole directory into the skill folder your agent reads, for example `~/.claude/skills/exp-dashboard`. Keep its subdirectories together, because the skill references them.

## Using the plugin

`lessonshare/` is a Claude Code plugin, not a skill directory. This repository is also a plugin marketplace, so inside Claude Code you can install it with:

```
/plugin install lessonshare --marketplace xuanfeiren/agent-toolkit
```

Then run `/lessonshare:solve <task>`. From a local checkout, start Claude Code with `claude --plugin-dir /path/to/agent-toolkit/lessonshare` instead. See its [README](lessonshare/README.md).

## License

[MIT](LICENSE)
