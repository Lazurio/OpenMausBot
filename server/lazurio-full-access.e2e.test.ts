// Lazurio overlay (DEV-6673, principle 2 of LAZURIO.md): every bot runs at
// Full access by default, on every server, and nothing gates it. A person may
// still choose to supervise a bot or a conversation. Real server, the
// repository's fake engines, a temporary data folder; never the person's home.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

// A shared company workspace as upstream detects it (server/enterprise.ts).
const HOSTED = {
  OMB_ADMIN_URL: "https://admin.example.test",
  OMB_PUBLIC_URL: "https://acme.example.test",
  OMB_ADMIN_WORKSPACE: "acme",
  OMB_ADMIN_MEMBERSHIP: "portal",
};

/** Stops the fixture's server and starts it again on the same data folder, with `env` added. */
async function restart(fixture: VerificationServer, env: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const { url, dataDir, logPath } = fixture.info;
  const log = openSync(logPath, "a", 0o600);
  const server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), ...env },
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

describe("full access on a hosted server", () => {
  let fixture: VerificationServer;
  let server: ChildProcess | undefined;
  let url = "";

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer({});
    ({ url } = fixture.info);
    // The same data folder, restarted as a hosted company workspace.
    server = await restart(fixture, HOSTED);
  }, 60_000);

  afterAll(async () => {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture?.close();
  });

  it("runs the existing bot at Full and opens a Full thread without an operator policy", async () => {
    const bots = (await call("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; approvalMode: string }>;
    expect(bots).toHaveLength(1);
    expect(bots[0].approvalMode).toBe("full");
    const health = await call("GET", "/api/health");
    expect(health.body.capabilities).not.toHaveProperty("sharedWorkspaceFullAccess");
    const task = await call("POST", `/api/bots/${bots[0].id}/tasks`, { title: "Full on a hosted server", approvalMode: "full" });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    expect(task.body.task.approvalMode).toBe("full");
    const plain = await call("POST", `/api/bots/${bots[0].id}/tasks`, { title: "Default on a hosted server" });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.task.approvalMode).toBe("full");
  });
});

describe("no gate before a level a person picks", () => {
  let fixture: VerificationServer;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const firstThread = async (botId: string) => {
    const listed = (await call("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === botId);
    return (listed.tasks?.[0]?.threadId ?? listed.threadId) as string;
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("creates a bot at Full, and applies Auto on creation, on a bot and on a thread without a warning's confirmation", async () => {
    const plain = await call("POST", "/api/bots", { name: "Default level" });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.bot.approvalMode).toBe("full");

    const born = await call("POST", "/api/bots", { name: "Born on Auto", settings: { approvalMode: "auto" } });
    expect(born.status, JSON.stringify(born.body)).toBe(201);
    expect(born.body.bot.approvalMode).toBe("auto");

    const bot = await call("POST", "/api/bots", { name: "Switches to Auto", settings: { approvalMode: "ask" } });
    expect(bot.status).toBe(201);
    const id = bot.body.bot.id as string;
    const patched = await call("PATCH", `/api/bots/${id}`, { approvalMode: "auto", applyToAllThreads: true });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.bot.approvalMode).toBe("auto");

    const threadId = await firstThread(id);
    expect((await call("PATCH", `/api/bots/${id}/tasks/${threadId}`, { approvalMode: "ask" })).status).toBe(200);
    const thread = await call("PATCH", `/api/bots/${id}/tasks/${threadId}`, { approvalMode: "auto" });
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    expect(thread.body.task.approvalMode).toBe("auto");
    expect((await call("PATCH", `/api/bots/${id}/tasks/${threadId}`, { approvalMode: "ask" })).status).toBe(200);
    const refreshed = await call("PATCH", `/api/bots/${id}/tasks/${threadId}`, { refreshPermissions: true });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.task.approvalMode).toBe("auto");
  });

  it("refuses, as a whole, a write naming the removed Auto confirmation or the removed Custom level", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Removed fields" })).body.bot as { id: string };
    const threadId = await firstThread(bot.id);
    for (const [method, path, body] of [
      ["POST", "/api/bots", { name: "Confirmed", settings: { approvalMode: "auto" }, acknowledgeLocalAuto: true }],
      ["POST", "/api/bots", { name: "Custom", settings: { approvalMode: "custom" } }],
      ["PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", acknowledgeLocalAuto: true }],
      ["PATCH", `/api/bots/${bot.id}`, { approvalMode: "custom" }],
      ["PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { approvalMode: "auto", acknowledgeLocalAuto: true }],
      ["PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { refreshPermissions: true, acknowledgeLocalAuto: true }],
      ["PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { approvalMode: "custom" }],
      ["PUT", "/api/config", { newBotDefaults: { profile: { approvalMode: "custom" } } }],
    ] as const) {
      const result = await call(method, path, body);
      expect(result.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(result.body.error, `${method} ${path}`).toMatch(/removed|approvalMode must be/);
    }
    const listed = (await call("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === bot.id);
    expect(listed.approvalMode).toBe("full");
    expect((await call("GET", "/api/bots?messages=0")).body.bots.some((row: { name: string }) => row.name === "Confirmed" || row.name === "Custom")).toBe(false);
  });
  it("refuses a removed field on every bot and thread write, before anything changes", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Unchanged" })).body.bot as { id: string };
    const threadId = await firstThread(bot.id);
    const state = async () => {
      const bots = (await call("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; name: string; title?: string; tasks?: Array<{ threadId: string; title?: string }> }>;
      const own = bots.find((row) => row.id === bot.id)!;
      return { count: bots.length, title: own.title ?? "", threads: (own.tasks ?? []).map((task) => [task.threadId, task.title ?? ""]) };
    };
    const before = await state();
    const removed = [{ acknowledgeLocalAuto: true }, { approvePeerComms: true }, { approvalGrant: {} }, { approvalMode: "custom" }];
    for (const field of removed) {
      for (const [method, path, body] of [
        ["POST", "/api/bots", { name: "Created", ...field }],
        ["POST", "/api/bots", { name: "Created", settings: field }],
        ["PATCH", `/api/bots/${bot.id}`, { title: "Changed", ...field }],
        ["POST", `/api/bots/${bot.id}/tasks`, { title: "Created", ...field }],
        ["PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { title: "Changed", ...field }],
      ] as const) {
        const result = await call(method, path, body);
        expect(result.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
        expect(result.body.error, `${method} ${path}`).toMatch(/is not available in this distribution \(it was removed\)/);
      }
    }
    expect(await state()).toEqual(before);
  });

  it("offers Auto-accept edits at creation and as a new-bot default, where the bot's engine runs it", async () => {
    const instances = (await call("GET", "/api/instances")).body.instances as Array<{ instanceId: string; models: { default: string } }>;
    const model = (instanceId: string) => ({ instanceId, model: instances.find((item) => item.instanceId === instanceId)!.models.default });
    const count = async () => ((await call("GET", "/api/bots?messages=0")).body.bots as unknown[]).length;

    const claude = await call("POST", "/api/bots", { name: "Edits on Claude", modelSelection: model("claude"), settings: { approvalMode: "edits" } });
    expect(claude.status, JSON.stringify(claude.body)).toBe(201);
    expect(claude.body.bot.approvalMode).toBe("edits");

    const before = await count();
    const codex = await call("POST", "/api/bots", { name: "Edits on Codex", modelSelection: model("codex"), settings: { approvalMode: "edits" } });
    expect(codex.status, JSON.stringify(codex.body)).toBe(400);
    expect(codex.body.error).toMatch(/does not support the selected approval level/);
    expect(await count()).toBe(before);

    const defaults = await call("PUT", "/api/config", { newBotDefaults: { profile: { approvalMode: "edits" } } });
    expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
    const fromDefault = await call("POST", "/api/bots", { name: "Default edits", modelSelection: model("claude") });
    expect(fromDefault.status, JSON.stringify(fromDefault.body)).toBe(201);
    expect(fromDefault.body.bot.approvalMode).toBe("edits");
    const refused = await call("POST", "/api/bots", { name: "Default edits on Codex", modelSelection: model("codex") });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect((await call("PUT", "/api/config", { newBotDefaults: { profile: {} } })).status).toBe(200);
  });
});

describe("bots contact each other without a person's approval", () => {
  const TOKEN = "lazurio-full-access-fixture-0123456789abcdef";
  let fixture: VerificationServer;
  let server: ChildProcess | undefined;
  const call = async (method: string, path: string, body?: unknown, runtime = false) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(runtime ? { authorization: `Bearer ${TOKEN}` } : { origin: fixture.info.url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer({});
  }, 60_000);

  afterAll(async () => {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture?.close();
  });

  it("refuses, as a whole, a write naming the removed switch", async () => {
    const bot = (await call("POST", "/api/bots", { name: "Asks first" })).body.bot as { id: string };
    for (const [method, path, body] of [
      ["PATCH", `/api/bots/${bot.id}`, { approvePeerComms: true }],
      ["PATCH", `/api/bots/${bot.id}`, { approvePeerComms: false, title: "Not saved" }],
      ["POST", "/api/bots", { name: "Born asking", settings: { approvePeerComms: true } }],
      ["PUT", "/api/config", { newBotDefaults: { profile: { approvePeerComms: true } } }],
    ] as const) {
      const result = await call(method, path, body);
      expect(result.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(result.body.error).toMatch(/approvePeerComms is not available in this distribution \(it was removed\)/);
    }
    const listed = (await call("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; name: string; title?: string }>;
    expect(listed.find((row) => row.id === bot.id)?.title ?? "").not.toBe("Not saved");
    expect(listed.some((row) => row.name === "Born asking")).toBe(false);
  });

  it("drops a saved switch on load, and a bot at Ask hands work to a teammate with no approval card", async () => {
    const source = (await call("POST", "/api/bots", { name: "Hands off", settings: { approvalMode: "ask" } })).body.bot as { id: string };
    const peer = (await call("POST", "/api/bots", { name: "Takes it" })).body.bot as { id: string };
    const listed = (await call("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === source.id);
    const sourceThread = (listed.tasks?.[0]?.threadId ?? listed.threadId) as string;
    // A bots.json from before the removal: this bot asked a person before contacting another bot.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const botsFile = join(fixture.info.dataDir, "bots.json");
    const saved = JSON.parse(readFileSync(botsFile, "utf8")) as Array<Record<string, unknown>>;
    for (const bot of saved) if (bot.id === source.id) bot.approvePeerComms = true;
    writeFileSync(botsFile, JSON.stringify(saved, null, 2));
    server = await restart(fixture);
    const loaded = JSON.parse(readFileSync(botsFile, "utf8")) as Array<Record<string, unknown>>;
    expect(loaded.find((bot) => bot.id === source.id)).not.toHaveProperty("approvePeerComms");
    expect((await call("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === source.id))
      .toMatchObject({ approvalMode: "ask" });

    writeFileSync(join(fixture.info.dataDir, "external-runtimes.json"), JSON.stringify({ [source.id]: { token: TOKEN, threadId: sourceThread } }), { mode: 0o600 });
    const handed = await call("POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: "Check the fixture report.", consult: true }, true);
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    expect(handed.body.receipts).toEqual([expect.objectContaining({ botId: peer.id })]);
    const cards = ((await call("GET", `/api/threads/${sourceThread}/messages?limit=100`)).body.messages as Array<{ card?: { tool?: string } }>)
      .filter((message) => ["ask_bot", "delegate_bot", "post_to_room"].includes(message.card?.tool ?? ""));
    expect(cards).toEqual([]);
  });
});
