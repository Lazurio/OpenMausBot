// Lazurio overlay (DEV-6673, principle 2 of LAZURIO.md): every bot runs at
// Full access by default, on every server, and nothing gates it. A person may
// still choose to supervise a bot or a conversation. Real server, the
// repository's fake engines, a temporary data folder; never the person's home.
import { spawn, type ChildProcess } from "node:child_process";
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
});