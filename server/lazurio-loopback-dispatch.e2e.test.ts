// The calls an Environment's automation makes to its own MausBot over loopback: plain HTTP from 127.0.0.1, with no
// forwarding headers, session, Origin or Sec-Fetch headers. A headless server treats such a caller as its owner; these
// calls must keep working exactly as sent.
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

interface Answer { status: number; body: unknown }

/** One request through node:http, so no header is added that the caller would not send. */
function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const url = new URL(path, base);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(url.port), method, path: `${url.pathname}${url.search}`,
      headers: { ...headers, ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* a plain-text answer stays text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const CLI = { "content-type": "application/json", "x-openmausbot-cli": "1" };

describe("an Environment's loopback dispatch", () => {
  let fixture: VerificationServer;
  let base = "";

  beforeAll(async () => {
    fixture = await launchVerificationServer({});
    base = fixture.info.url;
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("reads the server's health and its bots without messages", async () => {
    expect((await call(base, "GET", "/api/health")).status).toBe(200);
    const bots = await call(base, "GET", "/api/bots?messages=0");
    expect(bots.status).toBe(200);
    expect(Array.isArray((bots.body as { bots?: unknown[] }).bots)).toBe(true);
  });

  it("opens a task on a bot and sends a message into it", async () => {
    const created = await call(base, "POST", "/api/bots", { name: "Dispatch fixture" }, { "content-type": "application/json" });
    expect(created.status).toBe(201);
    const botId = (created.body as { bot: { id: string } }).bot.id;
    const task = await call(base, "POST", `/api/bots/${encodeURIComponent(botId)}/tasks`, { title: "Review a pull request" }, CLI);
    expect(task.status, JSON.stringify(task.body)).toBeLessThan(300);
    const threadId = (task.body as { task: { threadId: string } }).task.threadId;
    expect(threadId).toBeTruthy();
    const message = await call(base, "POST", `/api/bots/${encodeURIComponent(botId)}/messages`, { text: "Please review it.", threadId }, CLI);
    expect(message.status, JSON.stringify(message.body)).toBeLessThan(300);
  });

  it("reads the GitHub intake and the Environment descriptor", async () => {
    const intake = await call(base, "GET", "/api/github-intake");
    expect(intake.status, JSON.stringify(intake.body)).toBe(200);
    const environment = await call(base, "GET", "/.well-known/openmausbot/environment");
    expect(environment.status).toBe(200);
    expect(environment.body).toMatchObject({ capabilities: expect.any(Object) });
  });
});
