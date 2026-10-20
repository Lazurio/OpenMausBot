// Lazurio overlay (DEV-6673): the right panel's routes to a bot's strip name another holder of a tab only to
// whoever may see it, by the rules that gate /api/bots/<bot>, against the real strips in a scratch runtime directory.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { holderFileText } from "../../lazurio/browser-contract/pure.js";
import { SEES_EVERYTHING, VisibleSet, type Viewer, type VisibilityBot } from "../bot-visibility.ts";
import { json, readBody } from "../harness/http.ts";
import { BROWSER_CONTRACT_RELEASE, startEnvironmentBrowser, type EnvironmentBrowser } from "../lazurio-environment-browser.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createLazurioBrowserRoutes, stripAudienceOf } from "./lazurio-browser.ts";
import { dispatchRoutes } from "./table.ts";

const TAB = "D4".repeat(16);
const VIEW = "https://browser.vm-01.example.lazurio.io";
const MEMBER = "member@example.test";
const ADMIN = "admin@example.test";

describe("the panel's routes to a bot's strip", () => {
  let runtime: string;
  let browser: EnvironmentBrowser | null = null;
  let server: Server | null = null;
  const bots: Array<VisibilityBot & { name: string }> = [
    { id: "public", threadId: "t-public", name: "Helpdesk" },
    { id: "helper", threadId: "t-helper", name: "Helper" },
    { id: "private", threadId: "t-private", name: "Payroll", visibility: "admins" },
  ];

  beforeEach(async () => {
    runtime = await mkdtemp(join(tmpdir(), "omb-browser-route-"));
  });

  afterEach(async () => {
    if (server) await new Promise((done) => server!.close(done));
    server = null;
    await browser?.stop();
    browser = null;
    await rm(runtime, { recursive: true, force: true });
  });

  /** The server's gate in small: an admin sees everything, a member what the bots' visibility shows them. */
  async function serve() {
    browser = startEnvironmentBrowser({
      env: { XDG_RUNTIME_DIR: runtime, HOME: runtime },
      bots: () => bots,
      onChange: () => () => {},
      runLazurio: async () => ({ code: 0, stdout: JSON.stringify({ schema: "lazurio.browser-cli.v1", kind: "browser-link", session: null, link: `${VIEW}/` }) }),
      now: async () => ({ boot: "8e1c8f0e-6c3b-4b39-9d3e-1f2a3b4c5d6e", at: 100 }),
      everyMs: 60_000,
      log: () => {},
    });
    const viewerOf = (email: string): Viewer => (email === ADMIN ? SEES_EVERYTHING : { kind: "member", email });
    const routes = [createLazurioBrowserRoutes({
      browser,
      liveBot: (id) => bots.some((bot) => bot.id === id),
      audience: (auth) => {
        const viewer = viewerOf(auth.kind === "session" ? auth.session.email ?? "" : ADMIN);
        return stripAudienceOf(viewer, new VisibleSet(bots, [], viewer));
      },
    })];
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const email = String(req.headers["x-as"] ?? ADMIN);
      const auth = { kind: "session", via: "bearer", scopes: email === ADMIN ? ["admin", "client"] : ["client"], session: { email } } as unknown as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    });
    await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (as: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "x-as": as, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    };
  }

  /** One tab held by the Launchpad, a visible bot, a restricted bot and a T3 Code thread, besides the public bot. */
  async function shareTab() {
    const holders = join(runtime, "lazurio-browser", "holders");
    await mkdir(holders, { recursive: true });
    const tabs = [{ id: TAB, recordedAt: null }];
    await writeFile(join(holders, "bot-helper.json"), holderFileText("bot-helper", "Helper", tabs, BROWSER_CONTRACT_RELEASE));
    await writeFile(join(holders, "bot-private.json"), holderFileText("bot-private", "Payroll", tabs, BROWSER_CONTRACT_RELEASE));
    await writeFile(join(holders, "t3-secret.json"), JSON.stringify({ strip: "t3-secret", label: "Layoffs list", tabs: [TAB] }));
    await writeFile(join(holders, "launchpad.json"), JSON.stringify({ strip: "launchpad", label: "Apps", tabs: [TAB] }));
  }

  it("names to a restricted member only the holders they may see, and says only that the tab is held elsewhere", async () => {
    const call = await serve();
    await shareTab();
    expect((await call(ADMIN, "POST", "/api/bots/public/browser/hold", { tabId: TAB })).status).toBe(200);
    await browser!.sync();

    const seen = await call(MEMBER, "GET", "/api/bots/public/browser");
    expect(seen.status).toBe(200);
    expect(seen.body.tabs).toHaveLength(1);
    expect(seen.body.tabs[0]).toMatchObject({ tabId: TAB, view: `${VIEW}/t/${TAB}`, agent: false, alsoHeldElsewhere: true });
    const strip = (holder: { strip: string }) => holder.strip;
    expect([...seen.body.tabs[0].alsoHeldBy].sort((a: { strip: string }, b: { strip: string }) => strip(a).localeCompare(strip(b))))
      .toEqual([{ strip: "bot-helper", label: "Helper" }, { strip: "launchpad", label: "Apps" }]);
    const text = JSON.stringify(seen.body);
    for (const secret of ["bot-private", "Payroll", "t3-secret", "Layoffs list"]) expect(text).not.toContain(secret);

    // The member's own hold and release answer with the same narrowed strip.
    const released = await call(MEMBER, "POST", "/api/bots/public/browser/release", { tabId: TAB });
    expect(released.status).toBe(200);
    expect(released.body.tabs).toEqual([]);
    const held = await call(MEMBER, "POST", "/api/bots/public/browser/hold", { tabId: TAB });
    expect(held.status).toBe(200);
    for (const secret of ["bot-private", "Payroll", "t3-secret", "Layoffs list"]) expect(JSON.stringify(held.body)).not.toContain(secret);
    expect(held.body.tabs[0].alsoHeldElsewhere).toBe(true);
  });

  it("names every holder to an admin", async () => {
    const call = await serve();
    await shareTab();
    await call(ADMIN, "POST", "/api/bots/public/browser/hold", { tabId: TAB });
    await browser!.sync();
    const seen = await call(ADMIN, "GET", "/api/bots/public/browser");
    expect(seen.body.tabs[0].alsoHeldElsewhere).toBe(false);
    expect(seen.body.tabs[0].alsoHeldBy.map((holder: { strip: string }) => holder.strip).sort())
      .toEqual(["bot-helper", "bot-private", "launchpad", "t3-secret"]);
  });

  it("names no T3 Code thread to a member even where no bot is restricted", async () => {
    bots[2] = { ...bots[2]!, visibility: undefined };
    try {
      const call = await serve();
      await shareTab();
      await call(ADMIN, "POST", "/api/bots/public/browser/hold", { tabId: TAB });
      await browser!.sync();
      const seen = await call(MEMBER, "GET", "/api/bots/public/browser");
      expect(seen.body.tabs[0].alsoHeldBy.map((holder: { strip: string }) => holder.strip).sort()).toEqual(["bot-helper", "bot-private", "launchpad"]);
      expect(seen.body.tabs[0].alsoHeldElsewhere).toBe(true);
      expect(JSON.stringify(seen.body)).not.toContain("Layoffs list");
    } finally {
      bots[2] = { ...bots[2]!, visibility: "admins" };
    }
  });
});
