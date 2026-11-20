#!/usr/bin/env bash
# Set up a throwaway demo project and start a LessonShare team on it.
#
#   examples/demo.sh [open|toy] [--headless|--sdk] [--dir DIR] [-n N] [--minutes M]
#
#   open   divisor-chain puzzle, no evaluator: writers + verifier agent + judge   (default)
#   toy    API-cost optimization with a deterministic evaluator command
#
#   (default)   opens interactive Claude Code with the launch prompt typed in; you approve init_run and watch
#   --headless  runs `claude -p`, prints the final result as JSON
#   --sdk       runs examples/sdk/run.mjs (Claude Agent SDK), streaming progress and the lesson board
set -euo pipefail

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK=open; HOW=interactive; DIR=""; N=3; MIN=10
while [ $# -gt 0 ]; do
  case "$1" in
    open|toy) TASK=$1 ;;
    --headless) HOW=headless ;;
    --sdk) HOW=sdk ;;
    --dir) DIR=$2; shift ;;
    -n) N=$2; shift ;;
    --minutes) MIN=$2; shift ;;
    *) sed -n 2,12p "${BASH_SOURCE[0]}"; exit 1 ;;
  esac
  shift
done
[ "$TASK" = open ] && SRC=toy-open || SRC=toy
DIR="${DIR:-$HOME/lessonshare-demo-$TASK}"
case "$(mkdir -p "$DIR" && cd "$DIR" && pwd)/" in
  "$PLUGIN"/*) echo "The demo project must live outside the plugin directory." >&2; exit 1 ;;
esac

cd "$DIR"
[ -d .git ] || git init -q
mkdir -p .lessonshare
[ -d "$SRC" ] || cp -r "$PLUGIN/examples/$SRC" "./$SRC"
cp "$SRC/task.json" .lessonshare/task.json
grep -qs '.lessonshare/runs/' .gitignore || echo ".lessonshare/runs/" >> .gitignore

ARGS="{\"task\": \".lessonshare/task.json\", \"mode\": \"lessonshare\", \"n\": $N, \"minutes\": $MIN}"
PROMPT="Launch the workflow named \"lessonshare:discover\" with the Workflow tool, passing args $ARGS. It runs in the background for about $((MIN + 3)) minutes: wait for its completion notification (do not poll, do not start it twice). Then show the report: winner, ranking or metric, and how many lessons were posted, verified and delivered."

echo "project: $DIR"
echo "watch the board in another terminal:"
echo "  cd $DIR && $PLUGIN/bin/lessonshare runs && $PLUGIN/bin/lessonshare board <run_id> --follow"
echo

case "$HOW" in
  interactive)
    exec claude --plugin-dir "$PLUGIN" "$PROMPT" ;;
  headless)
    # Headless mode stops background workflows 10 minutes after the last turn unless the ceiling is lifted.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 exec claude -p "$PROMPT" --plugin-dir "$PLUGIN" --permission-mode default \
      --allowedTools "Workflow" "mcp__plugin_lessonshare_board__init_run" --output-format json < /dev/null ;;
  sdk)
    exec node "$PLUGIN/examples/sdk/run.mjs" --project "$DIR" -n "$N" --minutes "$MIN" ;;
esac
