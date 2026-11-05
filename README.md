# Agent toolkit

Skills, protocols, and templates I use when running coding and research agents. Each directory stands on its own: point your agent at it, or copy it into your own setup.

| Directory | What it is |
|---|---|
| [exp-dashboard/](exp-dashboard/) | Skill and single-file HTML dashboard for live experiment campaigns: plan, progress, results, ops. [Demo](exp-dashboard/docs/demo.html). |
| [report-protocol/](report-protocol/) | A 30-minute reporting contract: one table for the whole wave (results or ETAs), then defaults applied versus questions that still need you. |

## Using a skill

Skill directories contain a `SKILL.md`. Copy or link the whole directory into the skill folder your agent reads, for example `~/.claude/skills/exp-dashboard`. Keep its subdirectories together, because the skill references them.

## License

[MIT](LICENSE)
