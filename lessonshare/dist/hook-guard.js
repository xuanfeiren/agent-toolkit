"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/hooks/guard.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var WRITER_TYPE = /^lessonshare[:-]writer/;
var VERIFIER_TYPE = /^lessonshare[:-]verifier/;
var READ_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob"]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit"]);
function realResolve(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (; ; ) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel);
}
function decide(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}
function findMapping(projectDir, agentId) {
  const runs = path.join(projectDir, ".lessonshare", "runs");
  let best = null;
  let bestM = -1;
  let names = [];
  try {
    names = fs.readdirSync(runs);
  } catch {
    return null;
  }
  for (const r of names) {
    const f = path.join(runs, r, "agents", agentId + ".json");
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > bestM) {
        best = JSON.parse(fs.readFileSync(f, "utf8"));
        bestM = st.mtimeMs;
      }
    } catch {
    }
  }
  return best;
}
function main(raw2) {
  const inp = JSON.parse(raw2);
  if (typeof inp.agent_type !== "string" || !(WRITER_TYPE.test(inp.agent_type) || VERIFIER_TYPE.test(inp.agent_type))) process.exit(0);
  const tool = inp.tool_name;
  const isRead = READ_TOOLS.has(tool);
  const isWrite = WRITE_TOOLS.has(tool);
  if (!isRead && !isWrite) process.exit(0);
  const agentId = String(inp.agent_id ?? "");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || inp.cwd || process.cwd();
  const map = /^[A-Za-z0-9_.-]+$/.test(agentId) ? findMapping(projectDir, agentId) : null;
  if (!map) decide("deny", VERIFIER_TYPE.test(inp.agent_type) ? "LessonShare: call a board tool (next_lesson or confirm) first. File access opens once you are registered." : "LessonShare: call the board tool join first. File access opens once your session is registered.");
  const ti = inp.tool_input ?? {};
  const target = tool === "Grep" || tool === "Glob" ? ti.path : ti.file_path;
  if (map.role === "verifier") return verifierDecision(inp, map, tool, isRead, target, agentId, projectDir);
  const allowedText = `Allowed: read and write under ${map.writer_dir}; read-only: ${[...map.context_files ?? [], ...map.shared_dir ? [map.shared_dir] : []].join(", ") || "(no context files)"}.`;
  const deny = (why, p) => {
    try {
      const now = Date.now();
      fs.appendFileSync(
        path.join(map.run_dir, "events.jsonl"),
        JSON.stringify({ t: new Date(now).toISOString(), minute: map.start_ms ? Math.round((now - map.start_ms) / 6e4 * 100) / 100 : 0, type: "guard_denied", agent_id: agentId, writer_id: map.writer_id, tool, path: p }) + "\n"
      );
    } catch {
    }
    return decide("deny", `LessonShare: ${why} ${allowedText}`);
  };
  if (typeof target !== "string" || target === "") deny(`${tool} needs an explicit absolute path${tool === "Grep" || tool === "Glob" ? ' in the "path" parameter' : ""}.`, null);
  const abs = realResolve(path.isAbsolute(target) ? target : path.resolve(inp.cwd || projectDir, target));
  const own = realResolve(map.writer_dir);
  if (inside(own, abs)) decide("allow", "own LessonShare workspace");
  if (isRead) {
    for (const c of map.context_files ?? []) if (realResolve(c) === abs) decide("allow", "task context file");
    if (map.shared_dir && inside(realResolve(map.shared_dir), abs)) decide("allow", "shared workspace (read-only)");
  }
  deny(`${isWrite ? "writing" : "reading"} ${abs} is outside your workspace.`, abs);
}
function verifierDecision(inp, map, tool, isRead, target, agentId, projectDir) {
  const scope = `Allowed: read anything under ${map.run_dir}${(map.context_files ?? []).length ? " and the context files" : ""}; write only under ${map.scratch_dir}.`;
  const deny = (why, p) => {
    try {
      const now = Date.now();
      fs.appendFileSync(path.join(map.run_dir, "events.jsonl"), JSON.stringify({ t: new Date(now).toISOString(), minute: map.start_ms ? Math.round((now - map.start_ms) / 6e4 * 100) / 100 : 0, type: "guard_denied", agent_id: agentId, writer_id: null, role: "verifier", tool, path: p }) + "\n");
    } catch {
    }
    return decide("deny", `LessonShare: ${why} ${scope}`);
  };
  if (typeof target !== "string" || target === "") deny(`${tool} needs an explicit absolute path.`, null);
  const abs = realResolve(path.isAbsolute(target) ? target : path.resolve(inp.cwd || projectDir, target));
  if (isRead) {
    if (inside(realResolve(map.run_dir), abs)) decide("allow", "LessonShare run directory (verifier)");
    for (const c of map.context_files ?? []) if (realResolve(c) === abs) decide("allow", "task context file");
    deny(`reading ${abs} is outside the run.`, abs);
  }
  if (inside(realResolve(map.scratch_dir), abs)) decide("allow", "verifier scratch directory");
  return deny(`writing ${abs} is not allowed.`, abs);
}
var raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => raw += d);
process.stdin.on("end", () => {
  try {
    main(raw);
  } catch (e) {
    process.stderr.write(`lessonshare guard error: ${e.message}
`);
    process.exit(1);
  }
});
