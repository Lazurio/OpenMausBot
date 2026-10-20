// Lazurio overlay (DEV-6673, task 2026-10-05-510): the bots' strips of the Environment browser through the
// real isolated server. OMB_TEST_ENVIRONMENT_BROWSER (scripts/control-omb.ts) stands in for a Lazurio
// Environment that declares its browser: a fake Platform CLI and a runtime directory. agent-browser's session
// bindings are written as the Platform's `lazurio browser window` leaves them. No browser runs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomBytes } from "node:crypto";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const TAB_A = "A1".repeat(16);
const TAB_B = "B2".repeat(16);

describe.skipIf(process.platform === "win32")("a Lazurio server on an Environment with its browser", () => {
  let fixture: VerificationServer;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const runtime = () => join(fixture.info.dataDir, "run");
  const holder = (botId: string) => join(runtime(), "lazurio-browser", "holders", `bot-${botId}.json`);
  const calls = () => existsSync(join(fixture.info.dataDir, "lazurio-calls.log"))
    ? readFileSync(join(fixture.info.dataDir, "lazurio-calls.log"), "utf8").trim().split("\n") : [];
  /** As `lazurio browser window --session bot-<id>` leaves agent-browser's binding, with a running daemon. */
  const bind = (botId: string, targetId: string) => {
    const sockets = join(runtime(), "agent-browser");
    mkdirSync(sockets, { recursive: true });
    writeFileSync(join(sockets, `bot-${botId}.target`), JSON.stringify({ targetId, url: "about:blank", pinned: true }));
    writeFileSync(join(sockets, `bot-${botId}.pid`), String(process.pid));
  };
  const tabsOf = (botId: string) => existsSync(holder(botId)) ? (JSON.parse(readFileSync(holder(botId), "utf8")) as { tabs: string[] }).tabs : null;

  const capabilityKey = randomBytes(24).toString("hex");
  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env, OMB_TEST_ENVIRONMENT_BROWSER: "1", OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey });
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("keeps each bot's own tabs in its own strip, and lets them go on archive and on delete", async () => {
    const a = (await call("POST", "/api/bots", { name: "Researcher" })).body.bot;
    const b = (await call("POST", "/api/bots", { name: "Writer" })).body.bot;
    bind(a.id, TAB_A);
    bind(b.id, TAB_B);
    // A change of a bot reconciles the strips at once (the Store's change), without the 30 s beat.
    expect((await call("PATCH", `/api/bots/${a.id}`, { title: "Finds sources" })).status).toBe(200);
    await expect.poll(() => tabsOf(a.id), { timeout: 10_000 }).toEqual([TAB_A]);
    await expect.poll(() => tabsOf(b.id), { timeout: 10_000 }).toEqual([TAB_B]);
    expect(JSON.parse(readFileSync(holder(a.id), "utf8"))).toMatchObject({ schema: "lazurio.browser-holder.v1", strip: `bot-${a.id}`, label: "Researcher" });

    expect((await call("PATCH", `/api/bots/${a.id}`, { hidden: true })).status).toBe(200);
    await expect.poll(() => existsSync(holder(a.id)), { timeout: 10_000 }).toBe(false);
    await expect.poll(calls, { timeout: 10_000 }).toContain(`browser done --session bot-${a.id} --json`);
    expect(tabsOf(b.id)).toEqual([TAB_B]);

    expect((await call("DELETE", `/api/bots/${b.id}`)).status).toBe(200);
    await expect.poll(() => existsSync(holder(b.id)), { timeout: 10_000 }).toBe(false);
    await expect.poll(calls, { timeout: 10_000 }).toContain(`browser done --session bot-${b.id} --json`);
  });

  it("gives the bot's panel its strip, each tab with its Platform view", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Panel" })).body.bot;
    expect((await call("GET", `/api/bots/${bot.id}/browser`)).body).toEqual({
      available: true, strip: `bot-${bot.id}`, viewOrigin: "https://browser.vm-01.example.lazurio.io", tabs: [], current: null,
    });
    bind(bot.id, TAB_A);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { title: "Reads pages" })).status).toBe(200);
    await expect.poll(async () => (await call("GET", `/api/bots/${bot.id}/browser`)).body, { timeout: 10_000 }).toEqual({
      available: true,
      strip: `bot-${bot.id}`,
      viewOrigin: "https://browser.vm-01.example.lazurio.io",
      current: TAB_A,
    });
    expect((await call("POST", `/api/bots/${bot.id}/browser`)).status).toBe(405);
    expect((await call("GET", "/api/bots/no-such-bot/browser")).status).toBe(404);
  });

  it("holds a tab the person chose and lets it go on ×, and announces a tab the bot's session newly opens", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Holds" })).body.bot;
    const events = new AbortController();
    const frames: string[] = [];
    const stream = fetch(`${fixture.info.url}/api/events`, { headers: { origin: fixture.info.url }, signal: events.signal }).then(async (response) => {
      const reader = response.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        frames.push(new TextDecoder().decode(value));
      }
    }).catch(() => {});
    try {
      const held = await call("POST", `/api/bots/${bot.id}/browser/hold`, { tabId: TAB_B.toLowerCase() });
      expect(held.status).toBe(200);
      expect(tabsOf(bot.id)).toEqual([TAB_B]);
      expect((await call("POST", `/api/bots/${bot.id}/browser/hold`, { tabId: "nope" })).status).toBe(400);
      expect((await call("GET", `/api/bots/${bot.id}/browser/hold`)).status).toBe(405);
      expect((await call("POST", `/api/bots/${bot.id}/browser/release`, { tabId: TAB_B })).body.tabs).toEqual([]);
      expect(existsSync(holder(bot.id))).toBe(false);

      bind(bot.id, TAB_A);
      await expect.poll(() => tabsOf(bot.id), { timeout: 10_000 }).toEqual([TAB_A]);
      await expect.poll(() => frames.join(""), { timeout: 10_000 }).toContain(JSON.stringify({ kind: "lazurio-browser-tab", botId: bot.id, tabId: TAB_A }).slice(1, -1));
    } finally {
      events.abort();
      await stream;
    }
    expect((await call("PATCH", `/api/bots/${bot.id}`, { hidden: true })).status).toBe(200);
    expect((await call("POST", `/api/bots/${bot.id}/browser/hold`, { tabId: TAB_B })).status).toBe(404);
  });

  it("names the bot's tab on a sign-in it asks for there, which opens the person's panel on it; never for a Lazurio account", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Signs in" })).body.bot;
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "Get the report." })).status).toBe(202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    bind(bot.id, TAB_B);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { title: "Reads reports" })).status).toBe(200);
    await expect.poll(() => tabsOf(bot.id), { timeout: 10_000 }).toEqual([TAB_B]);

    const minted = await fetch(`${fixture.info.url}/api/testing/internal-capability`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openmausbot-test-capability": capabilityKey },
      body: JSON.stringify({ botId: bot.id, threadId: bot.threadId }),
    });
    const { token } = await minted.json() as { token: string };
    const ask = async (site: string) => {
      const response = await fetch(`${fixture.info.url}/api/internal/request-sign-in`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, site, reason: "A login." }),
      });
      expect(response.status, site).toBe(201);
      const { messageId } = await response.json() as { messageId: string };
      const { messages } = (await call("GET", `/api/threads/${bot.threadId}/messages`)).body as { messages: Array<{ id: string; signIn?: Record<string, unknown> }> };
      return messages.find((message) => message.id === messageId)!.signIn!;
    };
    expect(await ask("https://example.com/login")).toMatchObject({ site: "example.com", place: "browser", tab: TAB_B });
    const account = await ask("https://auth.lazurio.io/sign-in");
    expect(account).toMatchObject({ site: "auth.lazurio.io", place: "browser" });
    expect(account).not.toHaveProperty("tab");
  });

  it("tells a bot its own session and the Platform's commands", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Browser user" })).body.bot;
    const sections = (await call("GET", `/api/bots/${bot.id}/system-prompt`)).body.sections as Array<{ id: string; text: string }>;
    const browser = sections.find((section) => section.id === "browser")?.text ?? "";
    expect(browser).toContain(`lazurio browser window --session bot-${bot.id}`);
    expect(browser).toContain(`agent-browser --cdp 9222 --session bot-${bot.id}`);
    expect(browser).toContain(`lazurio browser done --session bot-${bot.id}`);
  });

  it("runs a bot's engine with its own agent-browser session, so a command without --session uses it", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Session user" })).body.bot;
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "Open a page." })).status).toBe(202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).env?.AGENT_BROWSER_SESSION; } catch { return undefined; } },
      { timeout: 5_000 }).toBe(`bot-${bot.id}`);
  });

  it("offers no browser setting of MausBot's own", async () => {
    const config = (await call("GET", "/api/config")).body;
    expect(config).not.toHaveProperty("browserEngine");
    expect(config).not.toHaveProperty("browserProfiles");
    expect(config.features).not.toHaveProperty("browser");
  });

  it("runs no browser or agent-browser daemon of its own", () => {
    const table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((match) => match !== null)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }));
    const descendants = new Set([fixture.info.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); grew = true; }
    }
    const spawned = table.filter((row) => descendants.has(row.pid) && row.pid !== fixture.info.pid).map((row) => row.command);
    expect(spawned.filter((command) => /agent-browser|chrome|chromium/i.test(command))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("a Lazurio server without a declared Environment browser", () => {
  let fixture: VerificationServer;
  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env });
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("answers the bot's panel that there is no browser, and holds nothing", async () => {
    const headers = { "content-type": "application/json", origin: fixture.info.url };
    const bot = (await (await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name: "No panel" }) })).json() as any).bot;
    expect(await (await fetch(`${fixture.info.url}/api/bots/${bot.id}/browser`, { headers })).json()).toEqual({ available: false });
    expect((await fetch(`${fixture.info.url}/api/bots/${bot.id}/browser/hold`, { method: "POST", headers, body: JSON.stringify({ tabId: TAB_A }) })).status).toBe(409);
  });

  it("tells its bots plainly that the Environment browser is unavailable", async () => {
    const headers = { "content-type": "application/json", origin: fixture.info.url };
    const bot = (await (await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name: "No browser" }) })).json() as any).bot;
    const sections = (await (await fetch(`${fixture.info.url}/api/bots/${bot.id}/system-prompt`, { headers })).json() as any).sections as Array<{ id: string; text: string }>;
    const browser = sections.find((section) => section.id === "browser")?.text ?? "";
    expect(browser).toMatch(/This Environment has no Environment browser/);
    expect(browser).not.toContain("agent-browser --cdp");
  });

  it("gives the bot's engine no agent-browser session", async () => {
    const headers = { "content-type": "application/json", origin: fixture.info.url };
    const bot = (await (await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name: "No session" }) })).json() as any).bot;
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "Hello." }) })).status).toBe(202);
    await expect.poll(() => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).env !== undefined; } catch { return false; } }, { timeout: 15_000 }).toBe(true);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).env.AGENT_BROWSER_SESSION).toBeUndefined();
  });
});