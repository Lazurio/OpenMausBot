// Lazurio overlay (DEV-6673, principle 3 of LAZURIO.md): access is shared, never
// split per bot. Every bot gets the tools the Environment provides; there is no
// per-bot tool selection to set, and a saved one loads and drops. Real server,
// the repository's fake engines, a temporary data folder; never the person's home.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

/** Stops the fixture's server and starts it again on the same data folder. */
async function restart(fixture: VerificationServer): Promise<ChildProcess> {
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const { url, dataDir, logPath } = fixture.info;
  const log = openSync(logPath, "a", 0o600);
  const server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the restarted server did not start; see ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return server;
}

describe("every bot gets the Environment's tools", () => {
  let fixture: VerificationServer;
  let server: ChildProcess | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const listed = async () => (await call("GET", "/api/bots?messages=0")).body.bots as Array<Record<string, any>>;

  beforeAll(async () => {
    fixture = await launchVerificationServer({});
  }, 60_000);

  afterAll(async () => {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture?.close();
  });

  it("refuses, as a whole, every bot, thread and default write that names a tool selection", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Every tool" })).body.bot as { id: string };
    const own = (await listed()).find((row) => row.id === bot.id)!;
    const threadId = (own.tasks?.[0]?.threadId ?? own.threadId) as string;
    const before = JSON.stringify(await listed());
    for (const toolScope of [{ allow: [] }, { deny: ["native:Bash"] }, null]) {
      for (const [method, path, body] of [
        ["POST", "/api/bots", { name: "Created", toolScope }],
        ["POST", "/api/bots", { name: "Created", settings: { toolScope } }],
        ["PATCH", `/api/bots/${bot.id}`, { title: "Changed", toolScope }],
        ["POST", `/api/bots/${bot.id}/tasks`, { title: "Created", toolScope }],
        ["PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { title: "Changed", toolScope }],
        ["PUT", "/api/config", { newBotDefaults: { profile: { notifications: false, toolScope } } }],
      ] as const) {
        const result = await call(method, path, body);
        expect(result.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
        expect(result.body.error, `${method} ${path}`).toMatch(/toolScope is not available in this distribution \(it was removed\)/);
      }
    }
    expect(JSON.stringify(await listed())).toBe(before);
  });

  it("starts with a bots.json that still has tool selections, drops them and keeps the bots", async () => {
    const narrowed = (await call("POST", "/api/bots", { name: "Narrowed" })).body.bot as { id: string };
    const corrupt = (await call("POST", "/api/bots", { name: "Corrupt selection" })).body.bot as { id: string };
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const botsFile = join(fixture.info.dataDir, "bots.json");
    const saved = JSON.parse(readFileSync(botsFile, "utf8")) as Array<Record<string, unknown>>;
    for (const bot of saved) {
      if (bot.id === narrowed.id) bot.toolScope = { allow: [], deny: ["mcp:mail:*"] };
      if (bot.id === corrupt.id) bot.toolScope = { allow: "all" };
    }
    writeFileSync(botsFile, JSON.stringify(saved, null, 2));
    server = await restart(fixture);
    const loaded = JSON.parse(readFileSync(botsFile, "utf8")) as Array<Record<string, unknown>>;
    for (const id of [narrowed.id, corrupt.id]) {
      expect(loaded.find((bot) => bot.id === id)).not.toHaveProperty("toolScope");
      expect((await listed()).find((row) => row.id === id)).not.toHaveProperty("toolScope");
    }
    const patched = await call("PATCH", `/api/bots/${narrowed.id}`, { title: "Still works" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });
});
