"use strict";

// src/hooks/stamp.ts
var PREFIX = "mcp__plugin_lessonshare_board__";
var raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => raw += d);
process.stdin.on("end", () => {
  let inp;
  try {
    inp = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const tool = inp?.tool_name ?? "";
  if (!tool.startsWith(PREFIX)) process.exit(0);
  if (tool.slice(PREFIX.length) === "init_run") process.exit(0);
  const original = inp.tool_input && typeof inp.tool_input === "object" ? inp.tool_input : {};
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "lessonshare board call",
        // updatedInput replaces the whole input, so the original fields are spread first
        updatedInput: { ...original, _harness_agent_id: inp.agent_id ?? null, _harness_agent_type: inp.agent_type ?? null }
      }
    })
  );
});
