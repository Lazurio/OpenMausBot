// Real server and fake Claude CLI: bots saved on the removed Computer engine move to another engine once.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import { SNAPSHOT_REUSE_MS } from "./harness/registry.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const ENGINE_NAME = "Verification Claude";
const REMOVED = "The Computer choice in the model list was removed.";

function install(home: string) {
  const data = join(home, "data");
  const dumpFile = join(home, "dump.json");
  let child: ChildProcess | null = null;
  let base = "";
  let output = "";
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, "static", "assets"), { recursive: true });
  writeFileSync(join(home, "static", "index.html"), "<title>Computer engine removal</title>");
  writeFileSync(join(home, "static", "assets", "test.css"), "body{}");

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBeLessThan(400);
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  const send = (botId: string, threadId: string, text: string) => fetch(`${base}/api/bots/${botId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, threadId }),
  }).then(response => response.status);
  const bots = async (): Promise<any[]> => (await api("GET", "/api/bots?messages=0")).bots;
  const bot = async (botId: string) => (await bots()).find(entry => entry.id === botId);
  const savedBots = (): any[] => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"));
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const saved = savedBots();
    edit(saved.find(entry => entry.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(saved, null, 2));
  };
  const editConfig = (edit: (config: any) => void) => {
    const path = join(data, "config.json");
    const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    edit(config);
    writeFileSync(path, JSON.stringify(config, null, 2));
  };
  const lines = async (threadId: string): Promise<string[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages
      .filter((message: any) => message.kind === "activity").map((message: any) => String(message.tool?.name));
  const moveLines = async (threadId: string) => (await lines(threadId)).filter(line => line.includes(REMOVED));
  const dump = async () => {
    let parsed: any = null;
    await expect.poll(() => {
      if (!existsSync(dumpFile)) return false;
      try { parsed = JSON.parse(readFileSync(dumpFile, "utf8")); return true; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    return parsed;
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    rmSync(dumpFile, { force: true });
    await control(["send", "--bot", botId, "--task", threadId, "--text", text]);
    const settled = await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"]);
    expect(settled.status, JSON.stringify(settled)).toBe("settled");
    return dump();
  };
  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "static"),
        OMB_USER_DATA: join(home, "user-data"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await expect.poll(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000, interval: 50 }).toBe(true);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  return { data, dumpFile, api, send, bots, bot, savedBots, editSavedBot, editConfig, lines, moveLines, turn, start, stop, log: () => output };
}

const claudeEntry = (dumpFile: string) => ({
  driver: "claudeAgent", displayName: ENGINE_NAME, config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_DUMP: dumpFile },
});
const onEngine = (model: string) => ({ instanceId: "computer", model });
/** A bot (and each of its conversations) as v0.1.94 saved it on the engine. */
const savedOnEngine = (saved: any) => {
  saved.modelSelection = onEngine("claude-fable-5");
  for (const task of saved.tasks) task.modelSelection = onEngine("claude-fable-5");
};

describe("removing the Computer engine", () => {
  const homes: string[] = [];
  const running: Array<{ stop: () => Promise<void> }> = [];
  const fresh = () => {
    const home = mkdtempSync(join(tmpdir(), "omb-computer-engine-"));
    homes.push(home);
    const server = install(home);
    running.push(server);
    return { home, server };
  };

  afterAll(async () => {
    for (const server of running) await server.stop();
    for (const home of homes) await removeTempDir(home);
  });

  it("moves bots off it once, drops the removed Works on and place pins, and runs their turns on the new engine", async () => {
    const { server } = fresh();
    server.editConfig(config => Object.assign(config, { instances: { claude: claudeEntry(server.dumpFile) } }));
    await server.start();
    const [starter] = await server.bots();
    const { task: opened } = await server.api("POST", `/api/bots/${starter.id}/tasks`, {});
    const main = opened.threadId;
    const other = starter.threadId;
    const { bot: auto } = await server.api("POST", "/api/bots", { name: "Atlas" });
    const { bot: mixed } = await server.api("POST", "/api/bots", { name: "Iris" });
    const { task: mixedConversation } = await server.api("POST", `/api/bots/${mixed.id}/tasks`, {});
    await server.stop();

    // Everything as v0.1.94 saved it. The fleet, the new-bot defaults and the
    // automatic-recovery backup name the engine; the Boat key is still there.
    server.editConfig(config => Object.assign(config, {
      box: { token: "box_verification_fixture" },
      instances: { claude: claudeEntry(server.dumpFile), computer: { driver: "boxAgent" } },
      defaultModelSelection: { instanceId: "computer", model: "claude-fable-5" },
      newBotDefaults: { profile: { modelSelection: { instanceId: "computer", model: "claude-fable-5" } } },
      automaticRecovery: { enabled: true, backup: { instanceId: "computer", model: "sonnet" } },
    }));
    // The starter: on the engine with Works on Cloud, another conversation
    // and a backup on it, and Boat's run id.
    server.editSavedBot(starter.id, saved => {
      saved.modelSelection = onEngine("claude-fable-5");
      saved.computer = "cloud";
      saved.fallback = [onEngine("sonnet")];
      saved.resumeCursors = { computer: "boat-prompt-run" };
      for (const task of saved.tasks) task.modelSelection = onEngine(task.threadId === other ? "gpt-5.4" : "claude-fable-5");
    });
    // Atlas: on the engine with Works on Auto, the default for new bots.
    server.editSavedBot(auto.id, saved => {
      saved.modelSelection = onEngine("claude-fable-5");
      delete saved.computer;
      for (const task of saved.tasks) task.modelSelection = onEngine("claude-fable-5");
    });
    // Iris: on Claude and Auto, with its open conversation switched to the engine and pinned to the cloud computer.
    server.editSavedBot(mixed.id, saved => {
      Object.assign(saved.tasks.find((task: any) => task.threadId === mixedConversation.threadId),
        { modelSelection: onEngine("claude-fable-5"), surface: "cloud", surfaceSource: "auto" });
    });

    await server.start();
    const { instances } = await server.api("GET", "/api/instances");
    expect(instances.map((instance: any) => instance.instanceId)).not.toContain("computer");
    expect(instances.map((instance: any) => instance.driverKind)).not.toContain("boxAgent");
    const replacement = { instanceId: "claude", model: instances.find((instance: any) => instance.instanceId === "claude").models.default };

    const movedStarter = await server.bot(starter.id);
    expect(movedStarter.modelSelection).toEqual(replacement);
    expect(movedStarter).not.toHaveProperty("computer");
    expect(movedStarter.fallback ?? []).toEqual([]);
    expect(movedStarter.threadId).toBe(main);
    expect(movedStarter.tasks.find((task: any) => task.threadId === other).modelSelection).toEqual(replacement);
    const starterLine = `${starter.name} now uses ${ENGINE_NAME}. ${REMOVED}`;
    const otherLine = `This conversation now uses ${ENGINE_NAME}. ${REMOVED}`;
    expect(await server.moveLines(main)).toEqual([starterLine]);
    expect(await server.moveLines(other)).toEqual([otherLine]);

    const movedAuto = await server.bot(auto.id);
    expect(movedAuto.modelSelection).toEqual(replacement);
    expect(movedAuto).not.toHaveProperty("computer");
    expect(await server.moveLines(auto.threadId)).toEqual([`Atlas now uses ${ENGINE_NAME}. ${REMOVED}`]);

    const movedMixed = await server.bot(mixed.id);
    expect(movedMixed.modelSelection).toEqual(mixed.modelSelection);
    expect(movedMixed).not.toHaveProperty("computer");
    expect(await server.moveLines(mixed.threadId)).toEqual([]);
    expect(await server.moveLines(mixedConversation.threadId))
      .toEqual([`This conversation now uses ${ENGINE_NAME}. ${REMOVED}`]);
    const mixedTask = movedMixed.tasks.find((task: any) => task.threadId === mixedConversation.threadId);
    expect(mixedTask.modelSelection).toEqual(replacement);
    expect(mixedTask).not.toHaveProperty("surface");
    expect(mixedTask).not.toHaveProperty("surfaceAuto");
    for (const saved of server.savedBots()) {
      for (const key of ["computer", "cloudBackend", "autoStartVps"]) expect(saved).not.toHaveProperty(key);
      for (const task of saved.tasks) expect(task).not.toHaveProperty("surface");
    }

    const defaults = await server.api("GET", "/api/bot-defaults");
    expect(defaults.defaults.profile.modelSelection).toEqual(replacement);
    expect(defaults.modelSelection).toEqual(replacement);
    const { bot: created } = await server.api("POST", "/api/bots", { name: "Nova" });
    expect(created.modelSelection).toEqual(replacement);
    expect(created).not.toHaveProperty("computer");
    const config = await server.api("GET", "/api/config");
    expect(config.automaticRecovery).toEqual({ enabled: false });
    expect(config).not.toHaveProperty("box");

    await server.stop();
    await server.start();
    expect(await server.moveLines(main)).toEqual([starterLine]);
    expect(await server.moveLines(other)).toEqual([otherLine]);
    expect(await server.moveLines(auto.threadId)).toHaveLength(1);
    expect(await server.moveLines(mixedConversation.threadId)).toHaveLength(1);

    const movedTurn = await server.turn(starter.id, main, "Take a screenshot.");
    expect(movedTurn.argv[movedTurn.argv.indexOf("--model") + 1]).toBe(replacement.model);
    expect(movedTurn.mcpConfig?.mcpServers ?? {}).not.toHaveProperty("computer");
    const { task: atlasNew } = await server.api("POST", `/api/bots/${auto.id}/tasks`, {});
    const autoTurn = await server.turn(auto.id, atlasNew.threadId, "what is 2+2?");
    expect(autoTurn.argv[autoTurn.argv.indexOf("--model") + 1]).toBe(replacement.model);
    await server.stop();
  }, 180_000);

  it("moves a bot later, as soon as an engine is there to move it to", async () => {
    const { home, server } = fresh();
    // Its only engine is not installed yet, so nothing can take the bot at
    // start. (A fleet without a "claude" id is kept exactly as written.)
    const cli = join(home, "later", "claude.mjs");
    const later = { driver: "claudeAgent", displayName: ENGINE_NAME, config: { cli }, environment: { FAKE_CLAUDE_DUMP: server.dumpFile } };
    server.editConfig(config => Object.assign(config, { instances: { later } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { later, computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, saved => {
      saved.modelSelection = { instanceId: "computer", model: "claude-fable-5" };
      for (const task of saved.tasks) task.modelSelection = { instanceId: "computer", model: "claude-fable-5" };
    });

    await server.start();
    await server.api("GET", "/api/instances");
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("computer");

    // Claude arrives (an install, a sign-in or a key); the next look at the
    // engines moves the bot without a restart. Installed outside the app, it is
    // seen once the last status read is older than the reuse window.
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(FAKE_CLI).href)});\n`, { mode: 0o755 });
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_REUSE_MS));
    const { instances } = await server.api("GET", "/api/instances");
    const model = instances.find((instance: any) => instance.instanceId === "later").models.default;
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection, { timeout: 15_000 })
      .toEqual({ instanceId: "later", model });
    expect(await server.moveLines(starter.threadId)).toEqual([`${starter.name} now uses ${ENGINE_NAME}. ${REMOVED}`]);
    await server.stop();
  }, 120_000);

  it("keeps serving when the move fails at start, and moves the bots on a later try", async () => {
    const { server } = fresh();
    const teams = join(server.data, "section-contexts.json");
    server.editConfig(config => Object.assign(config, { instances: { claude: claudeEntry(server.dumpFile) } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { claude: claudeEntry(server.dumpFile), computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, savedOnEngine);
    // An unreadable teams file stops every save of the bots, the move's too.
    writeFileSync(teams, "not json");

    await server.start();
    expect(server.log()).toContain("[engines] moving bots off the removed Computer engine failed");
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("computer");
    expect(await server.moveLines(starter.threadId)).toEqual([]);

    rmSync(teams);
    await server.send(starter.id, starter.threadId, "hello");
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection.instanceId, { timeout: 15_000 }).toBe("claude");
    expect(await server.moveLines(starter.threadId)).toEqual([`${starter.name} now uses ${ENGINE_NAME}. ${REMOVED}`]);
    await server.stop();
  }, 120_000);

  it("moves a bot to an engine without computer tools with the same line", async () => {
    const { server } = fresh();
    // An OpenAI-compatible endpoint with tools off: it answers, but has no computer.
    const chat = {
      driver: "openai-compat", displayName: "Chat Only",
      config: { url: "http://127.0.0.1:9/v1", key: "sk-verification-fixture", tools: false, model: "chat-model" },
    };
    server.editConfig(config => Object.assign(config, { instances: { chat } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { chat, computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, saved => { savedOnEngine(saved); delete saved.computer; });

    await server.start();
    const moved = await server.bot(starter.id);
    expect(moved.modelSelection).toEqual({ instanceId: "chat", model: "chat-model" });
    expect(moved).not.toHaveProperty("computer");
    expect(await server.moveLines(starter.threadId)).toEqual([`${starter.name} now uses Chat Only. ${REMOVED}`]);
    await server.stop();
  }, 120_000);
});
