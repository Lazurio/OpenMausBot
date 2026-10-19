// Lazurio overlay (DEV-6673, task 2026-10-05-510): the bots' strips in the Environment browser,
// against the real file layout the Platform's hub reads (holder files, agent-browser's bindings)
// in a scratch runtime directory, with the Platform's `lazurio` CLI faked.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BROWSER_CONTRACT_RELEASE,
  botBrowserSession,
  environmentBrowserPrompt,
  startEnvironmentBrowser,
  type EnvironmentBrowser,
  type LazurioRun,
  type StripBot,
  type StripChange,
} from "./lazurio-environment-browser.ts";

const provenance = JSON.parse(await readFile(join(import.meta.dirname, "..", "lazurio", "browser-contract", "provenance.json"), "utf8")) as { version: string };

const TAB_A = "A".repeat(32);
const TAB_B = "B".repeat(32);
const TAB_C = "C".repeat(32);
const BOT_A = "6f1c2a40-5b0e-4f7e-9d1a-0c2b3d4e5f60";
const BOT_B = "7a2d3b51-6c1f-4a8f-8e2b-1d3c4e5f6a71";

describe("a bot's session", () => {
  it("is bot-<id>, a strip of MausBot's reserved prefix (C2)", () => {
    expect(botBrowserSession(BOT_A)).toBe(`bot-${BOT_A}`);
    expect(isStrip(botBrowserSession(BOT_A))).toBe(true);
    expect(stripAppOf(botBrowserSession(BOT_A))).toBe("mausbot");
  });

  it("stays in the grammar for any id, and two ids never share one", () => {
    const odd = ["bot.with.dots", "ü/ñ:id", "x".repeat(200), "x".repeat(199) + "y", ""];
    const names = odd.map(botBrowserSession);
    for (const name of names) {
      expect(isStrip(name), name).toBe(true);
      expect(stripAppOf(name), name).toBe("mausbot");
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("a bot's instructions", () => {
  it("name its own session for the window, the work and letting go, and forbid a browser of its own", () => {
    const text = environmentBrowserPrompt("bot-x", true);
    expect(text).toContain("lazurio browser window --session bot-x");
    expect(text).toContain("agent-browser --cdp 9222 --session bot-x");
    expect(text).toContain("lazurio browser done --session bot-x");
    expect(text).toMatch(/never start a browser of your own/);
  });

  it("say clearly that there is no browser where the Environment declares none", () => {
    const text = environmentBrowserPrompt("bot-x", false);
    expect(text).toMatch(/no Environment browser/);
    expect(text).not.toContain("agent-browser --cdp");
  });
});

describe("the bots' strips", () => {
  let runtime: string;
  let bots: StripBot[];
  let listeners: Array<(change: StripChange) => void>;
  let runs: string[][];
  let browser: EnvironmentBrowser | null;
  const sockets = () => join(runtime, "agent-browser");
  const holders = () => join(runtime, "lazurio-browser", "holders");

  const bind = async (session: string, targetId: string, running = true) => {
    await mkdir(sockets(), { recursive: true });
    await writeFile(join(sockets(), `${session}.target`), JSON.stringify({ targetId, url: "about:blank", pinned: true }));
    if (running) await writeFile(join(sockets(), `${session}.pid`), String(process.pid));
  };
  const holderOf = async (session: string) => JSON.parse(await readFile(join(holders(), `${session}.json`), "utf8")) as {
    schema: string; strip: string; label: string; tabs: string[]; contract: string;
  };
    ? { code: 0, stdout: JSON.stringify({ schema: "lazurio.browser-cli.v1", kind: "browser-done", session: args[3], outcome: "stopped" }) }
    : { code: 0, stdout: JSON.stringify({ schema: "lazurio.browser-cli.v1", kind: "browser-link", session: null, link: "https://browser.vm-01.example.lazurio.io/" }) })) => {
    browser = startEnvironmentBrowser({
      env: { XDG_RUNTIME_DIR: runtime, HOME: runtime },
      bots: () => bots,
      onChange: (listener) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter((other) => other !== listener); };
      },
      runLazurio: async (args) => {
        runs.push([...args]);
        return answer(args);
      },
      now: async () => ({ boot: "8e1c8f0e-6c3b-4b39-9d3e-1f2a3b4c5d6e", at: 100 }),
      everyMs: 60_000,
      log: () => {},
    });
    return browser;
  };

  beforeEach(async () => {
    runtime = await mkdtemp(join(tmpdir(), "omb-env-browser-"));
    bots = [{ id: BOT_A, name: "Researcher" }, { id: BOT_B, name: "Writer" }];
    listeners = [];
    runs = [];
    browser = null;
  });

  afterEach(async () => {
    await browser?.stop();
    await rm(runtime, { recursive: true, force: true });
  });

  it("gives two bots separate tabs: each strip holds only what its own session bound", async () => {
    await bind(botBrowserSession(BOT_A), TAB_A);
    await bind(botBrowserSession(BOT_B), TAB_B);
    const strips = start();
    await strips.sync();
    const a = await holderOf(`bot-${BOT_A}`);
    const b = await holderOf(`bot-${BOT_B}`);
    expect(a).toMatchObject({ schema: holderSchema, strip: `bot-${BOT_A}`, label: "Researcher", tabs: [TAB_A], contract: BROWSER_CONTRACT_RELEASE });
    expect(b).toMatchObject({ strip: `bot-${BOT_B}`, label: "Writer", tabs: [TAB_B] });
    expect(await strips.tabs(BOT_A)).toEqual([TAB_A]);
    expect(await strips.tabs(BOT_B)).toEqual([TAB_B]);
  });

  it("keeps a tab the bot bound earlier when its session moves on to a new window", async () => {
    await bind(botBrowserSession(BOT_A), TAB_A);
    const strips = start();
    await strips.sync();
    await bind(botBrowserSession(BOT_A), TAB_C);
    await strips.sync();
    expect((await holderOf(`bot-${BOT_A}`)).tabs).toEqual([TAB_A, TAB_C]);
  });

  it("lets go of a deleted bot's tabs: its holder file goes and its session's daemon is stopped", async () => {
    await bind(botBrowserSession(BOT_A), TAB_A);
    await bind(botBrowserSession(BOT_B), TAB_B);
    const strips = start();
    await strips.sync();
    bots = bots.filter((bot) => bot.id !== BOT_A);
    for (const listener of listeners) listener({ type: "bot.deleted", botId: BOT_A });
    await strips.sync();
    expect(existsSync(join(holders(), `bot-${BOT_A}.json`))).toBe(false);
    expect((await holderOf(`bot-${BOT_B}`)).tabs).toEqual([TAB_B]);
    expect(runs).toContainEqual(["browser", "done", "--session", `bot-${BOT_A}`, "--json"]);
    expect(runs).not.toContainEqual(["browser", "done", "--session", `bot-${BOT_B}`, "--json"]);
  });

  it("lets go of an archived bot's tabs the same way, and records nothing for it while archived", async () => {
    await bind(botBrowserSession(BOT_A), TAB_A);
    const strips = start();
    await strips.sync();
    bots = bots.map((bot) => (bot.id === BOT_A ? { ...bot, hidden: true } : bot));
    for (const listener of listeners) listener({ type: "bot", botId: BOT_A });
    await strips.sync();
    expect(existsSync(join(holders(), `bot-${BOT_A}.json`))).toBe(false);
    expect(runs).toContainEqual(["browser", "done", "--session", `bot-${BOT_A}`, "--json"]);
    await bind(botBrowserSession(BOT_A), TAB_C, false);
    await strips.sync();
    expect(existsSync(join(holders(), `bot-${BOT_A}.json`))).toBe(false);
  });

  it("reacts to the Store's change without waiting for the beat", async () => {
    await bind(botBrowserSession(BOT_A), TAB_A);
    const strips = start();
    await strips.sync();
    bots = [];
    for (const listener of listeners) listener({ type: "bot.deleted", botId: BOT_A });
    await expect.poll(() => existsSync(join(holders(), `bot-${BOT_A}.json`)), { timeout: 3_000 }).toBe(false);
  });

  it("at start, removes the strips of bots that no longer exist and stops their daemons", async () => {
    await mkdir(holders(), { recursive: true });
    await writeFile(join(holders(), "bot-gone.json"), JSON.stringify({ strip: "bot-gone", label: "Gone", tabs: [TAB_C] }));
    await writeFile(join(holders(), "t3-thread.json"), JSON.stringify({ strip: "t3-thread", label: "Thread", tabs: [TAB_C] }));
    await bind("bot-gone", TAB_C);
    const strips = start();
    await strips.sync();
    expect(await readdir(holders())).toEqual(["t3-thread.json"]);
    expect(runs).toContainEqual(["browser", "done", "--session", "bot-gone", "--json"]);
  });

  it("starts nothing but the Platform's CLI: no browser, no agent-browser daemon, no configuration", async () => {
    await bind(botBrowserSession(BOT_A), TAB_A);
    const strips = start();
    await strips.declared();
    await strips.sync();
    bots = [];
    await strips.sync();
    for (const args of runs) expect(args.slice(0, 2).join(" ")).toMatch(/^browser (link|done)$/);
    expect(existsSync(join(runtime, ".agent-browser"))).toBe(false);
    expect((await readdir(sockets())).sort()).toEqual([`bot-${BOT_A}.pid`, `bot-${BOT_A}.target`]);
  });

  it("is declared only when lazurio browser link answers with the Environment's browser", async () => {
    expect(await start().declared()).toBe(true);
    await browser?.stop();
    expect(await start(() => ({ code: 10, stdout: JSON.stringify({ schema: "lazurio.browser-cli.v1", kind: "browser-link", available: false }) })).declared()).toBe(false);
    await browser?.stop();
    expect(await start(() => ({ code: 0, stdout: "not json" })).declared()).toBe(false);
    await browser?.stop();
    expect(await start(() => ({ code: -1, stdout: "" })).declared()).toBe(false);
  });

  it("does nothing where there is no runtime directory", async () => {
    browser = startEnvironmentBrowser({ env: { HOME: runtime }, bots: () => bots, onChange: () => () => {}, runLazurio: async () => ({ code: 127, stdout: "" }) });
    await browser.sync();
    expect(await readdir(runtime)).toEqual([]);
  });

  it("names the vendored Platform release in every holder file it writes", () => {
    expect(BROWSER_CONTRACT_RELEASE).toBe(provenance.version);
  });
});