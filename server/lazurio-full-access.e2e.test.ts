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