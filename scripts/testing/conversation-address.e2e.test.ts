// A conversation's web address in the served web app, in an owned disposable profile.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-omb-ui.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1";
const build = process.env.OMB_WEB_APP_BUILD || join(root, "dist");
const threadGone = JSON.parse(readFileSync(join(root, "src", "locales", "en.json"), "utf8"))["thread.gone"] as string;
if (!enabled) console.log("skipping the conversation address: build the UI and set OMB_UI_E2E=1 for browser qualification");

/** One tab of the fixture's Chrome, driven over its DevTools socket. */
async function openTab(devtools: string) {
  const socket = new WebSocket(devtools);
  const pending = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();
  let next = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Fixture Chrome connection failed")), { once: true });
  });
  const send = (method: string, params: unknown = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture Chrome ${method} timed out`)); }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const request = (method: string, params: unknown = {}) => send(method, params, sessionId);
  return {
    request,
    async evaluate(expression: string) {
      const value = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
      return value.result.value;
    },
    close: () => socket.close(),
  };
}

(enabled ? it : it.skip)("opens the conversation its address names with its bot, and any other address on /", async () => {
  if (!existsSync(join(build, "index.html"))) throw new Error("Run pnpm build before OMB_UI_E2E=1 web-app qualification");
  let fixture: VerificationServer | undefined;
  let chrome: ChildProcess | undefined;
  let tab: Awaited<ReturnType<typeof openTab>> | undefined;
  try {
    const browser = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || (await ensureUiBrowser()).chrome;
    if (!browser) throw new Error("This recipe needs Chrome: the pinned Chrome for Testing or AGENT_BROWSER_EXECUTABLE_PATH");
    fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, build);
    const { url, dataDir, logPath } = fixture.info;
    const create = async (name: string) =>
      (await runControlOmb(["new-bot", "--name", name, "--url", url]) as { bot: { id: string } }).bot.id;
    const pepper = await create("Pepper");
    const basil = await create("Basil");
    // `run` starts a new conversation each time; the second becomes Pepper's open one.
    const run = async (text: string) => (await runControlOmb(["run", "--bot", pepper, text, "--title", text,
      "--wait", "none", "--url", url]) as { threadId: string }).threadId;
    const first = await run("First brief for the address");
    const second = await run("Second brief for the address");
    expect(first).not.toBe(second);

    const page = await fetch(`${url}/c/${first}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<div id="root"></div>');

    const profile = join(dataDir, "chrome");
    mkdirSync(profile, { recursive: true });
    chrome = spawn(browser, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: dataDir, USERPROFILE: dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: "ignore",
    });
    const portFile = join(profile, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile), { timeout: 20_000 }).toBe(true);
    const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
    tab = await openTab(`ws://127.0.0.1:${port}${endpoint}`);
    const { request, evaluate } = tab;
    await request("Page.enable");
    await request("Runtime.enable");
    // Without the address the app would open on Basil, the conversation last open here.
    await request("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('omb-analytics-opt-out','1');"
      + "localStorage.setItem('omb-email-gate','skipped');"
      + `if (!sessionStorage.getItem('seeded')) { localStorage.setItem('openmausbot.lastConversation.v1', ${JSON.stringify(basil)}); sessionStorage.setItem('seeded','1'); }` });
    const composer = "document.querySelector('textarea[aria-label^=\"Message\"]')?.getAttribute('aria-label') ?? null";
    const transcript = "document.querySelector('[role=\"log\"][aria-label^=\"Conversation with\"]')?.textContent ?? ''";
    const open = async (path: string) => {
      await request("Page.navigate", { url: `${url}${path}` });
      await expect.poll(() => evaluate(composer), { timeout: 20_000 }).not.toBeNull();
    };

    await open("/");
    expect(await evaluate(composer)).toBe("Message Basil");

    await open(`/c/${first}`);
    await expect.poll(() => evaluate("location.pathname"), { timeout: 20_000 }).toBe("/");
    await expect.poll(() => evaluate(composer), { timeout: 20_000 }).toBe("Message Pepper");
    await expect.poll(() => evaluate(transcript), { timeout: 20_000 }).toContain("First brief for the address");
    expect(await evaluate(transcript)).not.toContain("Second brief for the address");
    expect(await evaluate("document.body.textContent.includes(" + JSON.stringify(threadGone) + ")")).toBe(false);
    const shot = await request("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${logPath}.conversation-address.png`, Buffer.from(shot.data, "base64"));

    await open(`/c/${randomUUID()}`);
    await expect.poll(() => evaluate("location.pathname"), { timeout: 20_000 }).toBe("/");
    await expect.poll(() => evaluate("document.body.textContent.includes(" + JSON.stringify(threadGone) + ")"), { timeout: 20_000 }).toBe(true);

    for (const path of ["/c/a%2Fb", "/c/"]) {
      await open(path);
      await expect.poll(() => evaluate("location.pathname"), { timeout: 20_000 }).toBe("/");
      expect(await evaluate("document.body.textContent.includes(" + JSON.stringify(threadGone) + ")")).toBe(false);
    }
    writeFileSync(`${logPath}.conversation-address.json`, JSON.stringify({ first, second, platform: process.platform }, null, 2));
    console.log(`Conversation address evidence: ${logPath}.conversation-address.json`);
  } finally {
    tab?.close();
    if (chrome) await waitForExit(chrome, { signal: "SIGTERM" });
    await fixture?.close();
  }
}, 660_000);
