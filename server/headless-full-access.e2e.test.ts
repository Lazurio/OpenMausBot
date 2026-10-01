// OMB_HEADLESS_FULL_ACCESS through the real isolated server. Without it the
// HTTP API refuses Full exactly as upstream does. With it the loopback owner
// sets a Codex bot and a Claude bot to Full through the same PATCH as any
// other setting, Custom stays refused, and the next turn of each engine runs
// with the provider's own permissive mode: Codex with `never` approvals in
// the `danger-full-access` sandbox, Claude with `bypassPermissions` and no
// approval broker. An unknown value stops the server at start.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const client = (fixture: () => VerificationServer) => async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture().info.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as any };
};

describe("a server started without OMB_HEADLESS_FULL_ACCESS", () => {
  let fixture: VerificationServer;
  const api = client(() => fixture);

  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env, OMB_HEADLESS_FULL_ACCESS: undefined });
  });
  afterAll(async () => { await fixture?.close(); });

  it("refuses Full over the API, as upstream does", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Upstream" })).body.bot;
    const refused = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("This approval-level change can only be made from the packaged desktop app");
    const stored = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id);
    expect(stored.approvalMode ?? "ask").toBe("ask");
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain("OMB_HEADLESS_FULL_ACCESS");
  });
});

describe("a server started with OMB_HEADLESS_FULL_ACCESS=1", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-headless-full-e2e-"));
  const codexDump = join(dir, "codex-dump.json");
  let fixture: VerificationServer;
  const api = client(() => fixture);

  beforeAll(async () => {
    // One-shot Claude runs (titles) write elsewhere, so the turn dump is the bot's turn.
    fixture = await launchVerificationServer({
      ...process.env,
      OMB_HEADLESS_FULL_ACCESS: "1",
      FAKE_CLAUDE_TEXT_DUMP: join(dir, "claude-text-dump.json"),
    }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
    // Record the fake Codex app-server's calls, as server/delta-context.e2e.test.ts does.
    const wrapper = join(dir, "codex.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `process.env.FAKE_CODEX_DUMP = ${JSON.stringify(codexDump)};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "testing", "fake-codex-app-server.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/codex", { cli: wrapper })).status).toBe(200);
  });
  afterAll(async () => {
    await fixture?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const createBot = async (name: string, instanceId: "codex" | "claude") => {
    const instance = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === instanceId);
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: instance.models.default } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot;
  };

  it("says so once at start", () => {
    const log = readFileSync(fixture.info.logPath, "utf8");
    expect(log.split("[approvals] OMB_HEADLESS_FULL_ACCESS is on").length - 1).toBe(1);
  });

  it("runs a Codex bot set to Full without a sandbox or approvals", async () => {
    const bot = await createBot("Codex steward", "codex");
    const full = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.bot).toMatchObject({ approvalMode: "full", autoApprove: false });

    // Custom, and leaving Full for it, stay desktop-only.
    const custom = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "custom" });
    expect(custom.status).toBe(403);
    expect(custom.body.error).toMatch(/packaged desktop app/);

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Review the pull request." })).status).toBe(202);
    let calls: Array<{ method: string; params: any }> = [];
    await expect.poll(() => {
      calls = existsSync(codexDump) ? JSON.parse(readFileSync(codexDump, "utf8")).calls : [];
      return calls.some((call) => call.method === "turn/start");
    }, { timeout: 20_000, interval: 200 }).toBe(true);
    expect(calls.find((call) => call.method === "thread/start")?.params)
      .toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(calls.find((call) => call.method === "turn/start")?.params)
      .toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(readFileSync(fixture.info.logPath, "utf8"))
      .toContain(`bot ${bot.id}: approval level raised to Full`);
  });

  it("runs a Claude bot set to Full with bypassPermissions and no approval broker", async () => {
    const bot = await createBot("Claude steward", "claude");
    const full = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.bot).toMatchObject({ approvalMode: "full", autoApprove: false });

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Review the pull request." })).status).toBe(202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 20_000, interval: 200 }).toBe(true);
    const argv: string[] = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).argv;
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(argv).not.toContain("--permission-prompt-tool");

    // Back to Ask needs no opt-in, as upstream; Custom is never unlocked.
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
      .find((candidate: any) => candidate.id === bot.id).busy, { timeout: 20_000, interval: 200 }).toBe(false);
    const ask = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    expect(ask.status).toBe(200);
    expect(ask.body.bot).toMatchObject({ approvalMode: "ask" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "custom" })).status).toBe(400);
  });
});

describe("a server started with an unknown OMB_HEADLESS_FULL_ACCESS", () => {
  it("does not start, and says why", async () => {
    const launch = launchVerificationServer({ ...process.env, OMB_HEADLESS_FULL_ACCESS: "yes" });
    const error = await launch.then(
      async (fixture) => { await fixture.close(); throw new Error("the server started"); },
      (failure: Error) => failure,
    );
    expect(error.message).toMatch(/exited before it was ready/);
    const logPath = /see (\S+)$/.exec(error.message)?.[1];
    expect(logPath && readFileSync(logPath, "utf8")).toContain('OMB_HEADLESS_FULL_ACCESS must be 1 to allow Full access over the API, got "yes"');
  });
});
