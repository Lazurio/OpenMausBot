import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { computerEngineMoveText, removedComputerInstanceIds, writeComputerEngineMoveLines } from "./computer-engine-removal.ts";
import { DATA_DIR, instanceConfigs, persistableInstanceConfigs, type AppConfig } from "./config.ts";
import { SECTION_CONTEXTS_FILE } from "./section-context.ts";
import { Store } from "./store.ts";

describe("the Computer engine is not offered", () => {
  it("is in no built-in driver list and no default fleet", () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("boxAgent");
    const fleet = instanceConfigs({});
    expect(fleet).not.toHaveProperty("computer");
    expect(Object.values(fleet).map(entry => entry.driver)).not.toContain("boxAgent");
  });

  it("drops a saved fleet's entries for it, so the next save leaves them off disk", () => {
    const cfg: AppConfig = {
      instances: {
        claude: { driver: "claudeAgent" },
        computer: { driver: "boxAgent", environment: { BOX_TOKEN: "box_instance" } },
        myBoat: { driver: "boxAgent", displayName: "My Boat" },
      },
    };
    for (const map of [instanceConfigs(cfg), persistableInstanceConfigs(cfg)]) {
      expect(Object.keys(map)).toContain("claude");
      expect(map).not.toHaveProperty("computer");
      expect(map).not.toHaveProperty("myBoat");
    }
    expect(cfg.instances).toHaveProperty("computer");
  });

  it("names every id the engine had, and leaves an id the person reused for another engine", () => {
    expect([...removedComputerInstanceIds(undefined)]).toEqual(["computer"]);
    expect([...removedComputerInstanceIds({ claude: { driver: "claudeAgent" }, myBoat: { driver: "boxAgent" } })].sort())
      .toEqual(["computer", "myBoat"]);
    expect([...removedComputerInstanceIds({ computer: { driver: "claudeAgent" } })]).toEqual([]);
  });
});

describe("moving saved bots off the engine", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  const newBotDefault = () => ({ instanceId: "claude", model: "claude-model" });
  const replacement = { instanceId: "claude", model: "claude-model" };
  const removed = new Set(["computer"]);
  const claude = { driverKind: "claudeAgent" };

  it("moves the bot's model, each conversation's model and its backups once", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    const other = store.createBot({ modelSelection: { instanceId: "codex", model: "codex-model" } }, { seedMessages: false });
    store.patchBot(bot.id, { fallback: [{ instanceId: "computer", model: "sonnet" }, { instanceId: "codex", model: "codex-model" }] });
    const second = store.createTask(bot.id, "Second", false)!;
    store.patchTask(bot.id, second.threadId, { modelSelection: { instanceId: "computer", model: "gpt-5.4" } });
    store.setResumeCursor(bot.id, "computer", "boat-prompt-run", bot.threadId);
    store.setResumeCursor(bot.id, "codex", "codex-session", bot.threadId);

    const moves = store.retireInstances(removed, replacement, claude);
    expect(moves).toHaveLength(2);
    expect(moves).toEqual(expect.arrayContaining([
      { botId: bot.id, threadId: bot.threadId, scope: "bot", askNow: false },
      { botId: bot.id, threadId: second.threadId, scope: "conversation", askNow: false },
    ]));

    const reloaded = new Store(newBotDefault);
    const moved = reloaded.bot(bot.id)!;
    expect(moved.modelSelection).toEqual(replacement);
    expect(moved.fallback).toEqual([{ instanceId: "codex", model: "codex-model" }]);
    expect(reloaded.taskByThread(bot.id, second.threadId)?.modelSelection).toEqual(replacement);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ codex: "codex-session" });
    expect(reloaded.bot(other.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-model" });
    expect(reloaded.retireInstances(removed, replacement, claude)).toEqual([]);
  });

  it("moves only the conversation that was on the engine", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "codex", model: "codex-model" } }, { seedMessages: false });
    const second = store.createTask(bot.id, "On the engine", false)!;
    store.patchTask(bot.id, second.threadId, { modelSelection: { instanceId: "computer", model: "gpt-5.4" } });

    expect(store.retireInstances(removed, replacement, claude)).toEqual([
      { botId: bot.id, threadId: second.threadId, scope: "conversation", askNow: false },
    ]);

    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(bot.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-model" });
    const task = reloaded.taskByThread(bot.id, second.threadId)!;
    expect(task.modelSelection).toEqual(replacement);
  });

  it("carries every level the new engine runs, Full included, as every engine switch does (#2697)", () => {
    const store = new Store(newBotDefault);
    const full = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(full.id, { approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    store.patchTask(full.id, full.threadId, { approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    const auto = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(auto.id, { approvalMode: "auto" });
    store.patchTask(auto.id, auto.threadId, { approvalMode: "auto" });

    const moves = store.retireInstances(removed, replacement, claude);

    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(full.id)).toMatchObject({ approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    expect(reloaded.taskByThread(full.id, full.threadId)).toMatchObject({ approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    expect(moves.find(move => move.botId === full.id)?.askNow).toBe(false);
    expect(reloaded.bot(auto.id)?.approvalMode).toBe("auto");
    expect(reloaded.taskByThread(auto.id, auto.threadId)?.approvalMode).toBe("auto");
    expect(moves.find(move => move.botId === auto.id)?.askNow).toBe(false);
  });

  it("keeps the bot's Full and the level of a conversation on another engine when the bot moves", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(bot.id, { approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    const elsewhere = bot.threadId;
    store.patchTask(bot.id, elsewhere, { modelSelection: { instanceId: "codex", model: "codex-model" } });
    expect(store.projectBotForTask(bot.id, elsewhere)).toMatchObject({ approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });

    const moves = store.retireInstances(removed, replacement, claude);

    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(bot.id)).toMatchObject({ modelSelection: replacement, approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    expect(reloaded.projectBotForTask(bot.id, elsewhere)).toMatchObject({
      modelSelection: { instanceId: "codex", model: "codex-model" }, approvalMode: "full", alwaysAllow: ["Bash(ls:*)"],
    });
    expect(moves).toEqual([
      { botId: bot.id, threadId: elsewhere, scope: "bot-only", askNow: false },
    ]);
  });

  it("leaves a moved conversation that follows the bot's level at Full, with nothing to ask", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(bot.id, { approvalMode: "full" });
    const first = bot.threadId;
    store.createTask(bot.id, "Newer", true);

    const moves = store.retireInstances(removed, replacement, claude);

    expect(moves.find(move => move.threadId === first)).toMatchObject({ scope: "conversation", askNow: false });
    expect(new Store(newBotDefault).projectBotForTask(bot.id, first)).toMatchObject({ approvalMode: "full" });
  });

  it("changes nothing when the save fails, so the next try moves the bot", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    // An unreadable teams file stops every bots save.
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SECTION_CONTEXTS_FILE, "not json");

    expect(() => store.retireInstances(removed, replacement, claude)).toThrow();
    expect(store.bot(bot.id)).toMatchObject({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } });

    rmSync(SECTION_CONTEXTS_FILE, { force: true });
    expect(store.retireInstances(removed, replacement, claude)).toEqual([
      { botId: bot.id, threadId: bot.threadId, scope: "bot", askNow: false },
    ]);
    expect(new Store(newBotDefault).bot(bot.id)).toMatchObject({ modelSelection: replacement });
  });
});

describe("the line a moved conversation shows", () => {
  it("names the bot, the new engine, the removed choice as people saw it, and only what is true", () => {
    expect(computerEngineMoveText({ scope: "bot", askNow: false }, "Scout", "Claude")).toBe(
      "Scout now uses Claude. The Computer choice in the model list was removed.");
    expect(computerEngineMoveText({ scope: "bot", askNow: true }, "Scout", "Claude")).toBe(
      "Scout now uses Claude. The Computer choice in the model list was removed. Its permissions are now Ask.");
    expect(computerEngineMoveText({ scope: "conversation", askNow: false }, "Scout", "Claude")).toBe(
      "This conversation now uses Claude. The Computer choice in the model list was removed.");
  });

  it("tells the bot's open conversation on its own engine about the bot, not about itself", () => {
    expect(computerEngineMoveText({ scope: "bot-only", askNow: true }, "Scout", "Claude")).toBe(
      "Scout now uses Claude; this conversation keeps its own model. The Computer choice in the model list was removed. " +
      "Scout's permissions are now Ask, but this conversation's stay as they were.");
  });
});

describe("writing the moved conversations' lines", () => {
  it("writes every other line when one fails", () => {
    const move = (threadId: string) => ({ botId: "bot", threadId, scope: "bot" as const, askNow: false });
    const written: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeComputerEngineMoveLines([move("first"), move("second")], ({ threadId }) => {
        if (threadId === "first") throw new Error("disk full");
        written.push(threadId);
      });
      expect(written).toEqual(["second"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    } finally {
      warn.mockRestore();
    }
  });
});
