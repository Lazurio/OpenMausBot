import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function separatePaths(paths: string[]): void {
  for (const path of paths) {
    if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error("paths-must-be-real-absolute-directories");
  }
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const contains = (parent: string, child: string) => { const r = relative(parent, child); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
    if (contains(paths[i], paths[j]) || contains(paths[j], paths[i])) throw new Error("overlapping-migration-paths");
  }
}

/** Inspect the whole input before copying: no live SQLite WAL, links, credentials or special files. */
export function inspectMigrationSnapshot(root: string): void {
  let bytes = 0;
  let count = 0;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1) throw new Error("snapshot-special-file");
      if (++count > 100_000 || (bytes += stat.size) > 512 * 1024 * 1024) throw new Error("snapshot-too-large");
      if (/^(?:\.composio|\.executor|\.ssh|\.claude|\.codex|\.env(?:\..*)?|\.netrc|\.npmrc|auth\.json|providers|sessions\.json(?:\.open)?|hook-tokens|browser-engine-key|environment-id|openmausbot-server\.lease)$/.test(entry)
        || /(?:-wal|-shm)$/.test(entry)) throw new Error("snapshot-not-sanitized-or-not-consistent");
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  if (Object.keys(config).some((key) => !["profile", "onboarding", "composio"].includes(key))) throw new Error("unsupported-snapshot-config");
  // Real connected-account credentials must be excluded by the snapshot preparer, before the harness reads them.
  if (config.composio && JSON.stringify(config.composio) !== JSON.stringify({ apiKey: "fixture-only", userId: "fixture-only", sessionId: "fixture-only" })) throw new Error("snapshot-contains-credentials");
  const bots = JSON.parse(readFileSync(join(root, "bots.json"), "utf8"));
  if (!Array.isArray(bots) || !bots.length) throw new Error("snapshot-bots-required");
  for (const bot of bots) {
    if (!bot || typeof bot !== "object" || !["codex", "claude"].includes(bot.modelSelection?.instanceId)
      || Object.keys(bot).some((key) => /key|token|secret|password/i.test(key))
      || bot.busy || bot.activity && bot.activity !== "idle"
      || (bot.tasks ?? []).some((task: Record<string, unknown>) => task.busy || task.activity && task.activity !== "idle" || task.goal || task.queue)) throw new Error("unsupported-or-active-bot");
  }
  for (const file of ["routines.json", "webhooks.json", "github-intake.json", "runtime.db", "groups.json", "external-runtimes.json",
    "calendar-calls.json", "memory-capture-pending.json", "room-handoffs.json"]) {
    if (readdirSync(root).includes(file)) throw new Error("automatic-work-state-present");
  }
}

export function prepareMigrationCopy(snapshot: string, work: string): string[] {
  inspectMigrationSnapshot(snapshot);
  const data = join(work, "data");
  cpSync(snapshot, data, { recursive: true, errorOnExist: true, force: false });
  inspectMigrationSnapshot(data);
  const privateWritableCopy = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) privateWritableCopy(join(path, entry));
    } else if (stat.isFile() && stat.nlink === 1) chmodSync(path, 0o600);
    else throw new Error("unsafe-working-copy");
  };
  privateWritableCopy(data);
  mkdirSync(join(work, "home"), { mode: 0o700 });
  mkdirSync(join(work, "cwd"), { mode: 0o700 });
  const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  config.instances = {
    codex: { driver: "codex", config: { cli: "/harness/guard-codex" } },
    claude: { driver: "claudeAgent", config: { cli: "/harness/guard-claude" } },
  };
  writeFileSync(join(data, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8"));
  for (const bot of bots) {
    bot.memoryUpkeep = false;
    bot.cwd = "/work/cwd";
    for (const task of bot.tasks ?? []) if (task.cwd !== undefined) task.cwd = "/work/cwd";
    if (bot.projects?.length) throw new Error("project-paths-need-explicit-fixture-support");
  }
  writeFileSync(join(data, "bots.json"), JSON.stringify(bots), { mode: 0o600 });
  return ["working-copy directories=0700 and files=0600", "instances use discovery-only guards", "all bots memoryUpkeep=false", "bot and task cwd=/work/cwd"];
}
