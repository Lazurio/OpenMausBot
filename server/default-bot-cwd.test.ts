// Lazurio overlay: OMB_DEFAULT_BOT_CWD, a server-wide working folder for new
// bots. Unset, a new bot works in its private task workspace exactly as
// upstream; set, every creation path through the Store starts it in that
// folder unless the request names its own folder, or explicitly none.
// server/default-bot-cwd.e2e.test.ts covers the same paths through the HTTP
// server: New bot, a Chief's create_bot and team imports.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { announceDefaultBotCwd, defaultBotCwdFromEnv, newBotCwd } from "./default-bot-cwd.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";
import { createTeamBackup, importTeamBackup } from "./team-backup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const folder = mkdtempSync(join(tmpdir(), "omb-default-cwd-"));
const other = mkdtempSync(join(tmpdir(), "omb-default-cwd-other-"));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe("defaultBotCwdFromEnv", () => {
  it("is off when the variable is unset or blank", () => {
    expect(defaultBotCwdFromEnv({})).toBeNull();
    expect(defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: "" })).toBeNull();
    expect(defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: "   " })).toBeNull();
  });

  it("accepts exactly what a bot's working folder accepts", () => {
    expect(defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: folder })).toBe(folder);
    expect(defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: ` ${folder} ` })).toBe(folder);
    expect(defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: "~" })).toBe(resolve(homedir()));
  });

  it("refuses an unusable folder by name", () => {
    const file = join(folder, "a-file.txt");
    writeFileSync(file, "x");
    expect(() => defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: "relative/path" })).toThrow(/^OMB_DEFAULT_BOT_CWD: .*absolute/);
    expect(() => defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: file })).toThrow(/^OMB_DEFAULT_BOT_CWD: .*not a folder/);
    expect(() => defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: join(folder, "nope") })).toThrow(/^OMB_DEFAULT_BOT_CWD: .*doesn't exist/);
    rmSync(file);
  });

  it("names a new bot's folder: the default when none is asked, none for an explicit empty one", () => {
    const env = { OMB_DEFAULT_BOT_CWD: folder };
    expect(newBotCwd(undefined, env)).toEqual({ cwd: folder });
    expect(newBotCwd("", env)).toEqual({});
    expect(newBotCwd(other, env)).toEqual({ cwd: other });
    expect(newBotCwd(undefined, {})).toEqual({});
  });

  it("is announced once at start, and an unusable value stops the start", () => {
    const log = vi.fn();
    announceDefaultBotCwd({ OMB_DEFAULT_BOT_CWD: folder }, log);
    expect(log).toHaveBeenCalledExactlyOnceWith(`[bots] new bots start in ${folder} (OMB_DEFAULT_BOT_CWD)`);
    announceDefaultBotCwd({}, log);
    expect(log).toHaveBeenCalledOnce();
    expect(() => announceDefaultBotCwd({ OMB_DEFAULT_BOT_CWD: "relative/path" }, log)).toThrow(/OMB_DEFAULT_BOT_CWD/);
  });
});

describe("new bots in the Store with a server default working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("changes nothing when no default is configured", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    const bot = store.createBot({ name: "Plain" });
    expect("cwd" in bot).toBe(false);
    expect("cwd" in store.bots[1]).toBe(false);
  });

  it("stops the server's Store at start on an unusable default", () => {
    vi.stubEnv("OMB_DEFAULT_BOT_CWD", join(folder, "missing"));
    expect(() => new Store(selection)).toThrow(/^OMB_DEFAULT_BOT_CWD: that folder doesn't exist/);
  });

  it("starts the first-run bot and created bots in the default unless the creation names a folder", () => {
    vi.stubEnv("OMB_DEFAULT_BOT_CWD", folder);
    const store = new Store(selection);
    store.seedIfEmpty();
    const seeded = store.bots[0];
    const defaulted = store.createBot({ name: "Defaulted" });
    const explicit = store.createBot({ name: "Explicit", cwd: other });
    const privateBot = store.createBot({ name: "Private", cwd: "" });
    expect(seeded.cwd).toBe(folder);
    expect(defaulted.cwd).toBe(folder);
    expect(explicit.cwd).toBe(other);
    expect("cwd" in privateBot).toBe(false);

    vi.unstubAllEnvs();
    const reloaded = new Store(selection);
    expect(reloaded.bot(seeded.id)?.cwd).toBe(folder);
    expect(reloaded.bot(defaulted.id)?.cwd).toBe(folder);
    expect(reloaded.bot(explicit.id)?.cwd).toBe(other);
    expect(reloaded.bot(privateBot.id)?.cwd).toBeUndefined();
  });

  it("applies to a Chief's create_bot and reviewed team setup, keeping an explicit private workspace", () => {
    vi.stubEnv("OMB_DEFAULT_BOT_CWD", folder);
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Ops", cwd: "" });
    store.patchBot(chief.id, { chiefOfStaff: true });
    // create_bot and propose-team-setup both land here; an explicit empty folder arrives as "".
    store.applyTeamSetup({ version: 1, requestId: "setup-default-cwd", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "create", botId: "defaulted-bot", threadId: "defaulted-thread", fields: { name: "Defaulted", section: "Ops", modelSelection: selection() } },
        { action: "create", botId: "chosen-bot", threadId: "chosen-thread", fields: { name: "Chosen", section: "Ops", modelSelection: selection(), cwd: other } },
        { action: "create", botId: "private-bot", threadId: "private-thread", fields: { name: "Private", section: "Ops", modelSelection: selection(), cwd: "" } },
      ] });
    expect(store.bot("defaulted-bot")?.cwd).toBe(folder);
    expect(store.bot("chosen-bot")?.cwd).toBe(other);
    expect("cwd" in (store.bot("private-bot") ?? {})).toBe(false);
    // An update never moves an existing bot into the default.
    store.applyTeamSetup({ version: 1, requestId: "setup-update", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 2, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "update", botId: "private-bot", fields: { title: "Still private" } },
      ] });
    expect(store.bot("private-bot")?.title).toBe("Still private");
    expect("cwd" in (store.bot("private-bot") ?? {})).toBe(false);
  });

  it("starts the bots of an imported team backup in the default", () => {
    const store = new Store(selection);
    const routines = new RoutineManager({
      botState: (id) => store.bot(id) ? "ready" : "missing",
      goalState: () => "missing",
      createTask: (id, title) => store.createTask(id, title),
      startTurn: async () => { throw new Error("Import must never run a bot"); },
    });
    store.createBot({ name: "Mira", section: "Engineering" }, { seedMessages: false });
    store.createBot({ name: "Scout", section: "Engineering" }, { seedMessages: false });
    const backup = createTeamBackup(store, routines.listRoutines(), "Engineering");

    vi.stubEnv("OMB_DEFAULT_BOT_CWD", folder);
    const restored = importTeamBackup(store, routines, backup, selection());
    expect(restored.bots).toHaveLength(2);
    for (const bot of restored.bots) expect(store.bot(bot.id)?.cwd).toBe(folder);
  });
});
