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

// src/cli/cli.ts
var fs6 = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
var path6 = __toESM(require("node:path"));

// src/core/config.ts
var fs2 = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));

// src/core/util.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var crypto = __toESM(require("node:crypto"));
var HostError = class extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
  code;
  extra;
};
var ArgError = class extends Error {
};
var realClock = { now: () => Date.now() };
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel);
}
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
function resolveInside(root, rel, what) {
  if (typeof rel !== "string" || rel === "") throw new HostError("bad_path", `${what}: empty path`);
  const abs = realResolve(path.resolve(root, rel));
  if (!isInside(realResolve(root), abs)) throw new HostError("path_escape", `${what}: "${rel}" resolves outside the project directory`);
  return abs;
}
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
function listFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}
function matchFiles(dir, globs) {
  const res = globs.map(globToRegex);
  return listFiles(dir).filter((f) => res.some((r) => r.test(f)));
}
function readBlobs(dir, rels) {
  return rels.map((rel) => ({ rel, data: fs.readFileSync(path.join(dir, rel)) }));
}
function hashBlobs(blobs) {
  const h = crypto.createHash("sha256");
  for (const b of blobs) {
    h.update(b.rel);
    h.update("\0");
    h.update(String(b.data.length));
    h.update("\0");
    h.update(b.data);
  }
  return h.digest("hex");
}
function hashDir(dir) {
  return hashBlobs(readBlobs(dir, listFiles(dir)));
}
function writeBlobs(dir, blobs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const b of blobs) {
    const dst = path.join(dir, b.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, b.data);
  }
}
function copyDir(src, dst) {
  writeBlobs(dst, readBlobs(src, listFiles(src)));
}
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
function readJsonlChecked(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch {
    return { rows: [], bad: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}
function readJsonl(file) {
  return readJsonlChecked(file).rows;
}
function repairJsonl(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { torn_bytes: 0, bad_lines: 0 };
  }
  let torn = 0;
  if (buf.length && buf[buf.length - 1] !== 10) {
    const cut = buf.lastIndexOf(10) + 1;
    const tail = buf.subarray(cut);
    let whole = true;
    try {
      JSON.parse(tail.toString("utf8"));
    } catch {
      whole = false;
    }
    if (whole) fs.appendFileSync(file, "\n");
    else {
      fs.appendFileSync(file + ".corrupt", JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), offset: cut, bytes: tail.length, base64: tail.toString("base64") }) + "\n");
      fs.truncateSync(file, cut);
      torn = tail.length;
    }
  }
  return { torn_bytes: torn, bad_lines: readJsonlChecked(file).bad };
}
function writeJson(file, obj) {
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function fmtNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
  return String(Number(x.toPrecision(4)));
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function round(x, d = 1) {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}
function isObj(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === void 0) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}
var Deferred = class {
  promise;
  resolve;
  done = false;
  constructor() {
    this.promise = new Promise((r) => {
      this.resolve = (v) => {
        this.done = true;
        r(v);
      };
    });
  }
};

// src/core/config.ts
var MODES = {
  independent: { board: { enabled: false }, push: { policy: "none" }, shared: { enabled: false } },
  lessonshare: { board: { enabled: true }, push: { policy: "verified" }, shared: { enabled: false } },
  "lessonshare-pull": { board: { enabled: true }, push: { policy: "none" }, shared: { enabled: false } },
  workspace: { board: { enabled: false }, push: { policy: "none" }, shared: { enabled: true } }
};
var DEFAULTS = {
  criteria: "",
  context_files: [],
  candidate: { seed: null, files: null, max_bytes: 1048576 },
  verify: { kind: null },
  verifier: { enabled: true, session_quota: 30, wait_s: 600, note_max_chars: 300, bash: false },
  eval: { command: null, cwd: ".", timeout_s: 600, concurrency: 1, precheck: null, precheck_concurrency: 4, block_s: 300, max_pending: 2, max_candidates: 384 },
  metric: { name: null, direction: null, target: null, min_gain: 0.01 },
  gate: { reference: "author_best" },
  baseline_runs: 3,
  lesson: {
    max_chars: 2e3,
    max_lines: 15,
    max_code_lines: 3,
    code_patterns: [
      "^\\s*(def|class|import|fn|func|function|return)\\b",
      "^\\s*from\\s+\\S+\\s+import\\b",
      "^\\s*#include\\b",
      "^\\s*(for|while|if)\\s*\\(",
      "[{;]\\s*$",
      "\\):\\s*$"
    ],
    def_patterns: ["\\b(def|fn|func|function)\\s+[A-Za-z_]\\w*\\s*\\("],
    api_patterns: [],
    max_per_candidate: 2,
    max_copy_chars: 40,
    keep_rejected: false
  },
  push: { policy: "verified", max_per_delivery: 5 },
  read: { require_own_correct: false },
  board: { enabled: true, show: "all", pull: true },
  shared: { enabled: false },
  session: { eval_quota: null, grace: 3, keep_working: 8 },
  budget: { minutes: 120, evals: null },
  stop: { on_target: null },
  confirm: { replays: 3, top_k: 3, max_candidates: 10 },
  writer: { extra_tools: [] }
};
function need(cond, msg) {
  if (!cond) throw new HostError("invalid_task", msg);
}
var isNum = (x) => typeof x === "number" && Number.isFinite(x);
var isPosInt = (x) => Number.isInteger(x) && x > 0;
function loadTaskFile(projectDir2, taskPath) {
  const abs = resolveInside(projectDir2, taskPath, "task_path");
  let raw;
  try {
    raw = fs2.readFileSync(abs, "utf8");
  } catch {
    throw new HostError("task_not_found", `cannot read task file ${taskPath}`);
  }
  try {
    const t = JSON.parse(raw);
    need(isObj(t), "task file must be a JSON object");
    return t;
  } catch (e) {
    if (e instanceof HostError) throw e;
    throw new HostError("invalid_task", `task file is not valid JSON: ${e.message}`);
  }
}
var SETTINGS = {
  visibility: { values: '"isolated" | "shared"', doc: "isolated: a writer reads only its own directory. shared: every checkpoint of every writer is readable by all (read-only).", to: (v) => (oneOf(v, ["isolated", "shared"], "visibility"), { shared: { enabled: v === "shared" } }) },
  push: { values: '"verified" | "all" | "none"', doc: "Which lessons are delivered to teammates with their next result. verified: only checked ones. all: every lesson that is not withheld. none: nothing is delivered; writers read the board themselves.", to: (v) => (oneOf(v, ["verified", "all", "none"], "push"), { push: { policy: v } }) },
  verifier: { values: "true | false", doc: 'Tasks without an evaluator only. false: no verifier agent; lessons appear on the board at once, labelled "not checked".', to: (v) => (bool(v, "verifier"), { verifier: { enabled: v } }) },
  board: { values: '"all" | "verified" | "off"', doc: "What writers may read on the board. all: every visible lesson with its label. verified: only verified ones. off: no lessons at all (independent writers).", to: (v) => (oneOf(v, ["all", "verified", "off"], "board"), { board: { enabled: v !== "off", show: v === "verified" ? "verified" : "all" } }) },
  pull: { values: "true | false", doc: "false: writers cannot page through the board; they only get what is pushed.", to: (v) => (bool(v, "pull"), { board: { pull: v } }) },
  lesson_chars: { values: "integer", doc: "Maximum length of one lesson in characters (default 2000).", to: (v) => (posInt(v, "lesson_chars"), { lesson: { max_chars: v } }) },
  lesson_lines: { values: "integer", doc: "Maximum number of non-empty lines in one lesson (default 15).", to: (v) => (posInt(v, "lesson_lines"), { lesson: { max_lines: v } }) },
  copy_chars: { values: "integer", doc: "A lesson is rejected when it repeats this many consecutive characters of its author's own result (default 40; 0 turns the check off).", to: (v) => (nonNegInt(v, "copy_chars"), { lesson: { max_copy_chars: v } }) },
  lessons_per_checkpoint: { values: "integer", doc: "How many lessons one checkpoint or candidate may carry (default 2).", to: (v) => (posInt(v, "lessons_per_checkpoint"), { lesson: { max_per_candidate: v } }) },
  push_batch: { values: "integer", doc: "At most this many lessons are delivered with one result (default 5).", to: (v) => (posInt(v, "push_batch"), { push: { max_per_delivery: v } }) },
  session_checkpoints: { values: "integer", doc: "Evaluations or checkpoints per writer session before it hands off to a fresh session (default 25 with an evaluator, 200 without).", to: (v) => (posInt(v, "session_checkpoints"), { session: { eval_quota: v } }) },
  keep_working: { values: "integer", doc: "How many times a writer that tries to return while the run is open is sent back to work (default 8; 0 lets writers end sessions freely).", to: (v) => (nonNegInt(v, "keep_working"), { session: { keep_working: v } }) },
  verified_only: { values: "true", doc: 'One switch for the strict policy: only verified lessons are pushed and only verified lessons are readable on the board. Same as push "verified" with board "verified".', to: (v) => v === true ? { push: { policy: "verified" }, board: { enabled: true, show: "verified" } } : bool(v, "verified_only") ?? {} },
  keep_rejected: { values: "true | false", doc: "true: the text of every lesson the host rejects is kept in rejected.jsonl in the run directory, for auditing the filter (default false: a rejected text may contain the author's result).", to: (v) => (bool(v, "keep_rejected"), { lesson: { keep_rejected: v } }) },
  read_after_own_result: { values: "true | false", doc: "true: the board unlocks for a writer only after it has a correct result of its own (evaluator runs).", to: (v) => (bool(v, "read_after_own_result"), { read: { require_own_correct: v } }) }
};
function oneOf(v, vals, k) {
  if (!vals.includes(v)) throw new ArgError(`settings.${k} must be one of ${vals.join(", ")}`);
}
function bool(v, k) {
  if (typeof v !== "boolean") throw new ArgError(`settings.${k} must be true or false`);
}
function posInt(v, k) {
  if (!Number.isInteger(v) || v < 1) throw new ArgError(`settings.${k} must be a positive integer`);
}
function nonNegInt(v, k) {
  if (!Number.isInteger(v) || v < 0) throw new ArgError(`settings.${k} must be a non-negative integer`);
}
function settingsToOverrides(settings) {
  if (settings == null) return {};
  if (!isObj(settings)) throw new ArgError("settings must be an object");
  let out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (v === null || v === void 0) continue;
    if (!(k in SETTINGS)) throw new ArgError(`unknown setting "${k}"; settings are: ${Object.keys(SETTINGS).join(", ")}`);
    out = deepMerge(out, SETTINGS[k].to(v));
  }
  return out;
}
function effectiveSettings(cfg) {
  return {
    visibility: cfg.shared.enabled ? "shared" : "isolated",
    push: cfg.board.enabled ? cfg.push.policy : "none",
    verification: cfg.verify.kind === "command" ? "evaluator" : cfg.verifier.enabled ? "verifier agent" : "none",
    board: !cfg.board.enabled ? "off" : cfg.board.show,
    pull: cfg.board.enabled && cfg.board.pull,
    lesson_chars: cfg.lesson.max_chars,
    lesson_lines: cfg.lesson.max_lines,
    copy_chars: cfg.lesson.max_copy_chars,
    lessons_per_checkpoint: cfg.lesson.max_per_candidate,
    push_batch: cfg.push.max_per_delivery,
    session_checkpoints: cfg.session.eval_quota,
    keep_working: cfg.session.keep_working,
    keep_rejected: cfg.lesson.keep_rejected
  };
}
function buildConfig(projectDir2, task, mode, n, budget, overrides, settings = null) {
  if (!(mode in MODES)) throw new ArgError(`unknown mode "${mode}"; expected one of ${Object.keys(MODES).join(", ")}`);
  if (!isPosInt(n) || n > 99) throw new ArgError("n must be an integer between 1 and 99");
  let cfg = deepMerge(structuredClone(DEFAULTS), structuredClone(task));
  cfg = deepMerge(cfg, MODES[mode]);
  cfg = deepMerge(cfg, settingsToOverrides(settings));
  if (isObj(budget)) cfg = deepMerge(cfg, { budget: Object.fromEntries(Object.entries(budget).filter(([, v]) => v !== null && v !== void 0)) });
  cfg = deepMerge(cfg, overrides);
  cfg.mode = mode;
  cfg.n = n;
  validateConfig(projectDir2, cfg);
  return cfg;
}
function validateConfig(projectDir2, cfg) {
  need(typeof cfg.name === "string" && cfg.name, "name is required");
  need(typeof cfg.goal === "string" && cfg.goal, "goal is required");
  need(Array.isArray(cfg.context_files) && cfg.context_files.every((f) => typeof f === "string"), "context_files must be an array of strings");
  for (const f of cfg.context_files) resolveInside(projectDir2, f, "context_files");
  need(typeof cfg.criteria === "string", "criteria must be a string");
  need(isObj(cfg.verify), "verify must be an object");
  need(isObj(cfg.eval), "eval must be an object");
  if (cfg.verify.kind == null) cfg.verify.kind = cfg.eval.command != null ? "command" : "agent";
  need(cfg.verify.kind === "command" || cfg.verify.kind === "agent", 'verify.kind must be "command" or "agent"');
  const agentMode = cfg.verify.kind === "agent";
  need(isObj(cfg.candidate), "candidate must be an object");
  if (!agentMode) need(typeof cfg.candidate.seed === "string", "candidate.seed is required when an evaluation command is used");
  if (cfg.candidate.seed != null) {
    need(typeof cfg.candidate.seed === "string", "candidate.seed must be a path");
    const seedAbs = resolveInside(projectDir2, cfg.candidate.seed, "candidate.seed");
    need(fs2.existsSync(seedAbs) && fs2.statSync(seedAbs).isDirectory(), `candidate.seed "${cfg.candidate.seed}" is not a directory`);
    if (cfg.candidate.files == null) cfg.candidate.files = agentMode ? ["**"] : listFiles(seedAbs);
  } else if (cfg.candidate.files == null) cfg.candidate.files = ["**"];
  need(Array.isArray(cfg.candidate.files) && cfg.candidate.files.length > 0 && cfg.candidate.files.every((f) => typeof f === "string"), "candidate.files must be a non-empty array of globs");
  for (const g of cfg.candidate.files) {
    if (path2.isAbsolute(g) || g.split(/[\\/]/).includes("..")) throw new HostError("path_escape", `candidate.files: "${g}" must stay inside the work directory`);
  }
  need(isPosInt(cfg.candidate.max_bytes), "candidate.max_bytes must be a positive integer");
  if (!agentMode) validateEvalSpec(projectDir2, cfg.eval, "eval");
  else {
    need(cfg.eval.precheck == null, 'eval.precheck needs an evaluation command (verify.kind "command")');
    if (cfg.metric.name == null) cfg.metric.name = "score";
    if (cfg.metric.direction == null) cfg.metric.direction = "max";
    need(cfg.metric.target == null, 'metric.target needs an evaluation command (verify.kind "command")');
  }
  if (cfg.eval.precheck != null) {
    need(isObj(cfg.eval.precheck), "eval.precheck must be an object or null");
    cfg.eval.precheck = { cwd: cfg.eval.cwd, timeout_s: cfg.eval.timeout_s, ...cfg.eval.precheck };
    validateEvalSpec(projectDir2, cfg.eval.precheck, "eval.precheck");
  }
  for (const k of ["concurrency", "precheck_concurrency", "max_pending", "max_candidates"]) need(isPosInt(cfg.eval[k]), `eval.${k} must be a positive integer`);
  need(isNum(cfg.eval.block_s) && cfg.eval.block_s >= 0, "eval.block_s must be a non-negative number");
  need(isObj(cfg.metric) && typeof cfg.metric.name === "string" && cfg.metric.name, "metric.name is required");
  need(cfg.metric.direction === "min" || cfg.metric.direction === "max", 'metric.direction must be "min" or "max"');
  need(cfg.metric.target == null || isNum(cfg.metric.target), "metric.target must be a number");
  if (cfg.metric.target === void 0) cfg.metric.target = null;
  need(isNum(cfg.metric.min_gain) && cfg.metric.min_gain >= 0, "metric.min_gain must be a non-negative number");
  need(["author_best", "team_best_seen"].includes(cfg.gate.reference), "gate.reference must be author_best or team_best_seen");
  need(isPosInt(cfg.baseline_runs), "baseline_runs must be a positive integer");
  for (const k of ["max_chars", "max_lines", "max_code_lines", "max_per_candidate"]) need(isPosInt(cfg.lesson[k]), `lesson.${k} must be a positive integer`);
  need(Number.isInteger(cfg.lesson.max_copy_chars) && cfg.lesson.max_copy_chars >= 0, "lesson.max_copy_chars must be a non-negative integer (0 disables the check)");
  for (const k of ["session_quota", "wait_s", "note_max_chars"]) need(isPosInt(cfg.verifier[k]), `verifier.${k} must be a positive integer`);
  need(typeof cfg.verifier.bash === "boolean", "verifier.bash must be boolean");
  for (const k of ["code_patterns", "def_patterns", "api_patterns"]) {
    need(Array.isArray(cfg.lesson[k]), `lesson.${k} must be an array of regular expressions`);
    for (const p of cfg.lesson[k]) {
      try {
        new RegExp(p);
      } catch {
        throw new HostError("invalid_task", `lesson.${k}: invalid regular expression ${JSON.stringify(p)}`);
      }
    }
  }
  need(["verified", "all", "none"].includes(cfg.push.policy), "push.policy must be verified, all or none");
  need(isObj(cfg.board) && typeof cfg.board.enabled === "boolean" && typeof cfg.board.pull === "boolean" && ["all", "verified"].includes(cfg.board.show), "board must be {enabled, show: all|verified, pull}");
  need(typeof cfg.verifier.enabled === "boolean", "verifier.enabled must be boolean");
  if (cfg.session.eval_quota == null) cfg.session.eval_quota = agentMode ? 200 : 25;
  if (agentMode && !cfg.verifier.enabled && cfg.board.enabled && cfg.push.policy === "verified") throw new HostError("invalid_task", 'With the verifier off nothing can be verified, so push "verified" would never deliver a lesson. Set push to "all" or "none", or keep the verifier on.');
  if (agentMode && !cfg.verifier.enabled && cfg.board.enabled && cfg.board.show === "verified") throw new HostError("invalid_task", 'With the verifier off no lesson is ever verified, so board "verified" would stay empty. Set board to "all" or "off", or keep the verifier on.');
  need(isPosInt(cfg.push.max_per_delivery), "push.max_per_delivery must be a positive integer");
  need(typeof cfg.read.require_own_correct === "boolean", "read.require_own_correct must be boolean");
  need(typeof cfg.lesson.keep_rejected === "boolean", "lesson.keep_rejected must be boolean");
  if (agentMode && cfg.read.require_own_correct) throw new HostError("invalid_task", "read_after_own_result needs an evaluator: without one no result is ever marked correct, so the board would stay locked for the whole run. Leave it off. Pushes already wait for a writer's first checkpoint in runs without an evaluator.");
  need(isPosInt(cfg.session.eval_quota), "session.eval_quota must be a positive integer");
  need(Number.isInteger(cfg.session.grace) && cfg.session.grace >= 0, "session.grace must be a non-negative integer");
  need(Number.isInteger(cfg.session.keep_working) && cfg.session.keep_working >= 0, "session.keep_working must be a non-negative integer");
  need(isNum(cfg.budget.minutes) && cfg.budget.minutes > 0, "budget.minutes must be a positive number");
  need(cfg.budget.evals == null || isPosInt(cfg.budget.evals), "budget.evals must be a positive integer or null");
  if (cfg.budget.evals === void 0) cfg.budget.evals = null;
  if (cfg.stop.on_target == null) cfg.stop.on_target = cfg.metric.target != null;
  need(typeof cfg.stop.on_target === "boolean", "stop.on_target must be boolean");
  for (const k of ["replays", "top_k", "max_candidates"]) need(isPosInt(cfg.confirm[k]), `confirm.${k} must be a positive integer`);
  need(Array.isArray(cfg.writer.extra_tools), "writer.extra_tools must be an array");
}
function validateEvalSpec(projectDir2, spec, what) {
  need(Array.isArray(spec.command) && spec.command.length > 0 && spec.command.every((a) => typeof a === "string"), `${what}.command must be a non-empty argv array of strings`);
  need(typeof spec.cwd === "string", `${what}.cwd must be a string`);
  resolveInside(projectDir2, spec.cwd, `${what}.cwd`);
  need(isNum(spec.timeout_s) && spec.timeout_s > 0, `${what}.timeout_s must be a positive number`);
}
function writerIds(n) {
  return Array.from({ length: n }, (_, i) => `w${String(i + 1).padStart(2, "0")}`);
}

// src/core/host.ts
var fs5 = __toESM(require("node:fs"));
var path5 = __toESM(require("node:path"));
var crypto2 = __toESM(require("node:crypto"));
var import_node_child_process2 = require("node:child_process");

// src/core/evalcmd.ts
var import_node_child_process = require("node:child_process");
var MAX_CAPTURE = 1 << 20;
var MAX_LOG = 2e5;
var MAX_DETAIL = 2e3;
function substitute(argv, vars) {
  return argv.map((a) => a.replace(/\{(candidate_dir|run_dir|cand_id)\}/g, (_, k) => vars[k] ?? ""));
}
function tailLines(s, n) {
  return s.split("\n").slice(-n).join("\n");
}
function parseEvalOutput(stdout) {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return { status: "infra_error", metric: null, detail: "evaluator printed nothing on stdout" };
  let obj;
  try {
    obj = JSON.parse(lines[lines.length - 1]);
  } catch {
    return { status: "infra_error", metric: null, detail: "last stdout line of the evaluator is not valid JSON" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { status: "infra_error", metric: null, detail: "last stdout line of the evaluator is not a JSON object" };
  let detail = typeof obj.detail === "string" ? obj.detail : "";
  if (detail.length > MAX_DETAIL) detail = detail.slice(0, MAX_DETAIL);
  if (obj.status === "ok") {
    if (typeof obj.metric !== "number" || !Number.isFinite(obj.metric)) return { status: "infra_error", metric: null, detail: "status ok without a finite numeric metric" };
    return { status: "ok", metric: obj.metric, detail };
  }
  if (obj.status === "incorrect" || obj.status === "build_error") return { status: obj.status, metric: null, detail };
  return { status: "infra_error", metric: null, detail: `unknown status ${JSON.stringify(obj.status)}` };
}
function runCommand(spec, cwdAbs, vars) {
  return new Promise((resolve5) => {
    const argv = substitute(spec.command, vars);
    const t0 = Date.now();
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let log = `$ ${argv.join(" ")}
--- stdout ---
${out}
--- stderr ---
${err}
`;
      if (log.length > MAX_LOG) log = log.slice(0, MAX_LOG / 2) + "\n...[truncated]...\n" + log.slice(-MAX_LOG / 2);
      resolve5({ ...o, eval_s: (Date.now() - t0) / 1e3, log });
    };
    let child;
    try {
      child = (0, import_node_child_process.spawn)(argv[0], argv.slice(1), { cwd: cwdAbs, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      return resolve5({ status: "infra_error", metric: null, detail: `failed to start evaluator: ${e.message}`, eval_s: 0, log: String(e) });
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    }, spec.timeout_s * 1e3);
    child.stdout.on("data", (d) => {
      if (out.length < MAX_CAPTURE) out += d;
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_CAPTURE) err += d;
    });
    child.on("error", (e) => finish({ status: "infra_error", metric: null, detail: `failed to start evaluator: ${e.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ status: "infra_error", metric: null, detail: `evaluator timed out after ${spec.timeout_s}s` });
      if (code !== 0) return finish({ status: "infra_error", metric: null, detail: `evaluator exited with ${signal ? "signal " + signal : "code " + code}` });
      finish(parseEvalOutput(out));
    });
  });
}
function interpretPrecheck(o) {
  if (o.status === "ok") return { pass: true, detail: "" };
  if (o.status === "build_error" || o.status === "incorrect") return { pass: false, detail: o.detail };
  if (/not valid JSON|printed nothing|not a JSON object|unknown status|without a finite/.test(o.detail)) return { pass: true, detail: "" };
  return { pass: false, detail: (o.detail + "\n" + tailLines(o.log, 20)).slice(0, MAX_DETAIL) };
}

// src/core/run.ts
var fs4 = __toESM(require("node:fs"));
var path4 = __toESM(require("node:path"));

// src/core/lesson.ts
var REJECT_MESSAGE = "Lessons are short prose. State the design insight and its measured effect in words, without code.";
var codeLineNumbers = (text, lc) => {
  const code = lc.code_patterns.map((p) => new RegExp(p));
  const out = [];
  text.split("\n").forEach((l, i) => {
    if (l.trim() !== "" && code.some((r) => r.test(l))) out.push(i + 1);
  });
  return out;
};
function validateLessonText(text, lc) {
  if (text.length > lc.max_chars) return "too_long";
  if (text.includes("```") || text.includes("~~~")) return "code_block";
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > lc.max_lines) return "too_many_lines";
  if (codeLineNumbers(text, lc).length >= lc.max_code_lines) return "looks_like_code";
  const hasDef = lc.def_patterns.some((p) => new RegExp(p).test(text));
  const hasApi = lc.api_patterns.some((p) => new RegExp(p).test(text));
  if (hasDef && hasApi) return "looks_like_code";
  return null;
}
function explainReject(code, text, lc) {
  if (code === "too_long") return { rule: `lesson_chars=${lc.max_chars}`, lines: [], message: `The lesson has ${text.length} characters; the limit is ${lc.max_chars}. Cut it down to the insight.` };
  if (code === "too_many_lines") return { rule: `lesson_lines=${lc.max_lines}`, lines: [], message: `The lesson has ${text.split("\n").filter((l) => l.trim() !== "").length} non-empty lines; the limit is ${lc.max_lines}. Join lines into sentences.` };
  if (code === "code_block") return { rule: "code_block", lines: [], message: "The lesson contains a fenced block (``` or ~~~). Lessons are prose: say it in words." };
  const lines = codeLineNumbers(text, lc);
  if (lines.length >= lc.max_code_lines) return { rule: `max_code_lines=${lc.max_code_lines}`, lines, message: `Lines ${lines.join(", ")} of your lesson look like code or raw notation to the filter (they start with a keyword such as def/return/import, or end with "{" or ";" or "):"). ${lines.length} such lines reach the limit of ${lc.max_code_lines}. Rewrite those lines as sentences; formulas inside a sentence are fine.` };
  return { rule: "definition_with_api_call", lines: [], message: REJECT_MESSAGE };
}
function lessonHeader(writerId, candId, ev, metric) {
  const parts = [writerId, candId, ev.status];
  if (ev.status === "ok" && ev.metric != null) {
    if (ev.reference != null && ev.gain != null) {
      const pct2 = Math.abs(ev.gain * 100).toFixed(1);
      const word = ev.gain > 0 ? "better" : ev.gain < 0 ? "worse" : "same";
      parts.push(`${metric.name} ${fmtNum(ev.reference)} \u2192 ${fmtNum(ev.metric)} (${word === "same" ? "no change" : pct2 + "% " + word})`);
    } else parts.push(`${metric.name} ${fmtNum(ev.metric)}`);
    parts.push(ev.verified_gain ? "verified gain" : "no gain");
  }
  return "[" + parts.join(" \xB7 ") + "]";
}
var squash = (t) => t.replace(/\s+/g, " ").trim();
function copiedSpan(text, workTexts, minChars) {
  if (minChars <= 0) return null;
  const lesson = squash(text);
  if (lesson.length < minChars) return null;
  const hay = workTexts.map(squash).filter((w) => w.length >= minChars);
  if (!hay.length) return null;
  const step = Math.max(1, Math.floor(minChars / 10));
  const hit = (i) => {
    const win = lesson.slice(i, i + minChars);
    return hay.some((w) => w.includes(win)) ? { at: i, excerpt: win.slice(0, 30) } : null;
  };
  for (let i = 0; i + minChars <= lesson.length; i += step) {
    const h = hit(i);
    if (h) return h;
  }
  return hit(lesson.length - minChars);
}
var COPY_MESSAGE = "A lesson must not paste your own result. Describe the insight in your own words: what you tried, why it works, what you measured or checked. Teammates should be able to apply the idea, not copy the answer.";
function verdictHeader(writerId, candId, verdict, note) {
  const label = { pending: "pending verification", verified: "verified by verifier", partly_verified: "PARTLY verified by verifier, read the correction", unverified: "not verified", refuted: "refuted by verifier", withheld: "withheld", unchecked: "not checked" }[verdict];
  return "[" + [writerId, candId, note ? `${label}: ${note}` : label].join(" \xB7 ") + "]";
}

// src/core/report.ts
var fs3 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));
var pct = (x) => x == null || !Number.isFinite(x) ? "n/a" : (x * 100).toFixed(1) + "%";
function codeLineSet(dir) {
  const set = /* @__PURE__ */ new Set();
  for (const f of listFiles(dir)) {
    let txt;
    try {
      txt = fs3.readFileSync(path3.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const raw of txt.split("\n")) {
      const l = raw.trim();
      if (!l || l.startsWith("#") || l.startsWith("//") || l.startsWith("/*") || l.startsWith("*") || l.startsWith("--")) continue;
      set.add(l);
    }
  }
  return set;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function buildReport(runDir2) {
  const rf = readJson(path3.join(runDir2, "run.json"));
  const cfg = rf.config;
  const events = readJsonl(path3.join(runDir2, "events.jsonl"));
  const dir = cfg.metric.direction;
  const better = (a, b) => dir === "min" ? a < b : a > b;
  const within = (m, best, tol) => dir === "min" ? m <= best * (1 + tol) : m >= best * (1 - tol);
  const relGain = (from, to) => from === 0 ? 0 : dir === "min" ? (from - to) / from : (to - from) / Math.abs(from);
  const W = {};
  for (const id of rf.writers) W[id] = { writer_id: id, best_metric: null, best_cand: null, evals: 0, sessions: 0, lessons_posted: 0, lessons_pushed: 0, read_chars: 0, _sessions: /* @__PURE__ */ new Set(), _bestTimeline: [] };
  const evals = { ok: 0, incorrect: 0, build_error: 0, infra_error: 0 };
  const agentMode = cfg.verify?.kind === "agent";
  const lessons = { posted: 0, pushed: 0, rejected: 0, delivered: 0 };
  const verdicts = { verified: 0, partly_verified: 0, unverified: 0, refuted: 0, withheld: 0 };
  const rejectedBy = {};
  const pushedAt = {};
  const deliveredPairs = /* @__PURE__ */ new Set();
  const deliveryWait = [];
  const usedPairs = /* @__PURE__ */ new Set();
  const corrections = [];
  const lastEvalMinute = {};
  let generation = 0;
  let deadlineMs = 0;
  let closedMs = 0;
  let logRepairs = 0;
  const verdictDelay = [];
  const postedAt = {};
  const timeline = [];
  const candWriter = {};
  const results = {};
  const sessionEvals = {};
  let closedReason = null;
  let lastMinute = 0;
  let queueS = 0;
  let evalS = 0;
  let reads = 0;
  let readsNoCorrect = 0;
  let guardDenied = 0;
  let stampMissing = 0;
  let joinsWithAgent = 0;
  let confirmedEv = null;
  let gainsTotal = 0;
  let gainsFollowed = 0;
  const awaitingLesson = {};
  const replays = {};
  const hasOk = {};
  const lastCheckpoint = {};
  const postedLessonCands = /* @__PURE__ */ new Set();
  const lessonAt = [];
  events.forEach((e, idx) => {
    if (e.type === "lesson_posted") lessonAt.push({ writer: e.writer_id, cand: e.cand_id, idx });
  });
  events.forEach((e, idx) => {
    if (typeof e.minute === "number" && e.minute > lastMinute && e.type !== "confirm_replay" && e.type !== "run_confirmed") lastMinute = e.minute;
    switch (e.type) {
      case "join":
        if (W[e.writer_id]) W[e.writer_id]._sessions.add(e.session);
        if (e.agent_id) joinsWithAgent++;
        break;
      case "stamp_missing":
        stampMissing++;
        break;
      case "guard_denied":
        guardDenied++;
        break;
      case "run_init":
        deadlineMs = Date.parse(e.t) + cfg.budget.minutes * 6e4;
        break;
      case "log_repaired":
        logRepairs++;
        break;
      case "lessons_used":
        for (const id of e.lesson_ids ?? []) usedPairs.add(`${e.writer_id}/${id}`);
        break;
      case "eval_submitted":
        candWriter[e.cand_id] = e.writer_id;
        lastEvalMinute[e.writer_id] = e.minute;
        if (awaitingLesson[e.writer_id]) {
          const cand = awaitingLesson[e.writer_id];
          if (lessonAt.some((l) => l.cand === cand && l.idx < idx)) gainsFollowed++;
          awaitingLesson[e.writer_id] = null;
        }
        break;
      case "eval_result": {
        results[e.cand_id] = e;
        const w = W[e.writer_id];
        if (!w) break;
        evals[e.status] = (evals[e.status] ?? 0) + 1;
        w.evals++;
        const key = `${e.writer_id}/s${e.session}`;
        sessionEvals[key] = (sessionEvals[key] ?? 0) + 1;
        queueS += e.queue_wait_s ?? 0;
        evalS += e.eval_s ?? 0;
        if (e.status === "ok" || e.status === "recorded") hasOk[e.writer_id] = true;
        if (e.status === "recorded") lastCheckpoint[e.writer_id] = e.cand_id;
        if (e.is_own_best) {
          w.best_metric = e.metric;
          w.best_cand = e.cand_id;
          w._bestTimeline.push({ minute: e.minute, metric: e.metric });
        }
        if (e.is_team_best) timeline.push({ minute: e.minute, metric: e.metric, writer_id: e.writer_id, cand_id: e.cand_id });
        if (e.verified_gain && cfg.board.enabled) {
          gainsTotal++;
          awaitingLesson[e.writer_id] = e.cand_id;
        }
        break;
      }
      case "lesson_posted":
        lessons.posted++;
        postedAt[e.lesson_id] = e.minute;
        postedLessonCands.add(e.cand_id);
        if (W[e.writer_id]) {
          W[e.writer_id].lessons_posted++;
          if (e.pushed) W[e.writer_id].lessons_pushed++;
        }
        if (e.pushed) {
          lessons.pushed++;
          pushedAt[e.lesson_id] = { minute: e.minute, writer: e.writer_id };
        }
        if (e.corrects) corrections.push({ lesson_id: e.lesson_id, corrects: e.corrects, writer_id: e.writer_id });
        break;
      case "lesson_rejected":
        lessons.rejected++;
        rejectedBy[e.error] = (rejectedBy[e.error] ?? 0) + 1;
        break;
      case "lesson_verdict":
        verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1;
        if (e.pushed) {
          lessons.pushed++;
          pushedAt[e.lesson_id] = { minute: e.minute, writer: e.writer_id };
          if (W[e.writer_id]) W[e.writer_id].lessons_pushed++;
        }
        if (postedAt[e.lesson_id] != null) verdictDelay.push(Math.max(0, e.minute - postedAt[e.lesson_id]));
        break;
      case "lesson_delivered":
        lessons.delivered++;
        deliveredPairs.add(`${e.to}/${e.lesson_id}`);
        if (pushedAt[e.lesson_id]) deliveryWait.push(Math.max(0, e.minute - pushedAt[e.lesson_id].minute));
        if (W[e.to]) W[e.to].read_chars += e.chars ?? 0;
        break;
      case "lessons_read":
        reads++;
        if (!hasOk[e.writer_id]) readsNoCorrect++;
        if (W[e.writer_id]) W[e.writer_id].read_chars += e.chars ?? 0;
        break;
      case "run_closed":
        closedReason = e.reason;
        closedMs = Date.parse(e.t);
        break;
      case "run_reopened":
        closedReason = null;
        confirmedEv = null;
        generation++;
        deadlineMs = Date.parse(e.t) + (e.minutes_added ?? 0) * 6e4;
        break;
      case "confirm_replay":
        if (e.status === "ok") (replays[e.cand_id] ??= []).push(e.metric);
        break;
      case "run_confirmed":
        confirmedEv = e;
        break;
    }
  });
  for (const [, cand] of Object.entries(awaitingLesson)) if (cand && postedLessonCands.has(cand)) gainsFollowed++;
  const catchUps = [];
  let censored = 0;
  let prevBest = rf.baseline.metric;
  for (const tb of timeline) {
    const jump = prevBest == null ? true : relGain(prevBest, tb.metric) >= 0.05;
    prevBest = tb.metric;
    if (!jump) continue;
    for (const id of rf.writers) {
      if (id === tb.writer_id) continue;
      const hit = W[id]._bestTimeline.find((p) => within(p.metric, tb.metric, 0.05));
      if (hit) catchUps.push(Math.max(0, round(hit.minute - tb.minute, 2)));
      else censored++;
    }
  }
  const allCatch = [...catchUps, ...Array(censored).fill(Infinity)];
  const catchMedian = allCatch.length ? median(allCatch) : null;
  let undelivered = 0;
  let undeliveredLate = 0;
  for (const [lid, p] of Object.entries(pushedAt))
    for (const id of rf.writers) {
      if (id === p.writer || deliveredPairs.has(`${id}/${lid}`)) continue;
      undelivered++;
      if (lastEvalMinute[id] == null || p.minute >= lastEvalMinute[id]) undeliveredLate++;
    }
  Object.assign(lessons, {
    delivered_pairs: deliveredPairs.size,
    undelivered_pairs: undelivered,
    undelivered_pushed_after_last_checkpoint: undeliveredLate,
    used_declared_pairs: usedPairs.size,
    corrections: corrections.length,
    rejected_by_rule: rejectedBy
  });
  const finalId = (id) => generation ? `final-${id}-g${generation}` : `final-${id}`;
  const resultOf = (id) => agentMode ? fs3.existsSync(path3.join(runDir2, "candidates", finalId(id), "src")) ? finalId(id) : lastCheckpoint[id] ?? null : W[id].best_cand;
  const bests = rf.writers.filter((id) => resultOf(id)).map((id) => ({ id, set: codeLineSet(path3.join(runDir2, "candidates", resultOf(id), "src")) })).filter((b) => b.set.size > 0);
  const parent = {};
  const find = (x) => parent[x] === x ? x : parent[x] = find(parent[x]);
  for (const b of bests) parent[b.id] = b.id;
  for (let i = 0; i < bests.length; i++) for (let j = i + 1; j < bests.length; j++) if (jaccard(bests[i].set, bests[j].set) >= 0.8) parent[find(bests[i].id)] = find(bests[j].id);
  const families = new Set(bests.map((b) => find(b.id))).size;
  const target = cfg.metric.target;
  const meets = (m) => target != null && (dir === "min" ? m <= target : m >= target);
  let winner = null;
  const warnings = [];
  let topRanked = null;
  if (confirmedEv && confirmedEv.judged) {
    topRanked = confirmedEv.ranking[0] ?? null;
    const top = confirmedEv.winner_writer ? confirmedEv.ranking.find((r) => r.writer_id === confirmedEv.winner_writer) : null;
    if (top) {
      winner = { cand_id: confirmedEv.winner, writer_id: confirmedEv.winner_writer, metric: null, confirmed_metric: null, replays: [], improvement: null, reached_target: false, judged: true, score: top.score, reason: top.reason, hash: confirmedEv.winner_hash ?? null, generation: confirmedEv.generation ?? 0, path: path3.join(runDir2, "winner") };
      warnings.push("The winner was chosen by a judge agent against the task criteria, not by a measurement. The score is a reading order, not a correctness check: check the result yourself before relying on it.");
    } else warnings.push(`The judge found no result that meets the bar, so there is no winner. Highest-ranked result: ${topRanked ? `${topRanked.writer_id} (score ${topRanked.score}): ${topRanked.reason}` : "none"}.`);
  } else if (confirmedEv && confirmedEv.winner) {
    const r = results[confirmedEv.winner];
    const cm = confirmedEv.confirmed_metric;
    winner = {
      cand_id: confirmedEv.winner,
      writer_id: r?.writer_id ?? candWriter[confirmedEv.winner],
      metric: r?.metric ?? null,
      confirmed_metric: cm,
      replays: confirmedEv.replays,
      improvement: rf.baseline.metric != null ? round(relGain(rf.baseline.metric, cm), 4) : null,
      reached_target: meets(cm),
      path: path3.join(runDir2, "winner")
    };
  } else if (confirmedEv) warnings.push(evals.ok ? "No candidate passed confirmation: every replayed candidate had at least one non-ok replay." : "No correct candidate was produced, so there is no winner.");
  else warnings.push("Run is not confirmed yet; winner is not selected.");
  if (rf.baseline.status !== "ok" && !agentMode) warnings.push("Baseline was not ok; improvement is not available.");
  const unusedMin = closedMs && deadlineMs ? round(Math.max(0, (deadlineMs - closedMs) / 6e4), 1) : 0;
  if (closedReason === "confirm" && unusedMin >= 1) warnings.push(`The run was closed by the final step ${unusedMin} minute(s) before its deadline: every writer lane had already ended (session limit reached, or agents stopped). The time budget is an upper limit, not a guaranteed working time.`);
  if (undeliveredLate) warnings.push(`${undeliveredLate} pushed lesson(s) never reached a teammate because they were approved after that teammate's last checkpoint.`);
  if (logRepairs) warnings.push(`The event log was repaired ${logRepairs} time(s) after a crash; a record cut off mid-write was set aside (see events.jsonl.corrupt).`);
  if (agentMode && evals.recorded) warnings.push(`Checkpoints are saved versions. The host executed and tested nothing in this run; "verified" on a lesson is the verifier agent's judgment.`);
  const isolation = stampMissing > 0 || joinsWithAgent === 0 ? "unenforced" : "enforced";
  if (isolation === "unenforced") warnings.push("Hooks did not stamp every writer session; workspace isolation relied on the prompt only.");
  const sessCounts = Object.values(sessionEvals);
  const writers = rf.writers.map((id) => {
    const w = W[id];
    return { writer_id: id, best_metric: w.best_metric, best_cand: w.best_cand, evals: w.evals, sessions: w._sessions.size, lessons_posted: w.lessons_posted, lessons_pushed: w.lessons_pushed, read_chars: w.read_chars };
  });
  const readChars = writers.map((w) => w.read_chars);
  const diagnostics = {
    lesson_verified_rate: lessons.posted ? round(lessons.pushed / lessons.posted, 3) : null,
    catch_up_minutes_median: catchMedian == null ? null : Number.isFinite(catchMedian) ? catchMedian : null,
    catch_up: { events: catchUps.length + censored, caught: catchUps.length, censored },
    read_chars_per_writer_mean: readChars.length ? Math.round(readChars.reduce((a, b) => a + b, 0) / readChars.length) : 0,
    reads_without_own_correct_share: reads ? round(readsNoCorrect / reads, 3) : null,
    lexical_families: families,
    lexical_family_ratio: bests.length ? round(families / bests.length, 3) : null,
    push_wait_minutes: { median: deliveryWait.length ? round(median(deliveryWait), 2) : null, max: deliveryWait.length ? round(Math.max(...deliveryWait), 2) : null },
    eval_queue_share: queueS + evalS > 0 ? round(queueS / (queueS + evalS), 3) : null,
    evals_per_session: { sessions: sessCounts.length, mean: sessCounts.length ? round(sessCounts.reduce((a, b) => a + b, 0) / sessCounts.length, 1) : null, min: sessCounts.length ? Math.min(...sessCounts) : null, max: sessCounts.length ? Math.max(...sessCounts) : null },
    verification: agentMode ? { kind: "agent", verdicts, pending: lessons.posted - Object.values(verdicts).reduce((a, b) => a + b, 0), verdict_delay_minutes_median: verdictDelay.length ? round(median(verdictDelay), 2) : null } : { kind: "command" },
    behavior: {
      lesson_after_verified_gain_rate: gainsTotal ? round(gainsFollowed / gainsTotal, 3) : null,
      verified_gains: gainsTotal,
      lesson_rejection_rate: lessons.posted + lessons.rejected ? round(lessons.rejected / (lessons.posted + lessons.rejected), 3) : null,
      guard_denied: guardDenied
    }
  };
  const report = {
    verify_kind: agentMode ? "agent" : "command",
    run_id: rf.run_id,
    run_dir: runDir2,
    task: cfg.name,
    mode: cfg.mode,
    settings: cfg.board && cfg.board.show ? effectiveSettings(cfg) : null,
    n: cfg.n,
    closed_reason: closedReason,
    generation,
    minutes: round(lastMinute, 1),
    unused_minutes: unusedMin,
    corrections,
    metric: { name: cfg.metric.name, direction: dir, target },
    baseline: { metric: rf.baseline.metric, status: rf.baseline.status, noise: rf.baseline.noise },
    winner,
    no_validated_winner: !!(confirmedEv && confirmedEv.judged && !winner),
    top_ranked: topRanked,
    ranking: confirmedEv?.ranking ?? null,
    team: {
      evals,
      writers,
      writers_at_target: target == null ? null : writers.filter((w) => w.best_metric != null && meets(w.best_metric)).length,
      lessons,
      team_best_timeline: timeline.map(({ minute, metric, writer_id }) => ({ minute, metric, writer_id }))
    },
    diagnostics,
    isolation,
    warnings
  };
  report.hints = diagnoseHints(report, cfg);
  return report;
}
function diagnoseHints(r, cfg) {
  const d = r.diagnostics;
  const hints = [];
  const board = cfg.board.enabled;
  if (board && r.team.lessons.pushed > 0 && r.team.lessons.delivered === 0) hints.push("Lessons were pushed but none was delivered: check that writers keep evaluating (pushes ride on evaluation results).");
  if (d.catch_up.events > 0 && d.catch_up.censored > d.catch_up.caught) hints.push(board ? "Most writers never caught up with new team bests: discoveries are not spreading. Check lesson_delivered events and whether verified gains were followed by a lesson." : "Most writers never caught up with new team bests. In this mode nothing is shared; try mode lessonshare.");
  if (board && d.lesson_verified_rate != null && d.lesson_verified_rate < 0.15) hints.push("Verified-lesson rate is low: writers rarely make verified gains or do not post after them. Check behavior.lesson_after_verified_gain_rate and whether metric.min_gain is above the real step size.");
  if (board && d.behavior.lesson_after_verified_gain_rate != null && d.behavior.lesson_after_verified_gain_rate < 0.8) hints.push("Writers often skipped posting a lesson after a verified gain; the push channel is underused.");
  if (d.lexical_family_ratio != null && r.n >= 3 && d.lexical_family_ratio < 0.5) hints.push("The results share most of their text: the team is converging on one implementation. Check that the guard hook is active and the mode is not workspace.");
  if (board && d.reads_without_own_correct_share != null && d.reads_without_own_correct_share > 0.2) hints.push("Many board reads happened before the reader had a correct candidate of its own. Consider read.require_own_correct=true.");
  if (d.eval_queue_share != null && d.eval_queue_share > 0.5) hints.push("Evaluations spend most of their time queued: the bottleneck is evaluator throughput. Reduce N, or raise eval.concurrency if the metric tolerates concurrent runs.");
  if (board && r.team.lessons.delivered > 0 && r.winner && r.metric.target != null && !r.winner.reached_target) hints.push("Pushes were delivered but the target was not reached: the bottleneck is discovery itself. Add writers or time; changing the channel will not help.");
  if (r.isolation === "unenforced") hints.push("Isolation was not enforced by hooks in this run; similarity numbers should be read with that in mind.");
  return hints;
}
function renderReportMd(r) {
  const m = r.metric;
  const L = [];
  L.push(`# LessonShare report: ${r.task}`, "");
  L.push(`- Run: \`${r.run_id}\` \xB7 mode **${r.mode}** \xB7 N=${r.n} \xB7 closed by **${r.closed_reason ?? "n/a"}** after ${r.minutes} min`);
  const agent = r.verify_kind === "agent";
  if (agent) L.push("- No evaluator: lessons were checked by the verifier agent, results ranked by a judge agent");
  else {
    L.push(`- Metric: ${m.name} (${m.direction === "min" ? "lower" : "higher"} is better)${m.target != null ? `, target ${fmtNum(m.target)}` : ""}`);
    L.push(`- Baseline: ${r.baseline.metric == null ? "n/a (" + r.baseline.status + ")" : fmtNum(r.baseline.metric)}`);
  }
  if (r.winner && r.winner.judged) {
    L.push(`- **Winner: ${r.winner.writer_id}** \xB7 chosen by the judge agent, score ${r.winner.score}/10: ${r.winner.reason}`);
    L.push(`- Winner files: \`${r.winner.path}\` (not applied to your workspace)`);
  } else if (r.winner) {
    const w = r.winner;
    L.push(`- **Winner: ${w.cand_id} by ${w.writer_id}** \xB7 confirmed ${fmtNum(w.confirmed_metric)} (replays ${w.replays.map(fmtNum).join(", ")}) \xB7 improvement ${pct(w.improvement)}${m.target != null ? ` \xB7 target ${w.reached_target ? "reached" : "not reached"}` : ""}`);
    L.push(`- Winner files: \`${w.path}\` (not applied to your workspace)`);
  } else if (r.no_validated_winner) L.push(`- **Winner: none.** The judge found no result that meets the bar.${r.top_ranked ? ` Highest-ranked: ${r.top_ranked.writer_id}, score ${r.top_ranked.score}/10.` : ""}`);
  else L.push("- **Winner: none**");
  if (r.generation) L.push(`- Result round ${r.generation + 1}: the run was reopened ${r.generation} time(s); earlier reports are kept as report-g<round>.md`);
  if (r.settings) L.push(`- Settings: ${Object.entries(r.settings).map(([k, v2]) => `${k}=${v2}`).join(" \xB7 ")}`);
  L.push(`- Isolation: ${r.isolation}`, "");
  if (r.ranking) {
    L.push("## Judge ranking", "", "Scores are the judge agent's reading order, not measurements.", "", "| writer | score | meets the bar | reason |", "|---|---|---|---|");
    for (const x of r.ranking) L.push(`| ${x.writer_id} | ${x.score} | ${x.meets_bar === false ? "no" : "yes"} | ${x.reason} |`);
    L.push("");
  }
  L.push("## Team", "");
  const e = r.team.evals;
  L.push(e.recorded ? `Checkpoints: ${e.recorded} saved versions (nothing was executed or tested by the host).` : `Evaluations: ${e.ok} ok, ${e.incorrect} incorrect, ${e.build_error} build_error, ${e.infra_error} infra_error.`);
  const l = r.team.lessons;
  L.push(`Lessons: ${l.posted} posted, ${l.pushed} pushed, ${l.rejected} rejected by the host${l.rejected ? ` (${Object.entries(l.rejected_by_rule ?? {}).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}.`);
  L.push(`Deliveries: ${l.delivered_pairs} lesson-to-writer deliveries; ${l.undelivered_pairs} pushed pairs never delivered (${l.undelivered_pushed_after_last_checkpoint} of them approved after the recipient's last checkpoint). A delivery means the lesson was handed over, not that it was read or used.`);
  L.push(`Use: writers declared ${l.used_declared_pairs} lesson-to-writer uses on their checkpoints (self-reported). Corrections posted: ${l.corrections}.`);
  if (r.corrections?.length) for (const c of r.corrections) L.push(`- ${c.lesson_id} (${c.writer_id}) corrects ${c.corrects}`);
  const v = r.diagnostics.verification;
  if (v?.kind === "agent") L.push(`Verifier verdicts: ${v.verdicts.verified} verified, ${v.verdicts.partly_verified ?? 0} partly verified (pushed with a correction), ${v.verdicts.unverified} not verified, ${v.verdicts.refuted} refuted, ${v.verdicts.withheld} withheld, ${v.pending} still pending; median time to verdict ${v.verdict_delay_minutes_median ?? "n/a"} min. A verdict is the verifier agent's judgment of the lesson, not a measured correctness rate.`);
  if (r.team.writers_at_target != null) L.push(`Writers at target: ${r.team.writers_at_target}/${r.n}.`);
  L.push("", "| writer | best | evals | sessions | lessons | pushed | chars read |", "|---|---|---|---|---|---|---|");
  for (const w of r.team.writers) L.push(`| ${w.writer_id} | ${w.best_metric == null ? "-" : fmtNum(w.best_metric)} | ${w.evals} | ${w.sessions} | ${w.lessons_posted} | ${w.lessons_pushed} | ${w.read_chars} |`);
  if (!agent) {
    L.push("", "### Team best over time", "");
    for (const t of r.team.team_best_timeline) L.push(`- minute ${t.minute}: ${fmtNum(t.metric)} (${t.writer_id})`);
    if (!r.team.team_best_timeline.length) L.push("- (no correct candidate)");
  }
  const d = r.diagnostics;
  L.push("", "## Diagnostics", "", "Paper values are for orientation only; they are not thresholds.", "", "| metric | value | paper reference |", "|---|---|---|");
  L.push(`| Lessons pushed / posted${agent ? " (verifier pass rate, not correctness)" : ""} | ${pct(d.lesson_verified_rate)} | 37-40% |`);
  L.push(`| Wait from push approval to delivery, minutes (median, max) | ${d.push_wait_minutes.median ?? "n/a"}, ${d.push_wait_minutes.max ?? "n/a"} | none |`);
  if (!agent) L.push(`| Catch-up time, median minutes (${d.catch_up.caught} caught, ${d.catch_up.censored} censored) | ${d.catch_up_minutes_median ?? (d.catch_up.events ? "not reached (censored)" : "n/a")} | LessonShare 15-19; Independent 40-60; SharedWorkspace ~4 |`);
  L.push(`| Characters read per writer (pushes + reads), mean | ${d.read_chars_per_writer_mean} | 52K at N=4, 171K at N=16 |`);
  L.push(`| Share of reads before own ${agent ? "first checkpoint" : "correct candidate"} | ${pct(d.reads_without_own_correct_share)} | 0.17-0.20 pull-only; lower is better |`);
  L.push(`| Lexical families: results that differ in wording / writers with a result (text overlap only, not a count of methods) | ${d.lexical_families} (${pct(d.lexical_family_ratio)}) | LessonShare 15.5/16; SharedWorkspace 1.6/16 |`);
  if (!agent) L.push(`| Evaluation queue share | ${pct(d.eval_queue_share)} | near 0 |`);
  L.push(`| ${agent ? "Checkpoints" : "Evaluations"} per session (mean, min-max over ${d.evals_per_session.sessions} sessions) | ${d.evals_per_session.mean ?? "n/a"} (${d.evals_per_session.min ?? "-"}-${d.evals_per_session.max ?? "-"}) | none |`);
  if (!agent) L.push(`| Lesson posted after verified gain, before next evaluate | ${pct(d.behavior.lesson_after_verified_gain_rate)} of ${d.behavior.verified_gains} | expect \u226580% |`);
  L.push(`| Lesson rejection rate | ${pct(d.behavior.lesson_rejection_rate)} | expect <20% |`);
  L.push(`| Guard denials | ${d.behavior.guard_denied} | expect 0 |`);
  L.push("", "## Hints", "");
  if (r.hints?.length) for (const h of r.hints) L.push(`- ${h}`);
  else L.push("- No bottleneck stands out.");
  if (r.warnings?.length) {
    L.push("", "## Warnings", "");
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  return L.join("\n") + "\n";
}

// src/core/run.ts
var pad = (n, w = 4) => String(n).padStart(w, "0");
var agentModeInstructions = (verifierOn) => 'This run has no automatic evaluator. Your result is your LAST CHECKPOINT when the run closes: edits to work_dir that you did not checkpoint are not part of it. A judge then ranks every writer against the goal and criteria. evaluate saves a checkpoint of work_dir (status "recorded", no metric). It executes nothing and tests nothing: a checkpoint is a saved version, not a passed check. Call it whenever your result has moved forward. Checkpoints count toward the session quota, anchor your lessons, and carry lessons pushed by teammates back to you. ' + (verifierOn ? "A verifier agent checks every lesson against your checkpoint before anyone else sees it: verified lessons are pushed to the team, and so are partly verified ones, with the verifier's correction in the header; unverified or refuted ones appear on the board with that label; a lesson that hands over your result instead of an insight is withheld. " : 'Nobody checks lessons in this run: they appear on the board at once, labelled "not checked". Treat every lesson as an untested claim and say in yours how you checked it. ') + "When your result looks complete, do not return. Attack it: look for a better one, try to prove or disprove that it is the best possible, test teammates' lessons on your own work, and checkpoint each step. Returning early ends nothing; the host only starts another session for you. There is no verified_gain signal: post a lesson when you establish something a teammate could reuse, and say how you checked it. If a lesson of yours, or one you received, turns out to be wrong, post the correction with corrects set to that lesson id: it goes first to everyone who got the original. When a checkpoint builds on a teammate's lesson, name it in used_lessons on that evaluate call.";
function safeBlobs(dir, globs) {
  try {
    return readBlobs(dir, matchFiles(dir, globs)).map((b) => b.data.toString("utf8"));
  } catch {
    return [];
  }
}
var Run = class {
  constructor(dir, file, clock, evalFn) {
    this.dir = dir;
    this.file = file;
    this.clock = clock;
    this.evalFn = evalFn;
    this.id = file.run_id;
    this.cfg = file.config;
    this.baseline = file.baseline;
    this.writerIds = file.writers;
    this.evalsLimit = this.cfg.budget.evals;
    this.agentMode = this.cfg.verify.kind === "agent";
    this.verifierOn = this.agentMode && this.cfg.verifier.enabled;
    for (const id of this.writerIds) {
      this.writers.set(id, { id, best: null, hashes: /* @__PURE__ */ new Map(), candCount: 0, pending: /* @__PURE__ */ new Set(), sessions: /* @__PURE__ */ new Map(), current: -1, delivered: /* @__PURE__ */ new Set(), bestSeen: null, lessonTexts: /* @__PURE__ */ new Set(), stampMissing: /* @__PURE__ */ new Set() });
      this.queues.set(id, []);
    }
  }
  dir;
  file;
  clock;
  evalFn;
  id;
  cfg;
  baseline;
  writerIds;
  state = "open";
  closedReason = null;
  startMs = 0;
  deadlineMs = 0;
  evalsLimit;
  counted = 0;
  teamBest = null;
  confirmed = false;
  /** Result round: 0 for the first search, +1 each time the run is reopened. Finals and reports are kept per round. */
  generation = 0;
  damage = { events_torn_bytes: 0, events_bad_lines: 0, lessons_torn_bytes: 0, lessons_bad_lines: 0 };
  uses = /* @__PURE__ */ new Set();
  correctedBy = /* @__PURE__ */ new Map();
  writers = /* @__PURE__ */ new Map();
  cands = /* @__PURE__ */ new Map();
  lessons = [];
  agents = /* @__PURE__ */ new Map();
  candSeq = 0;
  lessonStore = /* @__PURE__ */ new Map();
  // queue (in-process; one board server per session, verified by spike S2)
  queues = /* @__PURE__ */ new Map();
  lastServed = -1;
  running = 0;
  prechecking = 0;
  precheckWait = [];
  submitMs = /* @__PURE__ */ new Map();
  waiters = /* @__PURE__ */ new Map();
  idleWaiters = [];
  slotWaiters = [];
  confirming = null;
  agentMode;
  /** True when a verifier agent gates lessons (no evaluator, verifier enabled). */
  verifierOn;
  bseqMax = 0;
  verifierSessions = /* @__PURE__ */ new Map();
  verifierCurrent = -1;
  verifierAgents = /* @__PURE__ */ new Set();
  assigned = /* @__PURE__ */ new Map();
  lessonWaiters = [];
  // ---------- paths ----------
  get eventsPath() {
    return path4.join(this.dir, "events.jsonl");
  }
  get lessonsPath() {
    return path4.join(this.dir, "lessons.jsonl");
  }
  candDir(id) {
    return path4.join(this.dir, "candidates", id);
  }
  writerDir(id) {
    return path4.join(this.dir, "writers", id);
  }
  workDir(id) {
    return path4.join(this.writerDir(id), "work");
  }
  get sharedDir() {
    return path4.join(this.dir, "shared");
  }
  log(msg) {
    try {
      fs4.appendFileSync(path4.join(this.dir, "server.log"), `${new Date(this.clock.now()).toISOString()} pid=${process.pid} ${msg}
`);
    } catch {
    }
  }
  // ---------- event log: the single source of truth ----------
  emit(type, fields = {}) {
    const now = this.clock.now();
    const ev = { t: new Date(now).toISOString(), minute: this.startMs ? round((now - this.startMs) / 6e4, 2) : 0, type, ...fields };
    appendLineSync(this.eventsPath, ev);
    this.apply(ev);
    return ev;
  }
  /** Reducer. Every state change goes through here, live and during recovery. */
  apply(ev) {
    const tMs = Date.parse(ev.t);
    switch (ev.type) {
      case "run_init":
        this.startMs = tMs;
        this.deadlineMs = tMs + this.cfg.budget.minutes * 6e4;
        break;
      case "run_reopened":
        this.state = "open";
        this.closedReason = null;
        this.confirmed = false;
        this.generation++;
        this.deadlineMs = tMs + ev.minutes_added * 6e4;
        if (ev.evals_added && this.evalsLimit != null) this.evalsLimit += ev.evals_added;
        break;
      case "run_closed":
        this.state = "closed";
        this.closedReason = ev.reason;
        break;
      case "join": {
        const w = this.writers.get(ev.writer_id);
        if (!w.sessions.has(ev.session)) w.sessions.set(ev.session, { counted: 0, submitted: 0, pending: 0 });
        if (ev.session > w.current) w.current = ev.session;
        if (ev.agent_id) this.agents.set(ev.agent_id, ev.writer_id);
        break;
      }
      case "stamp_missing":
        this.writers.get(ev.writer_id).stampMissing.add(ev.session);
        break;
      case "eval_submitted": {
        const w = this.writers.get(ev.writer_id);
        const n = Number(String(ev.cand_id).slice(1));
        if (n > this.candSeq) this.candSeq = n;
        this.cands.set(ev.cand_id, { cand_id: ev.cand_id, writer_id: ev.writer_id, session: ev.session, hash: ev.hash, note: ev.note ?? "", status: "pending", metric: null, detail: "", reference: null, gain: null, verified_gain: false, is_own_best: false, is_team_best: false, reached_target: false, counted: false, queue_wait_s: 0, eval_s: 0, lessons: 0 });
        w.hashes.set(ev.hash, ev.cand_id);
        w.candCount++;
        w.pending.add(ev.cand_id);
        const s = this.sessionOf(w, ev.session);
        s.submitted++;
        s.pending++;
        break;
      }
      case "eval_result": {
        const c = this.cands.get(ev.cand_id);
        const w = this.writers.get(c.writer_id);
        Object.assign(c, { status: ev.status, metric: ev.metric, detail: ev.detail ?? "", reference: ev.reference, gain: ev.gain, verified_gain: ev.verified_gain, is_own_best: ev.is_own_best, is_team_best: ev.is_team_best, reached_target: ev.reached_target, counted: ev.counted, queue_wait_s: ev.queue_wait_s, eval_s: ev.eval_s });
        w.pending.delete(c.cand_id);
        const s = this.sessionOf(w, c.session);
        s.pending = Math.max(0, s.pending - 1);
        if (ev.counted) {
          this.counted++;
          s.counted++;
        }
        if (ev.is_own_best) w.best = { cand_id: c.cand_id, metric: ev.metric };
        if (ev.is_team_best) this.teamBest = { cand_id: c.cand_id, writer_id: c.writer_id, metric: ev.metric };
        break;
      }
      case "lesson_posted": {
        const l = this.lessonStore.get(ev.lesson_id);
        if (!l) break;
        this.lessons.push(l);
        if (l.pushed) l.pushed_minute = ev.minute;
        if (l.bseq != null) this.noteCorrection(l);
        if (l.bseq != null && l.bseq > this.bseqMax) this.bseqMax = l.bseq;
        this.writers.get(l.writer_id).lessonTexts.add(l.text);
        const c = this.cands.get(l.cand_id);
        if (c) c.lessons++;
        break;
      }
      case "lesson_delivered": {
        const w = this.writers.get(ev.to);
        w.delivered.add(ev.lesson_id);
        this.noteSeen(w, this.lessonStore.get(ev.lesson_id));
        break;
      }
      case "lessons_read": {
        const w = this.writers.get(ev.writer_id);
        for (const l of this.lessons) if (l.bseq != null && l.bseq > ev.from_seq && l.bseq <= ev.to_seq && l.writer_id !== w.id) this.noteSeen(w, l);
        break;
      }
      case "verifier_join": {
        if (!this.verifierSessions.has(ev.session)) this.verifierSessions.set(ev.session, { verdicts: 0 });
        if (ev.session > this.verifierCurrent) this.verifierCurrent = ev.session;
        if (ev.agent_id) this.verifierAgents.add(ev.agent_id);
        break;
      }
      case "lesson_verdict": {
        const l = this.lessonStore.get(ev.lesson_id);
        if (!l) break;
        l.verdict = ev.verdict;
        l.verdict_note = ev.note ?? "";
        l.header = ev.header;
        l.pushed = !!ev.pushed;
        l.pushed_minute = l.pushed ? ev.minute : null;
        l.bseq = ev.bseq ?? null;
        if (ev.verdict === "verified" || ev.verdict === "partly_verified") this.noteCorrection(l);
        if (l.bseq != null && l.bseq > this.bseqMax) this.bseqMax = l.bseq;
        this.assigned.delete(l.lesson_id);
        const vs = this.verifierSessions.get(ev.session);
        if (vs) vs.verdicts++;
        break;
      }
      case "lessons_used":
        for (const id of ev.lesson_ids ?? []) this.uses.add(`${ev.writer_id}/${id}`);
        break;
      case "run_confirmed":
        this.confirmed = true;
        break;
    }
  }
  /** A correction that is visible and not itself in doubt marks the lesson it corrects. */
  noteCorrection(l) {
    if (!l.corrects) return;
    const list = this.correctedBy.get(l.corrects) ?? [];
    if (!list.includes(l.lesson_id)) list.push(l.lesson_id);
    this.correctedBy.set(l.corrects, list);
  }
  /** The header a reader sees: the host's record plus what later lessons say about this one. */
  headerOf(l) {
    const by = this.correctedBy.get(l.lesson_id);
    const parts = [l.corrects ? `corrects ${l.corrects}` : "", by?.length ? `CORRECTED BY ${by.join(", ")}: read that lesson before using this one` : ""].filter(Boolean);
    return parts.length ? l.header.replace(/\]$/, "") + " \xB7 " + parts.join(" \xB7 ") + "]" : l.header;
  }
  sessionOf(w, idx) {
    let s = w.sessions.get(idx);
    if (!s) {
      s = { counted: 0, submitted: 0, pending: 0 };
      w.sessions.set(idx, s);
    }
    return s;
  }
  noteSeen(w, l) {
    if (!l || l.evidence.status !== "ok" || l.evidence.metric == null) return;
    if (w.bestSeen == null || this.better(l.evidence.metric, w.bestSeen)) w.bestSeen = l.evidence.metric;
  }
  /** Rebuild all in-memory state from disk and re-enqueue evaluations that never produced a result. */
  recover() {
    const ev = repairJsonl(this.eventsPath);
    const ls = repairJsonl(this.lessonsPath);
    this.damage = { events_torn_bytes: ev.torn_bytes, events_bad_lines: ev.bad_lines, lessons_torn_bytes: ls.torn_bytes, lessons_bad_lines: ls.bad_lines };
    if (ev.torn_bytes || ls.torn_bytes || ev.bad_lines || ls.bad_lines) this.log(`log damage on load: ${JSON.stringify(this.damage)}`);
    for (const l of readJsonl(this.lessonsPath)) this.lessonStore.set(l.lesson_id, l);
    for (const ev2 of readJsonl(this.eventsPath)) this.apply(ev2);
    const pending = [...this.cands.values()].filter((c) => c.status === "pending").sort((a, b) => a.cand_id.localeCompare(b.cand_id));
    for (const c of pending) {
      this.submitMs.set(c.cand_id, this.clock.now());
      this.waiters.set(c.cand_id, new Deferred());
      this.queues.get(c.writer_id).push(c.cand_id);
    }
    if (pending.length) this.log(`recovered ${pending.length} unfinished evaluation(s)`);
    if (ev.torn_bytes || ls.torn_bytes) this.emit("log_repaired", { ...this.damage });
    this.tick();
    this.pump();
  }
  // ---------- helpers ----------
  better(a, b) {
    return this.cfg.metric.direction === "min" ? a < b : a > b;
  }
  meetsTarget(m) {
    const t = this.cfg.metric.target;
    if (t == null) return false;
    return this.cfg.metric.direction === "min" ? m <= t : m >= t;
  }
  writer(id) {
    if (typeof id !== "string") throw new ArgError("writer_id is required");
    const w = this.writers.get(id);
    if (!w) throw new ArgError(`unknown writer_id "${id}"; this run has ${this.writerIds[0]}..${this.writerIds[this.writerIds.length - 1]}`);
    return w;
  }
  budgetView() {
    return {
      run_state: this.state,
      minutes_left: this.state === "open" ? Math.max(0, round((this.deadlineMs - this.clock.now()) / 6e4, 1)) : 0,
      evals_left: this.evalsLimit == null ? null : Math.max(0, this.evalsLimit - this.counted)
    };
  }
  sessionView(w, idx = w.current) {
    const s = w.sessions.get(idx) ?? { counted: 0, submitted: 0, pending: 0 };
    const quota = this.cfg.session.eval_quota;
    return { index: idx, evals_used: s.counted, eval_quota: quota, must_hand_off: s.counted >= quota };
  }
  tick() {
    if (this.state === "open" && this.startMs && this.clock.now() >= this.deadlineMs) this.close("time");
  }
  close(reason) {
    if (this.state !== "open") return;
    this.emit("run_closed", { reason });
    this.log(`run closed: ${reason}`);
    for (const r of this.lessonWaiters.splice(0)) r();
  }
  start() {
    this.emit("run_init", { run_id: this.id, config: this.cfg, baseline: this.baseline });
  }
  reopen(minutes, evals) {
    for (const ext of ["json", "md"]) {
      const cur = path4.join(this.dir, `report.${ext}`);
      try {
        if (fs4.existsSync(cur)) fs4.renameSync(cur, path4.join(this.dir, `report-g${this.generation}.${ext}`));
      } catch (e) {
        this.log("could not archive report: " + e.message);
      }
    }
    this.emit("run_reopened", { minutes_added: minutes, evals_added: evals ?? 0, generation: this.generation + 1 });
  }
  minutesLeft() {
    return this.budgetView().minutes_left;
  }
  /** Human-readable account of log damage found when this run was loaded; empty when the logs were clean. */
  logDamage() {
    const d = this.damage;
    const out = [];
    if (d.events_torn_bytes || d.lessons_torn_bytes) out.push(`A record cut off by a crash was set aside (${d.events_torn_bytes} bytes of events.jsonl, ${d.lessons_torn_bytes} of lessons.jsonl; kept in the .corrupt file next to each log). The action it recorded is lost; everything before it is intact.`);
    if (d.events_bad_lines || d.lessons_bad_lines) out.push(`Unreadable lines inside the logs were skipped (${d.events_bad_lines} in events.jsonl, ${d.lessons_bad_lines} in lessons.jsonl). State rebuilt from these logs may be incomplete: check server.log.`);
    return out;
  }
  maxSession() {
    let m = -1;
    for (const w of this.writers.values()) if (w.current > m) m = w.current;
    return m;
  }
  /** Identity checks of section 9.4. Call before any writer-scoped tool. */
  checkIdentity(writerId, agentId) {
    if (typeof agentId !== "string" || !agentId || !writerId) return;
    const owner = this.agents.get(agentId);
    if (owner && owner !== writerId) throw new HostError("identity_mismatch", `this agent is registered as ${owner}; it cannot act as ${writerId}`);
  }
  writerOfAgent(agentId) {
    return typeof agentId === "string" ? this.agents.get(agentId) : void 0;
  }
  // ---------- join ----------
  join(a) {
    const w = this.writer(a.writer_id);
    if (!Number.isInteger(a.session) || a.session < 0) throw new ArgError("session must be a non-negative integer");
    this.tick();
    if (this.state === "closed") return { error: "run_closed", message: "The run is closed. Return your structured result now.", budget: this.budgetView() };
    this.checkIdentity(w.id, a.agent_id);
    const known = w.sessions.has(a.session);
    const agentKnown = a.agent_id ? this.agents.get(a.agent_id) === w.id : true;
    if (!known || !agentKnown) this.emit("join", { writer_id: w.id, session: a.session, agent_id: a.agent_id ?? null, agent_type: a.agent_type ?? null });
    if (a.agent_id) this.writeAgentMap(a.agent_id, a.agent_type ?? null, w, a.session);
    else if (!w.stampMissing.has(a.session)) this.emit("stamp_missing", { writer_id: w.id, session: a.session });
    const sv = this.sessionView(w, a.session);
    const exhausted = sv.evals_used >= sv.eval_quota || w.current > a.session;
    const boardOn = this.cfg.board.enabled;
    return {
      mode: this.cfg.mode,
      board_enabled: boardOn,
      verify_kind: this.cfg.verify.kind,
      ...this.agentMode ? { how_this_run_works: agentModeInstructions(this.verifierOn), criteria: this.cfg.criteria } : {},
      mode_instructions: [
        this.cfg.shared.enabled ? `Shared visibility: the directory at shared_dir is readable. It holds every checkpoint or evaluated candidate of every writer under <writer_id>/<cand_id>/, and index.tsv lists writer, candidate, minute, status and metric. You may read teammates' work there. It is read-only.` : "",
        !boardOn ? "The lesson board is off in this run: post_lesson and read_lessons return board_disabled." : [
          this.cfg.push.policy === "none" ? "Lessons are not pushed in this run: nothing arrives with your results, so page through the board with read_lessons yourself." : this.cfg.push.policy === "all" ? "Every lesson is pushed in this run, checked or not: read the header of each one." : "",
          !this.cfg.board.pull ? "read_lessons is off in this run: you only receive pushed lessons." : this.cfg.board.show === "verified" ? "The board shows verified lessons only." : ""
        ].filter(Boolean).join(" ")
      ].filter(Boolean).join(" "),
      settings: effectiveSettings(this.cfg),
      goal: this.cfg.goal,
      work_dir: this.workDir(w.id),
      notes_path: path4.join(this.writerDir(w.id), "NOTES.md"),
      context_files: this.contextPaths(w.id),
      candidate_files: this.cfg.candidate.files,
      ...this.cfg.shared.enabled ? { shared_dir: this.sharedDir } : {},
      metric: { name: this.cfg.metric.name, direction: this.cfg.metric.direction, target: this.cfg.metric.target },
      baseline: this.baseline.metric,
      own_best: w.best,
      budget: this.budgetView(),
      session: { index: a.session, evals_used: sv.evals_used, eval_quota: sv.eval_quota, exhausted },
      lessons_unread: boardOn && this.cfg.board.pull ? this.board().filter((l) => l.writer_id !== w.id && !w.delivered.has(l.lesson_id)).length : 0
    };
  }
  /** Context files are copied next to the writer's work dir at init, so every path a writer needs shares one prefix. */
  contextPaths(writerId) {
    return this.cfg.context_files.map((f) => {
      const copy = path4.join(this.writerDir(writerId), "context", f);
      return fs4.existsSync(copy) ? copy : path4.resolve(this.file.project_dir, f);
    });
  }
  writeAgentMap(agentId, agentType, w, session) {
    if (!/^[A-Za-z0-9_.-]+$/.test(agentId)) return;
    const dir = path4.join(this.dir, "agents");
    fs4.mkdirSync(dir, { recursive: true });
    writeJson(path4.join(dir, agentId + ".json"), {
      agent_id: agentId,
      agent_type: agentType,
      run_id: this.id,
      run_dir: this.dir,
      writer_id: w.id,
      session,
      mode: this.cfg.mode,
      start_ms: this.startMs,
      writer_dir: this.writerDir(w.id),
      context_files: this.cfg.context_files.map((f) => path4.resolve(this.file.project_dir, f)),
      shared_dir: this.cfg.shared.enabled ? this.sharedDir : null
    });
  }
  // ---------- evaluate ----------
  async evaluate(a) {
    const w = this.writer(a.writer_id);
    this.checkIdentity(w.id, a.agent_id);
    this.tick();
    if (this.state === "closed") throw new HostError("run_closed", "The run is closed; no new candidates are accepted. Finish your notes and return.", { budget: this.budgetView() });
    if (w.current < 0) throw new HostError("not_joined", "Call join before evaluate.");
    const s = this.sessionOf(w, w.current);
    const quota = this.cfg.session.eval_quota;
    if (s.counted + s.pending >= quota + this.cfg.session.grace) throw new HostError("hand_off_required", "This session has used its evaluation quota. Update your notes file and return your structured result; the next session continues from your notes.", { session: this.sessionView(w) });
    if (w.pending.size >= this.cfg.eval.max_pending) throw new HostError("too_many_pending", `You already have ${w.pending.size} unfinished evaluation(s). Call get_result on them first.`, { pending: [...w.pending] });
    if (w.candCount >= this.cfg.eval.max_candidates) throw new HostError("candidate_limit", `You reached the limit of ${this.cfg.eval.max_candidates} candidates for this run.`);
    const note = String(a.note ?? "").replace(/\s+/g, " ").slice(0, 200);
    const waitUntil = Date.now() + this.cfg.eval.block_s * 1e3;
    while (this.evalsLimit != null && this.state === "open" && this.counted + this.inFlight() >= this.evalsLimit) {
      const left = waitUntil - Date.now();
      if (left <= 0) throw new HostError("budget_reserved", "The remaining evaluation budget is held by evaluations still in flight. Call evaluate again shortly.", { budget: this.budgetView() });
      let timer;
      await Promise.race([new Promise((r) => this.slotWaiters.push(r)), new Promise((r) => timer = setTimeout(r, left))]);
      clearTimeout(timer);
    }
    if (this.state === "closed") throw new HostError("run_closed", "The run is closed; no new candidates are accepted. Finish your notes and return.", { budget: this.budgetView() });
    const work = this.workDir(w.id);
    const rels = matchFiles(work, this.cfg.candidate.files);
    if (!rels.length) throw new HostError("empty_candidate", `No candidate files found in ${work}. Expected: ${this.cfg.candidate.files.join(", ")}`);
    const blobs = readBlobs(work, rels);
    const bytes = blobs.reduce((n, b) => n + b.data.length, 0);
    if (bytes > this.cfg.candidate.max_bytes) throw new HostError("too_large", `Candidate is ${bytes} bytes; the limit is ${this.cfg.candidate.max_bytes}.`);
    const hash = hashBlobs(blobs);
    const dup = w.hashes.get(hash);
    if (dup) {
      const c = this.cands.get(dup);
      if (c.status === "pending") return { cand_id: dup, status: "running", duplicate_of: dup, queue_position: this.queuePosition(dup) };
      return { ...this.resultView(c, w, false), duplicate_of: dup, hint: `Identical to your earlier candidate ${dup}; not re-evaluated.` };
    }
    const candId = "c" + pad(++this.candSeq);
    writeBlobs(path4.join(this.candDir(candId), "src"), blobs);
    this.submitMs.set(candId, this.clock.now());
    this.waiters.set(candId, new Deferred());
    this.emit("eval_submitted", { cand_id: candId, writer_id: w.id, session: w.current, hash, note, bytes });
    const usedNote = this.recordUses(w, candId, a.used_lessons);
    if (this.agentMode) {
      this.finish(this.cands.get(candId), { status: "recorded", metric: null, detail: "Checkpoint recorded. There is no automatic evaluator in this run.", eval_s: 0, log: "" }, 0, hash);
      return { ...this.resultView(this.cands.get(candId), w, true), ...usedNote };
    }
    void this.admit(candId);
    return { ...await this.await(candId, w, this.cfg.eval.block_s), ...usedNote };
  }
  /** A writer's own statement of which teammates' lessons a candidate builds on. Self-declared, tied to the candidate. */
  recordUses(w, candId, raw) {
    if (raw == null) return {};
    const ids = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
    const ok = [];
    const unknown = [];
    for (const id of new Set(ids)) {
      const l = this.lessonStore.get(id);
      if (l && l.writer_id !== w.id && (w.delivered.has(id) || l.bseq != null)) ok.push(id);
      else unknown.push(id);
    }
    if (ok.length) this.emit("lessons_used", { writer_id: w.id, cand_id: candId, lesson_ids: ok });
    return unknown.length ? { used_lessons_ignored: unknown, used_lessons_hint: "used_lessons takes ids of teammates' lessons you received or read, e.g. L0007." } : {};
  }
  async getResult(a) {
    const w = this.writer(a.writer_id);
    this.checkIdentity(w.id, a.agent_id);
    const c = this.cands.get(a.cand_id);
    if (!c || c.writer_id !== w.id) throw new HostError("unknown_candidate", `${a.cand_id} is not one of your candidates.`);
    const wait = typeof a.wait_s === "number" && a.wait_s >= 0 ? Math.min(a.wait_s, 1500) : this.cfg.eval.block_s;
    return this.await(c.cand_id, w, wait);
  }
  async await(candId, w, waitS) {
    const c = this.cands.get(candId);
    const d = this.waiters.get(candId);
    if (c.status === "pending" && d) {
      let timer;
      await Promise.race([d.promise, new Promise((r) => timer = setTimeout(r, waitS * 1e3))]);
      clearTimeout(timer);
    }
    if (c.status === "pending") return { cand_id: candId, status: "running", queue_position: this.queuePosition(candId), budget: this.budgetView(), hint: "Still running. Call get_result with this cand_id." };
    return this.resultView(c, w, true);
  }
  queuePosition(candId) {
    const snapshot = new Map([...this.queues].map(([k, v]) => [k, [...v]]));
    let last = this.lastServed;
    let pos = 0;
    for (; ; ) {
      let found = null;
      for (let i = 1; i <= this.writerIds.length; i++) {
        const idx = (last + i) % this.writerIds.length;
        const q = snapshot.get(this.writerIds[idx]);
        if (q.length) {
          found = q.shift();
          last = idx;
          break;
        }
      }
      if (!found) return 0;
      if (found === candId) return pos + 1;
      pos++;
    }
  }
  resultView(c, w, deliver) {
    this.tick();
    const out = {
      cand_id: c.cand_id,
      status: c.status,
      metric: c.metric,
      detail: c.detail,
      reference: c.reference,
      gain: c.gain == null ? null : round(c.gain, 4),
      is_own_best: c.is_own_best,
      verified_gain: c.verified_gain,
      reached_target: c.reached_target,
      own_best: w.best,
      queue_wait_s: c.queue_wait_s,
      eval_s: c.eval_s,
      budget: this.budgetView(),
      session: this.sessionView(w)
    };
    if (c.status === "recorded") Object.assign(out, { execution_performed: false, evidence: "checkpoint saved by the host; nothing was executed or tested" });
    if (this.cfg.board.enabled) out.pushed_lessons = deliver ? this.deliver(w, c.cand_id) : [];
    const sv = this.sessionView(w);
    const hints = [];
    if (c.status === "infra_error") hints.push("The evaluator itself failed (not your candidate). This did not use budget; you may resubmit after a small change, or continue.");
    if (c.status === "recorded" && this.cfg.board.enabled && this.state === "open") hints.push(`Checkpoint ${c.cand_id} recorded. If it contains a new insight, post a lesson attached to it.`);
    if (c.verified_gain && this.cfg.board.enabled && this.state === "open" && c.lessons === 0) hints.push(`This candidate is a verified gain. Post a lesson attached to ${c.cand_id} so teammates receive it.`);
    if (this.state === "closed") hints.push("The run is closed. Finish your notes and return your structured result.");
    else if (sv.must_hand_off) hints.push("Session quota reached (must_hand_off). Update your notes file and return your structured result.");
    if (hints.length) out.hint = hints.join(" ");
    return out;
  }
  /** Piggy-back pushed lessons from other writers on a finished evaluation result (section 6.6). */
  deliver(w, via) {
    const out = [];
    const due = this.board().filter((l) => l.pushed && l.writer_id !== w.id && !w.delivered.has(l.lesson_id));
    const urgent = (l) => l.corrects && w.delivered.has(l.corrects) ? 0 : 1;
    due.sort((a, b) => urgent(a) - urgent(b) || a.bseq - b.bseq);
    for (const l of due) {
      if (out.length >= this.cfg.push.max_per_delivery) break;
      this.emit("lesson_delivered", { lesson_id: l.lesson_id, to: w.id, with_cand: via, chars: l.text.length, waited_min: l.pushed_minute == null ? null : round(Math.max(0, (this.clock.now() - this.startMs) / 6e4 - l.pushed_minute), 2) });
      out.push({ lesson_id: l.lesson_id, header: this.headerOf(l), text: l.text, ...l.corrects ? { corrects: l.corrects } : {} });
    }
    return out;
  }
  /** Pushed lessons that have not reached this writer yet, and how long the oldest has waited. */
  waitingFor(w) {
    const due = this.lessons.filter((l) => l.pushed && l.bseq != null && l.writer_id !== w.id && !w.delivered.has(l.lesson_id));
    const nowMin = (this.clock.now() - this.startMs) / 6e4;
    const oldest = due.reduce((m, l) => Math.max(m, l.pushed_minute == null ? 0 : nowMin - l.pushed_minute), 0);
    return { count: due.length, oldest_wait_min: due.length ? round(Math.max(0, oldest), 1) : 0 };
  }
  /** Lessons visible on the board, in board order. Under agent verification a lesson appears only after its verdict. */
  board() {
    const onlyVerified = this.cfg.board.show === "verified";
    const isVerified = (l) => this.agentMode ? l.verdict === "verified" || l.verdict === "partly_verified" : l.evidence.verified_gain;
    return this.lessons.filter((l) => l.bseq != null && (!onlyVerified || isVerified(l))).sort((a, b) => a.bseq - b.bseq);
  }
  // ---------- queue ----------
  async admit(candId) {
    const c = this.cands.get(candId);
    const pre = this.cfg.eval.precheck;
    if (pre) {
      if (this.prechecking >= this.cfg.eval.precheck_concurrency) await new Promise((r2) => this.precheckWait.push(r2));
      this.prechecking++;
      let o;
      try {
        o = await this.evalFn({ kind: "precheck", candidate_dir: path4.join(this.candDir(candId), "src"), run_dir: this.dir, cand_id: candId });
      } catch (e) {
        o = { status: "infra_error", metric: null, detail: "precheck crashed: " + e.message, eval_s: 0, log: String(e) };
      }
      this.prechecking--;
      this.precheckWait.shift()?.();
      const r = interpretPrecheck(o);
      if (!r.pass) {
        this.safeWrite(path4.join(this.candDir(candId), "precheck.log"), o.log);
        this.finish(c, { status: "build_error", metric: null, detail: r.detail || "precheck failed", eval_s: o.eval_s, log: o.log }, 0, null);
        return;
      }
    }
    this.queues.get(c.writer_id).push(candId);
    this.pump();
  }
  pickNext() {
    const n = this.writerIds.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.lastServed + i) % n;
      const q = this.queues.get(this.writerIds[idx]);
      if (q.length) {
        this.lastServed = idx;
        return q.shift();
      }
    }
    return null;
  }
  pump() {
    while (this.running < this.cfg.eval.concurrency) {
      const next = this.pickNext();
      if (!next) break;
      this.running++;
      void this.execute(next).finally(() => {
        this.running--;
        this.pump();
        this.checkIdle();
      });
    }
    this.checkIdle();
  }
  safeWrite(file, data) {
    try {
      fs4.mkdirSync(path4.dirname(file), { recursive: true });
      fs4.writeFileSync(file, data);
    } catch {
    }
  }
  async evalWithRetry(candDir, candId) {
    const ctx = { kind: "eval", candidate_dir: path4.join(candDir, "src"), run_dir: this.dir, cand_id: candId };
    let o;
    let log = "";
    for (let attempt = 0; ; attempt++) {
      try {
        o = await this.evalFn(ctx);
      } catch (e) {
        o = { status: "infra_error", metric: null, detail: "evaluator crashed: " + e.message, eval_s: 0, log: String(e) };
      }
      log += (attempt ? "\n=== retry ===\n" : "") + o.log;
      if (o.status !== "infra_error" || attempt >= 1) break;
    }
    return { ...o, log };
  }
  async execute(candId) {
    const c = this.cands.get(candId);
    const startMs = this.clock.now();
    const queueWait = Math.max(0, (startMs - (this.submitMs.get(candId) ?? startMs)) / 1e3);
    const dir = this.candDir(candId);
    let evaluatedHash = null;
    let o;
    if (!fs4.existsSync(path4.join(dir, "src"))) o = { status: "infra_error", metric: null, detail: "candidate snapshot is missing", eval_s: 0, log: "" };
    else {
      evaluatedHash = hashDir(path4.join(dir, "src"));
      o = await this.evalWithRetry(dir, candId);
    }
    this.safeWrite(path4.join(dir, "eval.log"), o.log);
    this.finish(c, o, queueWait, evaluatedHash);
  }
  /** Final snapshot id of a writer in the current result round. Round 0 keeps the historical name. */
  finalId(writerId, generation = this.generation) {
    return generation ? `final-${writerId}-g${generation}` : `final-${writerId}`;
  }
  /**
   * Freeze one writer's result for this round: its last checkpoint (work saved before the run closed), or the work
   * directory when it never saved one. Written to a temporary directory and renamed, so a final either exists
   * complete, with its manifest, or not at all. A final that exists is never rewritten.
   */
  freezeFinal(id) {
    const fid = this.finalId(id);
    const dir = this.candDir(fid);
    const manifestPath = path4.join(dir, "final.json");
    if (!fs4.existsSync(manifestPath)) {
      const last = [...this.cands.values()].filter((c) => c.writer_id === id && c.status === "recorded").sort((a, b) => a.cand_id.localeCompare(b.cand_id)).pop();
      const srcDir = last ? path4.join(this.candDir(last.cand_id), "src") : this.workDir(id);
      let blobs = last ? readBlobs(srcDir, matchFiles(srcDir, ["**"])) : readBlobs(srcDir, matchFiles(srcDir, this.cfg.candidate.files));
      if (blobs.reduce((n, b) => n + b.data.length, 0) > this.cfg.candidate.max_bytes) blobs = [];
      const manifest = { writer_id: id, cand_id: fid, generation: this.generation, source: last ? last.cand_id : "work_dir", hash: hashBlobs(blobs), files: blobs.map((b) => b.rel) };
      if (this.generation === 0 && fs4.existsSync(path4.join(dir, "src"))) {
        const legacy = readBlobs(path4.join(dir, "src"), matchFiles(path4.join(dir, "src"), ["**"]));
        writeJson(manifestPath, { ...manifest, source: "legacy", hash: hashBlobs(legacy), files: legacy.map((b) => b.rel) });
      } else {
        const tmp = `${dir}.tmp${process.pid}`;
        fs4.rmSync(tmp, { recursive: true, force: true });
        fs4.rmSync(dir, { recursive: true, force: true });
        writeBlobs(path4.join(tmp, "src"), blobs);
        writeJson(path4.join(tmp, "final.json"), manifest);
        fs4.renameSync(tmp, dir);
      }
      const m2 = readJson(manifestPath);
      this.emit("final_snapshot", { writer_id: id, cand_id: fid, generation: this.generation, source: m2.source, hash: m2.hash, files: m2.files.length });
    }
    const m = readJson(manifestPath);
    return { writer_id: id, cand_id: fid, final_dir: path4.join(dir, "src"), files: m.files, hash: m.hash, source: m.source, notes_path: path4.join(this.writerDir(id), "NOTES.md") };
  }
  /**
   * Without an evaluation command there is nothing to replay. The run is closed, every writer's last checkpoint is
   * frozen as the final of this round, and a judge agent ranks the finals against the task criteria. The host
   * checks the ranking itself: one row per writer, scores in range, a reason for each.
   */
  async confirmJudged(ranking, reportPath) {
    this.close("confirm");
    await this.idle();
    const finals = this.writerIds.map((id) => this.freezeFinal(id));
    if (ranking == null) return { needs_ranking: true, run_id: this.id, generation: this.generation, goal: this.cfg.goal, criteria: this.cfg.criteria, finals, instructions: "Read every final_dir. Judge each result against the goal and criteria: check it yourself, do not trust claims. Then call confirm again with ranking: one row for EVERY writer, [{writer_id, score (0 to 10), meets_bar (true only if the result is valid and good enough to rely on), reason (one sentence)}]. If no result meets the bar, say so with meets_bar false on every row: the report then names no winner." };
    if (!Array.isArray(ranking) || !ranking.length) throw new ArgError("ranking must be a non-empty array of {writer_id, score, meets_bar, reason}");
    const seen = /* @__PURE__ */ new Set();
    const clean = ranking.map((r) => {
      if (!r || !this.writers.has(r.writer_id)) throw new ArgError(`ranking: unknown writer_id ${JSON.stringify(r?.writer_id)}`);
      if (seen.has(r.writer_id)) throw new ArgError(`ranking: ${r.writer_id} appears more than once`);
      seen.add(r.writer_id);
      if (typeof r.score !== "number" || !Number.isFinite(r.score)) throw new ArgError("ranking: score must be a number");
      if (r.score < 0 || r.score > 10) throw new ArgError(`ranking: the score of ${r.writer_id} is ${r.score}; scores go from 0 to 10`);
      const reason = String(r.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (!reason) throw new ArgError(`ranking: ${r.writer_id} has no reason; give one sentence`);
      if (r.meets_bar != null && typeof r.meets_bar !== "boolean") throw new ArgError("ranking: meets_bar must be true or false");
      const f = finals.find((x) => x.writer_id === r.writer_id);
      const meets = r.meets_bar !== false;
      if (meets && !f.files.length) throw new ArgError(`ranking: ${r.writer_id} has no result files, so it cannot meet the bar; set meets_bar to false`);
      return { writer_id: r.writer_id, score: r.score, meets_bar: meets, reason, final: f.cand_id, hash: f.hash };
    });
    const missing = this.writerIds.filter((id) => !seen.has(id));
    if (missing.length) throw new ArgError(`ranking: no row for ${missing.join(", ")}; rank every writer of the run (${this.writerIds.join(", ")})`);
    clean.sort((x, y) => y.score - x.score);
    const top = clean.find((x) => x.meets_bar) ?? null;
    const winnerDir = path4.join(this.dir, "winner");
    fs4.rmSync(winnerDir, { recursive: true, force: true });
    if (top) copyDir(path4.join(this.candDir(top.final), "src"), winnerDir);
    this.emit("run_confirmed", { winner: top ? top.final : null, winner_writer: top ? top.writer_id : null, winner_hash: top ? top.hash : null, no_validated_winner: !top, judged: true, generation: this.generation, ranking: clean });
    const report = buildReport(this.dir);
    writeJson(reportPath, report);
    fs4.writeFileSync(path4.join(this.dir, "report.md"), renderReportMd(report));
    return report;
  }
  /** Judge a finished evaluation: verified gain, bests, budget, target. */
  finish(c, o, queueWaitS, evaluatedHash) {
    const w = this.writers.get(c.writer_id);
    const ok = o.status === "ok" && o.metric != null;
    const m = ok ? o.metric : null;
    let ref = w.best ? w.best.metric : this.baseline.status === "ok" ? this.baseline.metric : null;
    if (this.cfg.gate.reference === "team_best_seen" && w.bestSeen != null && (ref == null || this.better(w.bestSeen, ref))) ref = w.bestSeen;
    let gain = null;
    if (ok && ref != null && ref !== 0) gain = this.cfg.metric.direction === "min" ? (ref - m) / ref : (m - ref) / Math.abs(ref);
    const verified = ok && gain != null && gain >= this.cfg.metric.min_gain - 1e-12;
    const isOwnBest = ok && (w.best == null || this.better(m, w.best.metric));
    const isTeamBest = ok && (this.teamBest == null || this.better(m, this.teamBest.metric));
    const counted = o.status === "ok" || o.status === "incorrect" || o.status === "recorded";
    const reached = ok && this.meetsTarget(m);
    const result = { cand_id: c.cand_id, writer_id: c.writer_id, session: c.session, status: o.status, metric: m, detail: o.detail, reference: ref, gain, verified_gain: verified, is_own_best: isOwnBest, is_team_best: isTeamBest, reached_target: reached, counted, queue_wait_s: round(queueWaitS, 2), eval_s: round(o.eval_s, 2), hash: c.hash, evaluated_hash: evaluatedHash };
    writeJson(path4.join(this.candDir(c.cand_id), "result.json"), result);
    this.emit("eval_result", result);
    if (this.cfg.shared.enabled) this.publishShared(c);
    if (this.state === "open") {
      if (reached && this.cfg.stop.on_target) this.close("target");
      else if (this.evalsLimit != null && this.counted >= this.evalsLimit) this.close("evals");
      else this.tick();
    }
    this.submitMs.delete(c.cand_id);
    const d = this.waiters.get(c.cand_id);
    this.waiters.delete(c.cand_id);
    d?.resolve();
    for (const r of this.slotWaiters.splice(0)) r();
    this.checkIdle();
  }
  publishShared(c) {
    try {
      copyDir(path4.join(this.candDir(c.cand_id), "src"), path4.join(this.sharedDir, c.writer_id, c.cand_id));
      const minute = round((this.clock.now() - this.startMs) / 6e4, 2);
      fs4.appendFileSync(path4.join(this.sharedDir, "index.tsv"), [c.writer_id, c.cand_id, minute, c.status, c.metric ?? ""].join("	") + "\n");
    } catch (e) {
      this.log("shared publish failed: " + e.message);
    }
  }
  inFlight() {
    let n = 0;
    for (const w of this.writers.values()) n += w.pending.size;
    return n;
  }
  busy() {
    return this.running > 0 || this.prechecking > 0 || [...this.cands.values()].some((c) => c.status === "pending");
  }
  checkIdle() {
    if (!this.busy()) for (const r of this.idleWaiters.splice(0)) r();
  }
  idle() {
    if (!this.busy()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
  // ---------- lessons ----------
  postLesson(a) {
    const w = this.writer(a.writer_id);
    this.checkIdentity(w.id, a.agent_id);
    if (typeof a.text !== "string") throw new ArgError("text is required");
    if (typeof a.cand_id !== "string") throw new ArgError("cand_id is required");
    const text = a.text.trim();
    const reject = (error, message, detail = {}) => {
      this.emit("lesson_rejected", { writer_id: w.id, cand_id: a.cand_id, error, chars: text.length, ...detail });
      if (this.cfg.lesson.keep_rejected) {
        try {
          appendLineSync(path4.join(this.dir, "rejected.jsonl"), { t: new Date(this.clock.now()).toISOString(), writer_id: w.id, cand_id: a.cand_id, error, ...detail, text }, false);
        } catch {
        }
      }
      return { error, message, ...detail };
    };
    this.tick();
    if (this.state === "closed") return reject("run_closed", "The run is closed; lessons are no longer accepted.");
    if (!this.cfg.board.enabled) return reject("board_disabled", `The lesson board is disabled in ${this.cfg.mode} mode.`);
    const c = this.cands.get(a.cand_id);
    if (!c || c.writer_id !== w.id || c.status === "pending") return reject("unknown_candidate", `${a.cand_id} is not one of your evaluated candidates. Attach the lesson to a candidate of yours whose evaluation has finished.`);
    if (!text) return reject("empty", "The lesson text is empty.");
    const bad = validateLessonText(text, this.cfg.lesson);
    if (bad) {
      const why = explainReject(bad, text, this.cfg.lesson);
      return reject(bad, why.message, { rule: why.rule, ...why.lines.length ? { lines: why.lines } : {} });
    }
    if (this.cfg.lesson.max_copy_chars > 0) {
      const texts = [];
      for (const d of [path4.join(this.candDir(c.cand_id), "src"), this.workDir(w.id)]) for (const b of safeBlobs(d, this.cfg.candidate.files)) texts.push(b);
      const span = copiedSpan(text, texts, this.cfg.lesson.max_copy_chars);
      if (span) return reject("contains_solution", `${COPY_MESSAGE} The passage starting "${span.excerpt}" (about character ${span.at + 1} of your lesson) repeats ${this.cfg.lesson.max_copy_chars} or more consecutive characters of your own files. Rephrase that passage; the rest can stay.`, { rule: `copy_chars=${this.cfg.lesson.max_copy_chars}`, at: span.at });
    }
    let corrects = null;
    if (a.corrects != null && a.corrects !== "") {
      const t = typeof a.corrects === "string" ? this.lessonStore.get(a.corrects) : void 0;
      const mayRef = t && this.lessons.includes(t) && (t.writer_id === w.id || w.delivered.has(t.lesson_id) || t.bseq != null && this.board().includes(t));
      if (!mayRef) return reject("unknown_lesson", `corrects must name a lesson of your own or one you received; ${JSON.stringify(a.corrects)} is neither.`);
      corrects = t.lesson_id;
    }
    if (w.lessonTexts.has(text)) return reject("duplicate", "You already posted this exact lesson.");
    if (c.lessons >= this.cfg.lesson.max_per_candidate) return reject("too_many_for_candidate", `${c.cand_id} already has ${c.lessons} lesson(s); the limit is ${this.cfg.lesson.max_per_candidate}. Attach new findings to a newer candidate.`);
    const evidence = { status: c.status, metric: c.metric, reference: c.reference, gain: c.gain == null ? null : round(c.gain, 4), verified_gain: c.verified_gain };
    const policy = this.cfg.push.policy;
    const gated = this.verifierOn;
    const pushed = !gated && (policy === "all" || !this.agentMode && policy === "verified" && c.verified_gain && c.lessons === 0);
    const seq = this.lessons.length + 1;
    const lesson = {
      lesson_id: "L" + pad(seq),
      seq,
      writer_id: w.id,
      cand_id: c.cand_id,
      minute: round((this.clock.now() - this.startMs) / 6e4, 2),
      evidence,
      header: gated ? verdictHeader(w.id, c.cand_id, "pending", "") : this.agentMode ? verdictHeader(w.id, c.cand_id, "unchecked", "") : lessonHeader(w.id, c.cand_id, evidence, this.cfg.metric),
      text,
      pushed,
      bseq: gated ? null : seq,
      verdict: gated ? "pending" : this.agentMode ? "unchecked" : null,
      verdict_note: "",
      ...corrects ? { corrects } : {}
    };
    appendLineSync(this.lessonsPath, lesson);
    this.lessonStore.set(lesson.lesson_id, lesson);
    this.emit("lesson_posted", { lesson_id: lesson.lesson_id, seq, writer_id: w.id, cand_id: c.cand_id, chars: text.length, pushed, ...corrects ? { corrects } : {} });
    for (const r of this.lessonWaiters.splice(0)) r();
    if (gated) return { lesson_id: lesson.lesson_id, pushed: false, status: "pending_verification", header: lesson.header, hint: "The verifier will check this lesson. If it is verified it is pushed to your teammates. Keep working." };
    return { lesson_id: lesson.lesson_id, pushed, header: lesson.header };
  }
  readLessons(a) {
    const w = this.writer(a.writer_id);
    this.checkIdentity(w.id, a.agent_id);
    if (!this.cfg.board.enabled) return { error: "board_disabled", message: `The lesson board is disabled in ${this.cfg.mode} mode.` };
    if (!this.cfg.board.pull) return { error: "pull_disabled", message: "read_lessons is off in this run. Lessons reach you only when they are pushed with a result." };
    if (this.cfg.read.require_own_correct && !w.best) return { error: "locked", message: "The board unlocks once you have your own correct candidate. Get one first." };
    const cursor = Number.isInteger(a.cursor) && a.cursor >= 0 ? a.cursor : 0;
    const limit = Math.min(20, Math.max(1, Number.isInteger(a.limit) ? a.limit : 10));
    const board = this.board();
    const others = board.filter((l) => l.bseq > cursor && l.writer_id !== w.id);
    const page = others.slice(0, limit);
    const next = page.length ? page[page.length - 1].bseq : Math.max(cursor, board.length ? board[board.length - 1].bseq : cursor);
    const view = page.map((l) => ({ lesson_id: l.lesson_id, seq: l.bseq, header: this.headerOf(l), text: l.text, pushed: l.pushed, already_delivered: w.delivered.has(l.lesson_id), ...l.corrects ? { corrects: l.corrects } : {} }));
    this.emit("lessons_read", { writer_id: w.id, from_seq: cursor, to_seq: next, count: page.length, chars: page.reduce((n, l) => n + l.text.length, 0), has_own_correct: !!w.best });
    return { lessons: view, next_cursor: next, remaining: others.length - page.length };
  }
  // ---------- verifier agent (agent verification) ----------
  registerVerifier(agentId, agentType) {
    if (typeof agentId !== "string" || !/^[A-Za-z0-9_.-]+$/.test(agentId) || this.agents.has(agentId)) return;
    const dir = path4.join(this.dir, "agents");
    const f = path4.join(dir, agentId + ".json");
    if (fs4.existsSync(f)) return;
    fs4.mkdirSync(path4.join(this.dir, "verifier"), { recursive: true });
    fs4.mkdirSync(dir, { recursive: true });
    writeJson(f, { agent_id: agentId, agent_type: agentType ?? null, role: "verifier", run_id: this.id, run_dir: this.dir, start_ms: this.startMs, scratch_dir: path4.join(this.dir, "verifier"), context_files: this.cfg.context_files.map((x) => path4.resolve(this.file.project_dir, x)) });
  }
  verifierGuard(agentId) {
    if (!this.verifierOn) throw new HostError("no_verifier", this.agentMode ? "The verifier is switched off in this run; lessons are not checked." : "This run gates lessons with an evaluation command; there is no verifier agent.");
    if (this.writerOfAgent(agentId)) throw new HostError("forbidden", "writers cannot verify lessons");
  }
  /** Hand the verifier the oldest lesson that still needs a verdict; waits when there is none. */
  async nextLesson(a) {
    this.verifierGuard(a.agent_id);
    if (!Number.isInteger(a.session) || a.session < 0) throw new ArgError("session must be a non-negative integer");
    if (!this.verifierSessions.has(a.session) || a.agent_id && !this.verifierAgents.has(a.agent_id)) this.emit("verifier_join", { session: a.session, agent_id: a.agent_id ?? null });
    const quota = this.cfg.verifier.session_quota;
    const sess = () => ({ index: a.session, verdicts: this.verifierSessions.get(a.session).verdicts, quota });
    const waitS = typeof a.wait_s === "number" && a.wait_s >= 0 ? Math.min(a.wait_s, 1500) : this.cfg.verifier.wait_s;
    const until = Date.now() + waitS * 1e3;
    for (; ; ) {
      this.tick();
      if (this.state === "closed") return { run_closed: true, message: "The run is closed. Return your structured result now.", session: sess() };
      if (sess().verdicts >= quota || this.verifierCurrent > a.session) return { must_hand_off: true, message: "This verifier session is used up. Return your structured result; the next session continues.", session: sess() };
      const now = this.clock.now();
      const l = this.lessons.find((x) => x.verdict === "pending" && (this.assigned.get(x.lesson_id) ?? 0) < now - 15 * 6e4);
      if (l) {
        this.assigned.set(l.lesson_id, now);
        return {
          lesson: { lesson_id: l.lesson_id, writer_id: l.writer_id, cand_id: l.cand_id, minute: l.minute, text: l.text },
          ...l.corrects && this.lessonStore.get(l.corrects) ? { corrects: { lesson_id: l.corrects, writer_id: this.lessonStore.get(l.corrects).writer_id, header: this.lessonStore.get(l.corrects).header, text: this.lessonStore.get(l.corrects).text } } : {},
          author_checkpoint_dir: path4.join(this.candDir(l.cand_id), "src"),
          author_work_dir: this.workDir(l.writer_id),
          author_notes_path: path4.join(this.writerDir(l.writer_id), "NOTES.md"),
          goal: this.cfg.goal,
          criteria: this.cfg.criteria,
          context_files: this.cfg.context_files.map((x) => path4.resolve(this.file.project_dir, x)),
          scratch_dir: path4.join(this.dir, "verifier"),
          pending: this.lessons.filter((x) => x.verdict === "pending").length,
          budget: this.budgetView(),
          session: sess()
        };
      }
      const left = until - Date.now();
      if (left <= 0) return { none: true, message: "No lesson is waiting. Call next_lesson again.", budget: this.budgetView(), session: sess() };
      let timer;
      await Promise.race([new Promise((r) => this.lessonWaiters.push(r)), new Promise((r) => timer = setTimeout(r, Math.min(left, 2e3)))]);
      clearTimeout(timer);
    }
  }
  verdict(a) {
    this.verifierGuard(a.agent_id);
    const l = this.lessonStore.get(a.lesson_id);
    if (!l || !this.lessons.includes(l)) throw new HostError("unknown_lesson", `no lesson ${a.lesson_id}`);
    if (l.verdict !== "pending") throw new HostError("already_decided", `${l.lesson_id} already has the verdict "${l.verdict}"`);
    if (!["verified", "partly_verified", "unverified", "refuted", "withheld"].includes(a.verdict)) throw new ArgError("verdict must be one of verified, partly_verified, unverified, refuted, withheld");
    const note = String(a.note ?? "").replace(/\s+/g, " ").trim();
    if (!note) throw new HostError("note_required", "Give a one-sentence note saying what you checked and what you found.");
    if (note.length > this.cfg.verifier.note_max_chars) throw new HostError("note_too_long", `The note is limited to ${this.cfg.verifier.note_max_chars} characters. The verifier reports a verdict; it does not rewrite or extend lessons.`);
    if (note.includes("```") || note.includes("~~~")) throw new HostError("note_has_code", "The note is one plain sentence without code.");
    const verdict = a.verdict;
    const policy = this.cfg.push.policy;
    const visible = verdict !== "withheld";
    const pushed = visible && policy !== "none" && (verdict === "verified" || verdict === "partly_verified" || policy === "all");
    const bseq = visible ? this.bseqMax + 1 : null;
    const header = verdictHeader(l.writer_id, l.cand_id, verdict, note);
    this.emit("lesson_verdict", { lesson_id: l.lesson_id, writer_id: l.writer_id, verdict, note, pushed, bseq, header, session: this.verifierCurrent, agent_id: a.agent_id ?? null });
    return { lesson_id: l.lesson_id, verdict, pushed, pending: this.lessons.filter((x) => x.verdict === "pending").length };
  }
  // ---------- status ----------
  status(writerId, deliver = false) {
    this.tick();
    if (writerId) {
      const w = this.writer(writerId);
      const out = { run_id: this.id, mode: this.cfg.mode, writer_id: w.id, own_best: w.best, candidates: w.candCount, pending: [...w.pending], budget: this.budgetView(), session: this.sessionView(w), baseline: this.baseline.metric, metric: this.cfg.metric };
      if (deliver && this.cfg.board.enabled && this.state === "open" && w.candCount > 0) out.pushed_lessons = this.deliver(w, "status");
      return out;
    }
    const count = (st) => [...this.cands.values()].filter((c) => c.status === st).length;
    return {
      run_id: this.id,
      run_dir: this.dir,
      mode: this.cfg.mode,
      n: this.cfg.n,
      budget: this.budgetView(),
      closed_reason: this.closedReason,
      confirmed: this.confirmed,
      baseline: this.baseline.metric,
      metric: this.cfg.metric,
      team_best: this.teamBest,
      writers: this.writerIds.map((id) => {
        const w = this.writers.get(id);
        const wait = this.waitingFor(w);
        return { writer_id: id, best: w.best, candidates: w.candCount, session: w.current, pending: w.pending.size, pushes_waiting: wait.count, oldest_push_wait_min: wait.oldest_wait_min, ...wait.count && w.candCount === 0 ? { waiting_because: "no checkpoint yet: pushes are held until the first one" } : wait.count ? { waiting_because: "pushes ride on the next checkpoint or status call" } : {} };
      }),
      evals: { ok: count("ok"), incorrect: count("incorrect"), build_error: count("build_error"), infra_error: count("infra_error"), pending: count("pending"), counted: this.counted },
      lessons: { posted: this.lessons.length, pushed: this.lessons.filter((l) => l.pushed).length, ...this.agentMode ? { pending: this.lessons.filter((l) => l.verdict === "pending").length } : {} },
      queue_length: [...this.queues.values()].reduce((n, q) => n + q.length, 0) + this.running,
      generation: this.generation,
      log_damage: this.damage
    };
  }
  // ---------- confirm ----------
  confirm(a) {
    if (!this.confirming) this.confirming = this.doConfirm(a).finally(() => this.confirming = null);
    return this.confirming;
  }
  async doConfirm(a) {
    const reportPath = path4.join(this.dir, "report.json");
    if (this.confirmed && fs4.existsSync(reportPath)) return readJson(reportPath);
    if (this.agentMode) return this.confirmJudged(a.ranking, reportPath);
    const topK = Number.isInteger(a.top_k) && a.top_k > 0 ? a.top_k : this.cfg.confirm.top_k;
    const replays = Number.isInteger(a.replays) && a.replays > 0 ? a.replays : this.cfg.confirm.replays;
    this.close("confirm");
    await this.idle();
    const seen = /* @__PURE__ */ new Set();
    const ranked = [...this.cands.values()].filter((c) => c.status === "ok" && c.metric != null).sort((x, y) => x.metric === y.metric ? x.cand_id.localeCompare(y.cand_id) : this.better(x.metric, y.metric) ? -1 : 1).filter((c) => seen.has(c.hash) ? false : (seen.add(c.hash), true));
    const confirmedList = [];
    const checked = [];
    for (const c of ranked.slice(0, this.cfg.confirm.max_candidates)) {
      if (confirmedList.length >= topK) break;
      const rs = [];
      for (let i = 0; i < replays; i++) {
        const o = await this.evalWithRetry(this.candDir(c.cand_id), c.cand_id);
        const m = o.status === "ok" ? o.metric : null;
        this.emit("confirm_replay", { cand_id: c.cand_id, replay: i + 1, status: o.status, metric: m });
        rs.push({ status: o.status, metric: m });
        if (o.status !== "ok") break;
      }
      const allOk = rs.length === replays && rs.every((r) => r.status === "ok");
      checked.push({ cand_id: c.cand_id, confirmed: allOk, replays: rs });
      if (allOk) confirmedList.push({ cand: c, metric: median(rs.map((r) => r.metric)), replays: rs.map((r) => r.metric) });
    }
    confirmedList.sort((x, y) => x.metric === y.metric ? 0 : this.better(x.metric, y.metric) ? -1 : 1);
    const win = confirmedList[0] ?? null;
    const winnerDir = path4.join(this.dir, "winner");
    fs4.rmSync(winnerDir, { recursive: true, force: true });
    if (win) copyDir(path4.join(this.candDir(win.cand.cand_id), "src"), winnerDir);
    this.emit("run_confirmed", { winner: win ? win.cand.cand_id : null, confirmed_metric: win ? win.metric : null, replays: win ? win.replays : [], checked });
    const report = buildReport(this.dir);
    writeJson(reportPath, report);
    fs4.writeFileSync(path4.join(this.dir, "report.md"), renderReportMd(report));
    return report;
  }
};

// src/core/host.ts
function commandEvalFn(cfg, projectDir2) {
  return (ctx) => {
    const spec = ctx.kind === "precheck" ? { ...cfg.eval, ...cfg.eval.precheck } : cfg.eval;
    return runCommand({ command: spec.command, cwd: spec.cwd, timeout_s: spec.timeout_s }, path5.resolve(projectDir2, spec.cwd), { candidate_dir: ctx.candidate_dir, run_dir: ctx.run_dir, cand_id: ctx.cand_id });
  };
}
var str = (a, k, required = true) => {
  if (a[k] == null) {
    if (required) throw new ArgError(`${k} is required`);
    return void 0;
  }
  if (typeof a[k] !== "string") throw new ArgError(`${k} must be a string`);
  return a[k];
};
var num = (a, k) => {
  if (a[k] == null) return void 0;
  const v = typeof a[k] === "string" && a[k].trim() !== "" ? Number(a[k]) : a[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`${k} must be a number`);
  return v;
};
var Host = class {
  projectDir;
  clock;
  evalFactory;
  runs = /* @__PURE__ */ new Map();
  locks = /* @__PURE__ */ new Set();
  constructor(opts) {
    this.projectDir = fs5.realpathSync(opts.projectDir);
    this.clock = opts.clock ?? realClock;
    this.evalFactory = opts.evalFactory ?? commandEvalFn;
  }
  get runsDir() {
    return path5.join(this.projectDir, ".lessonshare", "runs");
  }
  /** Dispatch one tool call. Business refusals come back as {error, message}; ArgError propagates. */
  async call(tool, args) {
    const a = isObj(args) ? args : {};
    try {
      switch (tool) {
        case "init_run":
          return await this.initRun(a);
        case "join":
          return this.run(a).join({ writer_id: str(a, "writer_id"), session: num(a, "session") ?? 0, agent_id: a._harness_agent_id, agent_type: a._harness_agent_type });
        case "evaluate":
          return await this.run(a).evaluate({ writer_id: str(a, "writer_id"), note: str(a, "note", false), used_lessons: a.used_lessons, agent_id: a._harness_agent_id });
        case "get_result":
          return await this.run(a).getResult({ writer_id: str(a, "writer_id"), cand_id: str(a, "cand_id"), wait_s: num(a, "wait_s"), agent_id: a._harness_agent_id });
        case "post_lesson":
          return this.run(a).postLesson({ writer_id: str(a, "writer_id"), cand_id: str(a, "cand_id"), text: str(a, "text"), corrects: str(a, "corrects", false), agent_id: a._harness_agent_id });
        case "read_lessons":
          return this.run(a).readLessons({ writer_id: str(a, "writer_id"), cursor: num(a, "cursor"), limit: num(a, "limit"), agent_id: a._harness_agent_id });
        case "status": {
          const run = this.run(a);
          const forced = run.writerOfAgent(a._harness_agent_id);
          const wid = str(a, "writer_id", false);
          if (forced && wid && wid !== forced) throw new HostError("identity_mismatch", `this agent is registered as ${forced}`);
          return run.status(forced ?? wid, !!forced);
        }
        case "confirm": {
          const run = this.run(a);
          if (run.writerOfAgent(a._harness_agent_id)) throw new HostError("forbidden", "writers cannot confirm a run");
          this.maybeVerifier(run, a);
          return await run.confirm({ top_k: num(a, "top_k"), replays: num(a, "replays"), ranking: a.ranking });
        }
        case "next_lesson": {
          const run = this.run(a);
          this.maybeVerifier(run, a);
          return await run.nextLesson({ session: num(a, "session") ?? 0, wait_s: num(a, "wait_s"), agent_id: a._harness_agent_id });
        }
        case "verdict": {
          const run = this.run(a);
          this.maybeVerifier(run, a);
          return run.verdict({ lesson_id: str(a, "lesson_id"), verdict: str(a, "verdict"), note: str(a, "note", false), agent_id: a._harness_agent_id });
        }
        default:
          throw new ArgError(`unknown tool "${tool}"`);
      }
    } catch (e) {
      if (e instanceof HostError) return { error: e.code, message: e.message, ...e.extra };
      throw e;
    }
  }
  /** Agents of a verifier type get a guard mapping (read the run, write only their scratch directory). */
  maybeVerifier(run, a) {
    if (typeof a._harness_agent_type === "string" && /^lessonshare[:-]verifier/.test(a._harness_agent_type)) run.registerVerifier(a._harness_agent_id, a._harness_agent_type);
  }
  tick() {
    for (const r of this.runs.values()) r.tick();
  }
  // ---------- run registry, locking, recovery ----------
  run(a) {
    const id = str(a, "run_id");
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new ArgError("invalid run_id");
    const cached = this.runs.get(id);
    if (cached) return cached;
    const dir = path5.join(this.runsDir, id);
    if (!fs5.existsSync(path5.join(dir, "run.json"))) throw new HostError("unknown_run", `no run "${id}" in ${this.runsDir}`);
    this.lock(dir);
    const file = readJson(path5.join(dir, "run.json"));
    const run = new Run(dir, file, this.clock, this.evalFactory(file.config, this.projectDir));
    run.recover();
    run.log("run loaded from disk");
    this.runs.set(id, run);
    return run;
  }
  /**
   * Take ownership of a run directory. Creation of server.lock is atomic (a hard link to a private file, so the
   * lock appears with its content or not at all): of any number of processes, exactly one gets it. A lock whose
   * owner is dead is replaced under a second, short-lived mutex, so two processes can never both replace it.
   */
  lock(dir) {
    const f = path5.join(dir, "server.lock");
    const me = { pid: process.pid, started: new Date(this.clock.now()).toISOString(), token: crypto2.randomBytes(8).toString("hex") };
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code === "EPERM";
      }
    };
    const create = () => {
      const tmp = `${f}.${process.pid}.${me.token}`;
      fs5.writeFileSync(tmp, JSON.stringify(me) + "\n");
      try {
        fs5.linkSync(tmp, f);
        return true;
      } catch (e) {
        const code = e.code;
        if (code === "EEXIST") return false;
        try {
          fs5.writeFileSync(f, JSON.stringify(me) + "\n", { flag: "wx" });
          return true;
        } catch (e2) {
          if (e2.code === "EEXIST") return false;
          throw e2;
        }
      } finally {
        fs5.rmSync(tmp, { force: true });
      }
    };
    const read = () => {
      try {
        const cur = readJson(f);
        return Number.isInteger(cur?.pid) ? cur : null;
      } catch {
        return null;
      }
    };
    let unreadable = 0;
    for (let attempt = 0; attempt < 400; attempt++) {
      if (create()) {
        this.locks.add(f);
        return;
      }
      const cur = read();
      if (!fs5.existsSync(f)) continue;
      if (cur && cur.pid === process.pid) {
        this.locks.add(f);
        return;
      }
      if (cur && alive(cur.pid)) throw new HostError("run_locked", `run is owned by live process ${cur.pid}. If that process is not a LessonShare board server (the pid was reused after a crash), delete ${f} and retry.`);
      if (!cur && ++unreadable < 20) {
        sleep(10);
        continue;
      }
      const mutex = f + ".takeover";
      try {
        fs5.mkdirSync(mutex);
      } catch {
        try {
          if (Date.now() - fs5.statSync(mutex).mtimeMs > 1e4) fs5.rmdirSync(mutex);
        } catch {
        }
        sleep(10);
        continue;
      }
      try {
        const again = read();
        const same = cur ? again?.pid === cur.pid : again == null;
        if (same && fs5.existsSync(f) && !(again && alive(again.pid))) fs5.rmSync(f, { force: true });
      } finally {
        fs5.rmdirSync(mutex);
      }
    }
    throw new HostError("run_locked", `could not take ownership of ${dir}: the lock kept changing hands`);
  }
  releaseLocks() {
    for (const f of this.locks) {
      try {
        if (readJson(f).pid === process.pid) fs5.unlinkSync(f);
      } catch {
      }
    }
    this.locks.clear();
  }
  // ---------- init_run ----------
  async initRun(a) {
    const budget = isObj(a.budget) ? a.budget : {};
    if (a.resume_run_id != null) {
      const run2 = this.run({ run_id: a.resume_run_id });
      const n2 = num(a, "n");
      if (n2 != null && n2 !== run2.writerIds.length) throw new HostError("roster_mismatch", `run ${run2.id} has ${run2.writerIds.length} writers (${run2.writerIds[0]}..${run2.writerIds[run2.writerIds.length - 1]}); it cannot be resumed with n=${n2}. Leave n out to resume it as it is.`);
      const damage = run2.logDamage();
      if (a.recover === true) {
        run2.tick();
        if (run2.state === "closed") throw new HostError("run_closed", `run ${run2.id} is closed (${run2.closedReason}); recover only continues a run that is still open. Pass budget.minutes without "recover" to reopen it with more time.`);
        return this.initResult(run2, [`Run ${run2.id} recovered: ${run2.minutesLeft()} minute(s) left of its original budget.`, ...damage], true);
      }
      const minutes = num(budget, "minutes") ?? run2.cfg.budget.minutes;
      if (!(minutes > 0)) throw new ArgError("budget.minutes must be positive");
      run2.reopen(minutes, num(budget, "evals") ?? null);
      return this.initResult(run2, [`Run ${run2.id} reopened with ${minutes} more minute(s), counted from now.`, ...damage], true);
    }
    const taskPath = str(a, "task_path", false) ?? ".lessonshare/task.json";
    const mode = str(a, "mode", false) ?? "lessonshare";
    const n = num(a, "n") ?? 8;
    const task = loadTaskFile(this.projectDir, taskPath);
    const settings = { ...this.projectSettings(), ...isObj(a.settings) ? a.settings : {} };
    if (a.settings != null && !isObj(a.settings)) throw new ArgError("settings must be an object");
    const cfg = buildConfig(this.projectDir, task, mode, n, budget, a.overrides, settings);
    const now = this.clock.now();
    const ts = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const runId = `r-${ts}-${crypto2.randomBytes(2).toString("hex").slice(0, 3)}`;
    const dir = path5.join(this.runsDir, runId);
    fs5.mkdirSync(path5.join(dir, "candidates"), { recursive: true });
    this.lock(dir);
    const agentMode = cfg.verify.kind === "agent";
    const seedAbs = cfg.candidate.seed != null ? resolveInside(this.projectDir, cfg.candidate.seed, "candidate.seed") : null;
    const ids = writerIds(n);
    for (const id of ids) {
      fs5.mkdirSync(path5.join(dir, "writers", id, "work"), { recursive: true });
      if (seedAbs) copyDir(seedAbs, path5.join(dir, "writers", id, "work"));
      for (const f of cfg.context_files) {
        const src = resolveInside(this.projectDir, f, "context_files");
        if (!fs5.existsSync(src) || !fs5.statSync(src).isFile()) throw new HostError("invalid_task", `context file "${f}" does not exist`);
        const dst = path5.join(dir, "writers", id, "context", f);
        fs5.mkdirSync(path5.dirname(dst), { recursive: true });
        fs5.copyFileSync(src, dst);
      }
    }
    if (cfg.shared.enabled) fs5.mkdirSync(path5.join(dir, "shared"), { recursive: true });
    const evalFn = this.evalFactory(cfg, this.projectDir);
    const warnings = [];
    let baseline;
    if (agentMode) {
      baseline = { status: "none", metric: null, noise: null, runs: [] };
      if (!cfg.criteria.trim()) warnings.push('No criteria given. The verifier and the final judge only have the goal to judge by; add "criteria" to the task file to say what a good result looks like.');
    } else {
      const seedSnap = path5.join(dir, "candidates", "seed", "src");
      const seedFiles = matchFiles(seedAbs, cfg.candidate.files);
      if (!seedFiles.length) throw new HostError("invalid_task", "candidate.files matches nothing in the seed directory");
      writeBlobs(seedSnap, readBlobs(seedAbs, seedFiles));
      const runs = [];
      let log = "";
      for (let i = 0; i < cfg.baseline_runs; i++) {
        let o = await evalFn({ kind: "eval", candidate_dir: seedSnap, run_dir: dir, cand_id: "seed" });
        if (o.status === "infra_error") o = await evalFn({ kind: "eval", candidate_dir: seedSnap, run_dir: dir, cand_id: "seed" });
        log += `=== baseline run ${i + 1} ===
${o.log}
`;
        runs.push({ status: o.status, metric: o.status === "ok" ? o.metric : null });
        if (o.status === "infra_error") {
          fs5.writeFileSync(path5.join(dir, "candidates", "seed", "eval.log"), log);
          this.releaseOne(dir);
          throw new HostError("baseline_infra_error", `The evaluator failed on the seed candidate: ${o.detail}`, { eval_log_tail: tailLines(o.log, 40) });
        }
      }
      fs5.writeFileSync(path5.join(dir, "candidates", "seed", "eval.log"), log);
      if (runs.every((r) => r.status === "ok")) {
        const ms = runs.map((r) => r.metric);
        const med = median(ms);
        const noise = med !== 0 ? round((Math.max(...ms) - Math.min(...ms)) / Math.abs(med), 5) : 0;
        baseline = { status: "ok", metric: med, noise, runs };
        if (noise >= cfg.metric.min_gain) warnings.push(`Evaluation noise (${(noise * 100).toFixed(2)}%) is not below metric.min_gain (${(cfg.metric.min_gain * 100).toFixed(2)}%). Noise may be pushed as verified gains. Suggested min_gain: ${Math.max(0.01, round(2 * noise, 4))}. The host did not change it.`);
      } else {
        const bad = runs.find((r) => r.status !== "ok");
        baseline = { status: bad.status, metric: null, noise: null, runs };
        warnings.push(`Baseline is ${bad.status}: the seed candidate is not correct. A writer's first correct candidate will not count as a verified gain.`);
      }
    }
    if (n < 8) warnings.push(`N=${n} is below 8. In the paper, lessons did not beat the alternatives at N=4 (41% vs 53% for an orchestrated team); they led or tied from N=8 (R9).`);
    if (cfg.budget.evals != null && cfg.budget.evals < n * 20) warnings.push(`budget.evals=${cfg.budget.evals} is below N x 20 = ${n * 20}. Tight evaluation caps suppressed every team design in the paper (R10).`);
    if (cfg.budget.minutes < 60) warnings.push(`budget.minutes=${cfg.budget.minutes} is short. In the paper most of the benefit of sharing appeared in the second hour (R10).`);
    const gi = (0, import_node_child_process2.spawnSync)("git", ["check-ignore", "-q", path5.join(".lessonshare", "runs", "x")], { cwd: this.projectDir });
    if (gi.status === 1) warnings.push('.lessonshare/runs/ is not ignored by git. Add ".lessonshare/runs/" to .gitignore.');
    const file = { run_id: runId, created: new Date(now).toISOString(), project_dir: this.projectDir, config: cfg, baseline, writers: ids };
    writeJson(path5.join(dir, "run.json"), file);
    const run = new Run(dir, file, this.clock, evalFn);
    this.runs.set(runId, run);
    run.start();
    run.log(`run created: mode=${mode} n=${n}`);
    return this.initResult(run, warnings, false);
  }
  projectSettings() {
    const f = path5.join(this.projectDir, ".lessonshare", "settings.json");
    if (!fs5.existsSync(f)) return {};
    try {
      const s = JSON.parse(fs5.readFileSync(f, "utf8"));
      if (!isObj(s)) throw new Error("not an object");
      return s;
    } catch (e) {
      throw new HostError("invalid_settings", `.lessonshare/settings.json is not a valid JSON object: ${e.message}`);
    }
  }
  releaseOne(dir) {
    const f = path5.join(dir, "server.lock");
    try {
      fs5.unlinkSync(f);
    } catch {
    }
    this.locks.delete(f);
  }
  initResult(run, warnings, resumed) {
    return {
      run_id: run.id,
      run_dir: run.dir,
      writers: run.writerIds,
      baseline: { status: run.baseline.status, metric: run.baseline.metric, noise: run.baseline.noise },
      verify_kind: run.cfg.verify.kind,
      verifier: run.verifierOn,
      settings: effectiveSettings(run.cfg),
      session_base: resumed ? run.maxSession() + 1 : 0,
      generation: run.generation,
      minutes_left: run.minutesLeft(),
      resumed,
      config: run.cfg,
      warnings
    };
  }
};

// src/cli/cli.ts
var USAGE = `lessonshare <command>

  runs                               list runs in this project
  board <run_id> [--follow]          print the lesson board in time order
  report <run_id>                    print report.md, or the current state if not confirmed
  eval <task.json> <candidate_dir>   run the evaluation command once and show how the host parses it
  calibrate <task.json> [--runs 10]  evaluate the seed repeatedly; print noise and a suggested min_gain
  call <tool> '<json-args>'          call a host tool directly (fallback when MCP is unavailable)

The project directory is the current directory (or $LESSONSHARE_PROJECT_DIR).`;
var projectDir = () => fs6.realpathSync(process.env.LESSONSHARE_PROJECT_DIR && !process.env.LESSONSHARE_PROJECT_DIR.includes("${") ? process.env.LESSONSHARE_PROJECT_DIR : process.cwd());
var runsDir = () => path6.join(projectDir(), ".lessonshare", "runs");
var fail = (msg) => {
  process.stderr.write(msg + "\n");
  process.exit(1);
};
function runDir(id) {
  if (!id) fail('run_id is required. Use "lessonshare runs" to list runs.');
  const d = path6.join(runsDir(), id);
  if (!fs6.existsSync(path6.join(d, "run.json"))) fail(`no run "${id}" in ${runsDir()}`);
  return d;
}
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : void 0;
}
function cmdRuns() {
  let names = [];
  try {
    names = fs6.readdirSync(runsDir()).sort();
  } catch {
  }
  if (!names.length) return console.log("no runs in " + runsDir());
  for (const id of names) {
    const d = path6.join(runsDir(), id);
    if (!fs6.existsSync(path6.join(d, "run.json"))) continue;
    const rf = readJson(path6.join(d, "run.json"));
    const evs = readJsonl(path6.join(d, "events.jsonl"));
    let state = "open";
    let best = null;
    for (const e of evs) {
      if (e.type === "run_closed") state = "closed:" + e.reason;
      if (e.type === "run_reopened") state = "open";
      if (e.type === "run_confirmed") state = "confirmed";
      if (e.type === "eval_result" && e.is_team_best) best = e.metric;
    }
    console.log(`${id}  ${rf.config.mode.padEnd(16)} n=${String(rf.config.n).padEnd(3)} ${state.padEnd(16)} task=${rf.config.name}  baseline=${rf.baseline.metric == null ? "-" : fmtNum(rf.baseline.metric)}  best=${best == null ? "-" : fmtNum(best)}`);
  }
}
async function cmdBoard(args) {
  const d = runDir(args[0]);
  const file = path6.join(d, "lessons.jsonl");
  let shown = 0;
  const done = /* @__PURE__ */ new Set();
  const print = () => {
    const verdicts = /* @__PURE__ */ new Map();
    for (const e of readJsonl(path6.join(d, "events.jsonl"))) if (e.type === "lesson_verdict") verdicts.set(e.lesson_id, e);
    for (const l of readJsonl(file)) {
      if (done.has(l.lesson_id)) continue;
      const v = verdicts.get(l.lesson_id);
      if (l.verdict === "pending" && !v && args.includes("--follow")) continue;
      const header = v ? v.header : l.header;
      const pushed = v ? v.pushed : l.pushed;
      const tag = v?.verdict === "withheld" ? "HIDDEN" : pushed ? "PUSHED" : "board ";
      console.log(`${l.lesson_id}  min ${l.minute}  ${tag}  ${header}${l.corrects ? `  (corrects ${l.corrects})` : ""}
${l.text}
`);
      done.add(l.lesson_id);
      shown++;
    }
  };
  print();
  if (!shown && !args.includes("--follow")) console.log("(no lessons)");
  if (args.includes("--follow")) for (; ; ) {
    await new Promise((r) => setTimeout(r, 2e3));
    print();
  }
}
function cmdReport(args) {
  const d = runDir(args[0]);
  const md = path6.join(d, "report.md");
  if (fs6.existsSync(md) && readJsonl(path6.join(d, "events.jsonl")).some((e) => e.type === "run_confirmed")) return process.stdout.write(fs6.readFileSync(md, "utf8"));
  console.log("(run not confirmed; current state)\n");
  process.stdout.write(renderReportMd(buildReport(d)));
}
async function evalOnce(taskPath, candDir) {
  const proj = projectDir();
  const cfg = buildConfig(proj, loadTaskFile(proj, taskPath), "lessonshare", 1, {}, {});
  const tmp = fs6.mkdtempSync(path6.join(os.tmpdir(), "lessonshare-eval-"));
  const fn = commandEvalFn(cfg, proj);
  return { cfg, run: () => fn({ kind: "eval", candidate_dir: path6.resolve(candDir), run_dir: tmp, cand_id: "try" }) };
}
async function cmdEval(args) {
  if (args.length < 2) fail("usage: lessonshare eval <task.json> <candidate_dir>");
  const { cfg, run } = await evalOnce(args[0], args[1]);
  const o = await run();
  console.log(o.log.trimEnd());
  console.log("\n--- host view ---");
  console.log(JSON.stringify({ status: o.status, metric: o.metric, detail: o.detail, eval_s: round(o.eval_s, 2) }, null, 2));
  if (o.status === "infra_error") {
    console.log('\nContract problem: the last non-empty stdout line must be a JSON object like {"status":"ok","metric":1.12,"detail":"..."}; the process must exit 0.');
    process.exit(2);
  }
  const perHour = 3600 * cfg.eval.concurrency / Math.max(o.eval_s, 1e-3);
  console.log(`
Throughput at eval.concurrency=${cfg.eval.concurrency}: about ${Math.round(perHour)} evaluations/hour for the whole team.`);
}
async function cmdCalibrate(args) {
  if (!args[0]) fail("usage: lessonshare calibrate <task.json> [--runs 10]");
  const runs = Number(flag(args, "--runs") ?? 10);
  const proj = projectDir();
  const task = loadTaskFile(proj, args[0]);
  const { cfg, run } = await evalOnce(args[0], path6.resolve(proj, task.candidate?.seed ?? "."));
  const ms = [];
  let secs = 0;
  for (let i = 0; i < runs; i++) {
    const o = await run();
    secs += o.eval_s;
    console.log(`run ${i + 1}: ${o.status}${o.metric == null ? "" : " " + fmtNum(o.metric)} (${round(o.eval_s, 2)}s)${o.status === "ok" ? "" : " " + o.detail}`);
    if (o.status !== "ok") fail(`seed is not ok (${o.status}); fix the seed or the evaluator before calibrating.`);
    ms.push(o.metric);
  }
  const med = median(ms);
  const noise = med !== 0 ? (Math.max(...ms) - Math.min(...ms)) / Math.abs(med) : 0;
  const suggested = Math.max(0.01, round(2 * noise, 4));
  console.log(JSON.stringify({ baseline: med, noise: round(noise, 5), min_gain_configured: cfg.metric.min_gain, min_gain_suggested: suggested, mean_eval_s: round(secs / runs, 2), evals_per_hour_team: Math.round(3600 * cfg.eval.concurrency / Math.max(secs / runs, 1e-3)) }, null, 2));
  if (noise >= cfg.metric.min_gain) console.log(`WARNING: noise ${(noise * 100).toFixed(2)}% is not below min_gain ${(cfg.metric.min_gain * 100).toFixed(2)}%. Set metric.min_gain to ${suggested} in the task file.`);
}
async function cmdCall(args) {
  if (!args[0]) fail("usage: lessonshare call <tool> '<json-args>'");
  const host = new Host({ projectDir: projectDir() });
  try {
    const out = await host.call(args[0], args[1] ? JSON.parse(args[1]) : {});
    console.log(JSON.stringify(out, null, 2));
  } finally {
    host.releaseLocks();
  }
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "runs":
        return cmdRuns();
      case "board":
        return await cmdBoard(args);
      case "report":
        return cmdReport(args);
      case "eval":
        return await cmdEval(args);
      case "calibrate":
        return await cmdCalibrate(args);
      case "call":
        return await cmdCall(args);
      default:
        console.log(USAGE);
        process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
    }
  } catch (e) {
    fail(`error: ${e.message}`);
  }
}
main();
