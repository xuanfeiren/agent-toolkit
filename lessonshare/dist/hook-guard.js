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
var fs2 = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));

// src/core/util.ts
var fs = __toESM(require("node:fs"));
function appendLineSync(file, obj, sync = true) {
  const fd = fs.openSync(file, "a+");
  try {
    const size = fs.fstatSync(fd).size;
    let lead = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) lead = "\n";
    }
    fs.writeSync(fd, lead + JSON.stringify(obj) + "\n");
    if (sync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// src/hooks/guard.ts
var WRITER_TYPE = /^lessonshare[:-]writer/;
var VERIFIER_TYPE = /^lessonshare[:-]verifier/;
var READ_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob"]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit"]);
function realResolve(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (; ; ) {
    try {
      return path.join(fs2.realpathSync(cur), ...tail);
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
    names = fs2.readdirSync(runs);
  } catch {
    return null;
  }
  for (const r of names) {
    const f = path.join(runs, r, "agents", agentId + ".json");
    try {
      const st = fs2.statSync(f);
      if (st.mtimeMs > bestM) {
        best = JSON.parse(fs2.readFileSync(f, "utf8"));
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
  if (tool === "StructuredOutput") return keepWorking(inp);
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
      appendLineSync(path.join(map.run_dir, "events.jsonl"), { t: new Date(now).toISOString(), minute: map.start_ms ? Math.round((now - map.start_ms) / 6e4 * 100) / 100 : 0, type: "guard_denied", agent_id: agentId, writer_id: map.writer_id, tool, path: p }, false);
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
function keepWorking(inp) {
  if (!WRITER_TYPE.test(inp.agent_type)) process.exit(0);
  const agentId = String(inp.agent_id ?? "");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || inp.cwd || process.cwd();
  const map = /^[A-Za-z0-9_.-]+$/.test(agentId) ? findMapping(projectDir, agentId) : null;
  if (!map || map.role === "verifier") process.exit(0);
  const cfg = JSON.parse(fs2.readFileSync(path.join(map.run_dir, "run.json"), "utf8")).config;
  const max = cfg.session?.keep_working ?? 0;
  if (!(max > 0)) process.exit(0);
  let open = true;
  let used = 0;
  let later = false;
  for (const line of fs2.readFileSync(path.join(map.run_dir, "events.jsonl"), "utf8").split("\n")) {
    if (!line.includes('"type":"run_') && !line.includes(map.writer_id)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "run_closed" || e.type === "run_confirmed") open = false;
    else if (e.type === "run_reopened") open = true;
    else if (e.writer_id === map.writer_id && e.type === "eval_submitted" && e.session === map.session) used++;
    else if (e.writer_id === map.writer_id && e.type === "join" && e.session > map.session) later = true;
  }
  if (!open || later || used >= cfg.session.eval_quota) process.exit(0);
  const counter = path.join(map.run_dir, "agents", agentId + ".returns");
  let n = 0;
  try {
    n = Number(fs2.readFileSync(counter, "utf8")) || 0;
  } catch {
  }
  if (n >= max) process.exit(0);
  fs2.writeFileSync(counter, String(n + 1));
  const now = Date.now();
  const left = map.start_ms && cfg.budget?.minutes ? Math.round((cfg.budget.minutes - (now - map.start_ms) / 6e4) * 10) / 10 : null;
  try {
    appendLineSync(path.join(map.run_dir, "events.jsonl"), { t: new Date(now).toISOString(), minute: map.start_ms ? Math.round((now - map.start_ms) / 6e4 * 100) / 100 : 0, type: "return_blocked", agent_id: agentId, writer_id: map.writer_id, session: map.session, count: n + 1 }, false);
  } catch {
  }
  return decide("deny", `LessonShare: the run is still open${left != null && left > 0 ? ` (about ${left} minutes left)` : ""} and your session has ${cfg.session.eval_quota - used} checkpoints left. Do not return yet. Keep working in this session: try to beat your current result, try to prove or disprove that it is the best possible, test a teammate's lesson on your own work, and record a checkpoint for each step. Return only when a tool result says budget.run_state is "closed" or session.must_hand_off is true.`);
}
function verifierDecision(inp, map, tool, isRead, target, agentId, projectDir) {
  const scope = `Allowed: read anything under ${map.run_dir}${(map.context_files ?? []).length ? " and the context files" : ""}; write only under ${map.scratch_dir}.`;
  const deny = (why, p) => {
    try {
      const now = Date.now();
      appendLineSync(path.join(map.run_dir, "events.jsonl"), { t: new Date(now).toISOString(), minute: map.start_ms ? Math.round((now - map.start_ms) / 6e4 * 100) / 100 : 0, type: "guard_denied", agent_id: agentId, writer_id: null, role: "verifier", tool, path: p }, false);
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
