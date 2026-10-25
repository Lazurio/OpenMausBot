import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrationDiagnostic, validModelCache } from "./lazurio-migration-contract.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const data = "/work/data";
const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
const duration = Number(process.env.MIGRATION_OBSERVE_MS);
if (!Number.isSafeInteger(duration) || duration < 90_000 || duration > 300_000) throw new Error("invalid-observation-period");
let child;
let logFd;
let candidateStarted = false;
let phase = "admission";
const result = { status: "BLOCKED", scenarios: [], reason: "not-started", browser: "NOT_RUN" };
const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizedSql = (sql) => sql.replace(/\bIF NOT EXISTS\s+/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
const schemaAdditions = {
  messages_thread_at: "CREATE INDEX messages_thread_at ON messages(thread_id, at)",
  notification_log: `CREATE TABLE notification_log (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
    bot_id TEXT NOT NULL, bot_name TEXT NOT NULL, thread_id TEXT NOT NULL,
    group_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, avatar_url TEXT,
    read INTEGER NOT NULL DEFAULT 0
  )`,
  notification_log_at: "CREATE INDEX notification_log_at ON notification_log(at)",
};
function rows(db, table) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    ? db.prepare(`SELECT * FROM ${table}`).all().map(stable).sort() : [];
}
function snapshot() {
  const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
  let tables;
  let schema;
  try {
    schema = Object.fromEntries(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL").all().map((row) => [row.name, row.sql]));
    for (const table of ["messages", "thread_state", "chat_followups", "command_receipts", "memory_files"]) check(Boolean(schema[table]), "required-table-missing");
    check(db.prepare("PRAGMA quick_check").all().every((row) => row.quick_check === "ok"), "database-integrity-failed");
    check(rows(db, "chat_followups").length === 0, "followups-present");
    check(rows(db, "notification_log").length === 0, "automatic-notification-created");
    tables = Object.fromEntries(["messages", "thread_state", "command_receipts", "memory_files"].map((table) => [table, rows(db, table)]));
    check(!tables.messages.some((line) => {
      const row = JSON.parse(line);
      return row.kind === "goal.run" && JSON.parse(row.json).goalRun?.status === "working";
    }), "working-goal-present");
  } finally { db.close(); }
  const protectedFiles = {};
  for (const directory of ["attachments", "events", "native", "checkpoints"]) {
    const root = join(data, directory);
    const walk = (path) => {
      if (!existsSync(path)) return;
      const stat = lstatSync(path);
      check(!stat.isSymbolicLink(), "fixture-link");
      if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
      else protectedFiles[relative(data, path)] = hash(readFileSync(path));
    };
    walk(root);
  }
  const files = {};
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const stat = lstatSync(full);
      check(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), "unsafe-output-file");
      if (stat.isDirectory()) walk(full);
      else files[relative(data, full)] = hash(readFileSync(full));
    }
  };
  walk(data);
  return { bots: JSON.parse(readFileSync(join(data, "bots.json"), "utf8")), config: readFileSync(join(data, "config.json"), "utf8"), tables, schema, protectedFiles, files };
}
function noWork() {
  if (existsSync("/work/network-events.ndjson")) check(!readFileSync("/work/network-events.ndjson", "utf8").split("\n").filter(Boolean).some((line) => JSON.parse(line).kind === "denied-network-request"), "candidate-network-request-denied");
  if (existsSync("/work/guard-events.ndjson")) check(!readFileSync("/work/guard-events.ndjson", "utf8").split("\n").filter(Boolean).some((line) => JSON.parse(line).kind === "denied"), "engine-generation-or-unknown-request");
  if (existsSync(join(data, "runtime.db"))) {
    const db = new DatabaseSync(join(data, "runtime.db"), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      check(rows(db, "assignments").length === 0, "automatic-assignment-created");
    } finally { db.close(); }
  }
  for (const file of ["routines.json", "webhooks.json", "github-intake.json"]) check(!existsSync(join(data, file)), "automatic-work-file-created");
}
async function stop() {
  if (!child) return;
  const process = child;
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGTERM");
    const end = Date.now() + 5_000;
    while (process.exitCode === null && process.signalCode === null && Date.now() < end) await sleep(50);
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
      await new Promise((resolve) => process.once("close", resolve));
      throw new Error("candidate-required-sigkill");
    }
  }
  child = undefined;
  if (logFd !== undefined) { closeSync(logFd); logFd = undefined; }
}
async function boot(pass) {
  logFd = openSync(`/work/candidate-${pass}.log`, "a", 0o600);
  child = spawn("/bin/node", ["/candidate/cli.js", "serve", "--no-pair", "--port", "19971", "--data-dir", data], {
    cwd: "/work/cwd", env: {
      HOME: "/work/home", USERPROFILE: "/work/home", PATH: "/harness/bin", TZ: "UTC", LANG: "C.UTF-8",
      XDG_CONFIG_HOME: "/work/home/.config", XDG_CACHE_HOME: "/work/home/.cache", XDG_DATA_HOME: "/work/home/.local/share", XDG_RUNTIME_DIR: "/work/run",
      TMPDIR: "/tmp", OMB_DATA_DIR: data, OMB_DEFAULT_BOT_CWD: "/work/cwd", OMB_WEBHOOK_PORT: "19972", OMB_TEST_SEALED_PATH: "1",
      NODE_OPTIONS: "--import=/harness/lazurio-migration-network-guard.mjs",
    }, stdio: ["ignore", logFd, logFd],
  });
  candidateStarted = true;
  child.on("error", () => { result.reason = "candidate-spawn-error"; });
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    check(child.exitCode === null && child.signalCode === null, "candidate-exited");
    noWork();
    try {
      const reply = await fetch("http://127.0.0.1:19971/api/health", { signal: AbortSignal.timeout(500), redirect: "error" });
      ready = reply.ok && (await reply.json()).app === "openmausbot";
    } catch { /* Startup polling has a bounded deadline. */ }
    if (ready) break;
    await sleep(100);
  }
  check(ready, "candidate-not-ready");
  const end = Date.now() + duration;
  while (Date.now() < end) {
    check(child.exitCode === null && child.signalCode === null, "candidate-exited");
    noWork();
    await sleep(250);
  }
  await stop();
  noWork();
}
function compare(before, after, second = false) {
  for (const [name, sql] of Object.entries(before.schema)) check(after.schema[name] === sql, "existing-schema-changed");
  for (const [name, sql] of Object.entries(after.schema)) {
    if (before.schema[name] === undefined) check(!second && schemaAdditions[name] && normalizedSql(schemaAdditions[name]) === normalizedSql(sql), "unexpected-schema-addition");
  }
  for (const [name, sql] of Object.entries(schemaAdditions)) check(typeof after.schema[name] === "string" && normalizedSql(after.schema[name]) === normalizedSql(sql), "expected-schema-missing");
  check(stable(before.tables) === stable(after.tables), "message-or-memory-content-changed");
  check(stable(before.protectedFiles) === stable(after.protectedFiles), "protected-files-changed");
  check(before.config === after.config, "config-file-changed");
  check(before.bots.length === after.bots.length, "bot-count-changed");
  const operational = /^(?:messages\.db(?:-wal|-shm)?|runtime\.db(?:-wal|-shm)?|openmausbot-server\.lease|sessions\.json(?:\.open)?)$/;
  const markers = new Set(["thread-model-copies-cleared", "asked-at-filled"]);
  for (const file of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (before.files[file] === after.files[file] || operational.test(file) || file === "bots.json") continue;
    if (!second && !before.files[file] && file === "environment-id") {
      check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\s*$/.test(readFileSync(join(data, file), "utf8")), "invalid-new-environment-identity");
      continue;
    }
    if (!second && !before.files[file] && /^providers\/engine-models\/(?:codex|claude|claudeApi|cursor)\.json$/.test(file)) {
      check(validModelCache(JSON.parse(readFileSync(join(data, file), "utf8"))), "invalid-new-model-cache");
      continue;
    }
    if (!second && markers.has(file) && !before.files[file] && after.files[file]) continue;
    const mirror = before.bots.find((bot) => file === `bots/${bot.id}/SOUL.md`);
    if (!second && mirror && !before.files[file] && after.files[file] === hash(mirror.soul)) continue;
    throw new Error("unapproved-file-change");
  }
  if (second) { check(stable(before.bots) === stable(after.bots), "second-start-not-idempotent"); return; }
  const deleted = ["computer", "cloudBackend", "autoStartVps", "browser", "browserProfile", "recordBrowserSteps", "composio", "connectorTools", "connectorScopes", "mcpServers", "outbound", "approvalGrant", "approvePeerComms", "toolScope"];
  const messages = before.tables.messages.map((row) => JSON.parse(row));
  const max = (items) => items.length ? Math.max(...items) : undefined;
  for (const [index, original] of before.bots.entries()) {
    const actual = structuredClone(after.bots[index]);
    const expected = structuredClone(original);
    for (const key of deleted) { check(!(key in actual), "removed-bot-field-retained"); delete expected[key]; }
    for (const key of ["busy", "activity"]) { delete actual[key]; delete expected[key]; }
    check(expected.tasks.length === actual.tasks.length, "thread-count-changed");
    for (const [i, task] of expected.tasks.entries()) {
      const next = actual.tasks[i];
      for (const key of ["surface", "surfaceSource"]) { check(!(key in next), "removed-thread-field-retained"); delete task[key]; }
      if (!before.files["thread-model-copies-cleared"] && stable(task.modelSelection) === stable(original.modelSelection)) { delete task.modelSelection; check(!("modelSelection" in next), "redundant-model-retained"); }
      const lines = messages.filter((row) => row.thread_id === task.threadId).map((row) => ({ ...row, payload: JSON.parse(row.json) }));
      const newest = max(lines.map((row) => row.at));
      const ordered = max(lines.filter((row) => row.role === "user" && row.payload.peerAsk == null
        || row.role === "bot" && row.kind === "text" && (row.payload.turnTerminal === true || row.payload.turnTerminal === 1 || row.payload.turnId == null))
        .map((row) => row.payload.turnCompletedAt ?? row.at));
      const asked = max(lines.filter((row) => row.role === "user" && row.kind === "text" && row.payload.sendId != null && row.payload.peerAsk == null && row.payload.relayed == null).map((row) => row.at));
      task.updatedAt = newest !== undefined && (task.updatedAt === undefined || newest > task.updatedAt) ? newest : task.updatedAt ?? task.createdAt;
      if (ordered !== undefined) task.lastThreadOrderAt = Math.max(task.lastThreadOrderAt ?? task.createdAt, ordered);
      if (!before.files["asked-at-filled"] && task.askedAt === undefined && !task.routineRunId && asked !== undefined) task.askedAt = asked;
      if (!task.resumeCursors) task.resumeCursors = task.threadId === original.threadId ? original.resumeCursors ?? {} : {};
      if (task.unread === undefined) task.unread = task.threadId === original.threadId && original.unread;
      for (const key of ["busy", "activity", "turnStartedAt"]) { delete task[key]; check(!(key in next), "transient-thread-state-persisted"); }
    }
    const active = expected.tasks.find((task) => task.threadId === expected.threadId);
    check(Boolean(active), "active-thread-missing");
    expected.resumeCursors = active.resumeCursors;
    for (const key of ["rewound", "pinnedMessageId"]) {
      if (active[key] === undefined) delete expected[key]; else expected[key] = active[key];
    }
    check(stable(expected) === stable(actual), "unapproved-bot-change");
  }
  for (const marker of ["thread-model-copies-cleared", "asked-at-filled"]) check(existsSync(join(data, marker)), "migration-marker-missing");
}
try {
  check(readlinkSync("/proc/self/ns/net") !== process.env.MIGRATION_PARENT_NET, "network-not-isolated");
  check(!existsSync("/host-canary") && !existsSync("/run/user"), "host-visible");
  check(config.instances?.codex?.config?.cli === "/harness/guard-codex" && config.instances?.claude?.config?.cli === "/harness/guard-claude", "unguarded-engine");
  check(JSON.parse(readFileSync(join(data, "bots.json"), "utf8")).every((bot) => bot.memoryUpkeep === false), "memory-upkeep-enabled");
  const before = snapshot();
  phase = "first-start";
  await boot(1);
  phase = "first-compare";
  const first = snapshot();
  compare(before, first);
  result.scenarios.push({ id: "first-start", status: "PASS" });
  phase = "second-start";
  await boot(2);
  phase = "second-compare";
  compare(first, snapshot(), true);
  result.scenarios.push({ id: "second-start", status: "PASS" });
  result.status = "PASS";
  result.reason = "passive-data-migration-only";
} catch (error) {
  result.diagnostic = migrationDiagnostic(error, phase);
  result.status = candidateStarted ? "FAIL" : "BLOCKED";
  result.reason = error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : `migration-check-${result.diagnostic.code}`;
} finally {
  try { await stop(); } catch { result.status = "FAIL"; result.reason = "candidate-stop-failed"; }
  writeFileSync("/work/result.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  appendFileSync("/work/worker-complete", "done\n", { mode: 0o600 });
}
