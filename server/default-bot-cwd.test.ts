// OMB_DEFAULT_BOT_CWD: a server-wide working folder for new bots. Unset, a new
// bot works in its private task workspace exactly as before; set, every path
// that creates a bot (New bot, the first-run seed, a Chief's reviewed team
// setup, imports) starts it in that folder unless the request names its own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { defaultBotCwdFromEnv } from "./bot-cwd.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

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

  it("refuses an unusable folder by name, so the server does not start on it", () => {
    const file = join(folder, "a-file.txt");
    writeFileSync(file, "x");
    expect(() => defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: "relative/path" })).toThrow(/^OMB_DEFAULT_BOT_CWD: .*absolute/);
    expect(() => defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: file })).toThrow(/^OMB_DEFAULT_BOT_CWD: .*not a folder/);
    expect(() => defaultBotCwdFromEnv({ OMB_DEFAULT_BOT_CWD: join(folder, "nope") })).toThrow(/^OMB_DEFAULT_BOT_CWD: .*doesn't exist/);
  });
});

describe("new bots with a server default working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("changes nothing when no default is configured", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    const bot = store.createBot({ name: "Plain" });
    expect("cwd" in bot).toBe(false);
    expect("cwd" in store.bots[1]).toBe(false);
  });

  it("starts every created bot in the default unless the request names a folder", () => {
    const store = new Store(selection, undefined, folder);
    store.seedIfEmpty();
    const seeded = store.bots[0];
    const defaulted = store.createBot({ name: "Defaulted" });
    const explicit = store.createBot({ name: "Explicit", cwd: other });
    expect(seeded.cwd).toBe(folder);
    expect(defaulted.cwd).toBe(folder);
    expect(explicit.cwd).toBe(other);

    const reloaded = new Store(selection);
    expect(reloaded.bot(seeded.id)?.cwd).toBe(folder);
    expect(reloaded.bot(defaulted.id)?.cwd).toBe(folder);
    expect(reloaded.bot(explicit.id)?.cwd).toBe(other);
  });

  it("applies to a Chief's reviewed teammates, keeping an explicit private workspace", () => {
    const store = new Store(selection, undefined, folder);
    const chief = store.createBot({ name: "Chief", section: "Ops" });
    store.patchBot(chief.id, { chiefOfStaff: true });
    store.applyTeamSetup({ version: 1, requestId: "setup-default-cwd", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "create", botId: "defaulted-bot", threadId: "defaulted-thread", fields: { name: "Defaulted", section: "Ops", modelSelection: selection() } },
        { action: "create", botId: "chosen-bot", threadId: "chosen-thread", fields: { name: "Chosen", section: "Ops", modelSelection: selection(), cwd: other } },
        { action: "create", botId: "private-bot", threadId: "private-thread", fields: { name: "Private", section: "Ops", modelSelection: selection(), cwd: "" } },
      ] });
    expect(store.bot("defaulted-bot")?.cwd).toBe(folder);
    expect(store.bot("chosen-bot")?.cwd).toBe(other);
    expect("cwd" in (store.bot("private-bot") ?? {})).toBe(false);
  });
});
