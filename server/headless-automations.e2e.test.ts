// The published `openmausbot` entry, run as a child process against an isolated server, manages bots, routines and
// webhooks the way an agent on the same computer does (loopback is the owner; the server named by --port or OMB_PORT),
// and the MCP server it serves reads back, or makes, the same state.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const ENTRY = join(import.meta.dirname, "openmausbot.ts");

interface Ran { code: number | null; stdout: string; stderr: string }

let fixture: VerificationServer;
let port: string;
let dir: string;

function cli(args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
      env: { ...process.env, OPENMAUSBOT_TOKEN: "", OPENMAUSBOT_URL: "", OMB_PORT: port, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(input ?? "");
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`openmausbot ${args.join(" ")} did not finish: ${stderr}`)); }, 60_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const ok = async (args: string[], env?: NodeJS.ProcessEnv, input?: string) => {
  const ran = await cli([...args, "--json"], env, input);
  expect(ran.code, `${args.join(" ")}: ${ran.stdout}${ran.stderr}`).toBe(0);
  return JSON.parse(ran.stdout);
};

const api = async (path: string) => (await fetch(`${fixture.info.url}${path}`)).json() as Promise<Record<string, any>>;

/** One MCP session over the entry's stdio: the answer to one tools/call. */
function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "mcp"], {
      env: { ...process.env, OPENMAUSBOT_TOKEN: "", OMB_PORT: "", OPENMAUSBOT_URL: fixture.info.url }, stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`MCP ${name} did not answer`)); }, 60_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id !== 2) continue;
        clearTimeout(timer);
        child.stdin.end();
        if (message.error || message.result.isError) reject(new Error(JSON.stringify(message.error ?? message.result)));
        else resolve(message.result.structuredContent);
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

const call = (url: string, secret: string) => fetch(url, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ task: "A deploy finished." }),
}).then((response) => response.status);

beforeAll(async () => {
  fixture = await launchVerificationServer({});
  port = new URL(fixture.info.url).port;
  dir = mkdtempSync(join(tmpdir(), "omb-automations-e2e-"));
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  if (dir) await removeTempDir(dir);
});

describe("openmausbot automations against a real server", () => {
  it("creates, pauses, reschedules, runs and deletes a routine, and MCP sees the same routines", async () => {
    const henry = (await ok(["new-bot", "Henry", "--title", "Chief of Staff"])).bot;
    const created = await ok(["routine", "create", "Morning brief", "--bot", "henry", "--daily", "08:30", "--weekdays", "mon-fri", "--prompt", "-"], {}, "Summarize the night.\n");
    const id = created.routine.id;
    let stored = (await api("/api/routines")).routines.find((routine: any) => routine.id === id);
    expect(stored).toMatchObject({ name: "Morning brief", prompt: "Summarize the night.", botId: henry.id, enabled: true,
      schedule: { type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] } });
    expect(stored.nextRunAt).toBeGreaterThan(Date.now());

    await ok(["routine", "update", "Morning brief", "--pause", "--port", port], { OMB_PORT: "" });
    stored = (await api("/api/routines")).routines.find((routine: any) => routine.id === id);
    expect(stored).toMatchObject({ enabled: false, nextRunAt: null });
    await ok(["routine", "update", id, "--resume", "--every", "30m", "--window", "00:00-23:59", "--timeout", "45m"]);
    stored = (await api("/api/routines")).routines.find((routine: any) => routine.id === id);
    expect(stored).toMatchObject({ enabled: true, timeoutMinutes: 45, schedule: { type: "interval", everyMinutes: 30, window: { start: "00:00", end: "23:59" } } });

    const fromMcp = await mcpCall("list_routines", { bot_id: henry.id });
    expect(fromMcp.routines.map((routine: any) => routine.id)).toEqual((await ok(["routine", "list", "--bot", "Henry"])).routines.map((routine: any) => routine.id));

    const { run } = await ok(["routine", "run", "Morning brief"]);
    expect(run).toMatchObject({ routineId: id, manual: true });
    expect((await ok(["routine", "show", "Morning brief"])).runs.map((candidate: any) => candidate.id)).toContain(run.id);

    expect((await ok(["routine", "delete", "Morning brief", "--dry-run"])).dryRun).toBe(true);
    expect((await api("/api/routines")).routines.some((routine: any) => routine.id === id)).toBe(true);
    await ok(["routine", "delete", "Morning brief"]);
    expect((await api("/api/routines")).routines.some((routine: any) => routine.id === id)).toBe(false);
  }, 180_000);

  it("keeps a webhook's secret in a private file that the webhook accepts, rotates it and deletes the webhook", async () => {
    const file = join(dir, "deploys.secret");
    const made = await cli(["webhook", "create", "Deploys", "--bot", "Henry", "--delivery", "post", "--secret-file", file, "--json"]);
    expect(made.code, made.stderr).toBe(0);
    const { credential, webhook } = JSON.parse(made.stdout);
    const secret = readFileSync(file, "utf8").trim();
    expect(secret).toMatch(/^whsec_/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(made.stdout + made.stderr).not.toContain(secret);
    expect(await call(credential.endpointUrl, secret)).toBe(202);
    expect(await call(credential.endpointUrl, "whsec_wrong")).toBe(401);

    const rotated = await cli(["webhook", "rotate", "Deploys", "--secret-file", file, "--force"]);
    expect(rotated.code, rotated.stderr).toBe(0);
    const renewed = readFileSync(file, "utf8").trim();
    expect(renewed).not.toBe(secret);
    expect(rotated.stdout + rotated.stderr).not.toContain(renewed);
    expect(await call(credential.endpointUrl, secret)).toBe(401);
    expect(await call(credential.endpointUrl, renewed)).toBe(202);

    const listed = await cli(["webhook", "list", "--json"]);
    expect(JSON.parse(listed.stdout).webhooks).toEqual([expect.objectContaining({ id: webhook.id, endpointUrl: credential.endpointUrl, deliveryCount: 2 })]);
    expect(listed.stdout).not.toContain(renewed);
    expect((await mcpCall("list_webhooks", {})).webhooks.map((hook: any) => hook.id)).toEqual([webhook.id]);
    expect((await ok(["bot", "show", "Henry"])).webhooks.map((hook: any) => hook.id)).toEqual([webhook.id]);

    await ok(["webhook", "delete", "Deploys"]);
    expect(await call(credential.endpointUrl, renewed)).toBe(401);
    expect((await api("/api/webhooks")).webhooks).toEqual([]);
  }, 180_000);
});

/** A bot as the server keeps it, without what every creation makes anew: its id, name, colour and first conversation. */
const stored = async (id: string) => {
  const { id: _id, name: _name, color: _color, createdAt: _at, threadId: _thread, mainThreadId: _main, tasks: _tasks, messages: _messages,
    hasMore: _more, activeLeafId: _leaf, ...record } = (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === id);
  return record;
};

describe("openmausbot bot against a real server", () => {
  it("creates a bot with its instructions, gives it work and follows it to the end with the command line alone", async () => {
    const { bot } = await ok(["bot", "create", "Scout", "--title", "Release scout", "--model", "claude/claude-opus-5-5", "--effort", "high",
      "--prompt-file", "-"], {}, "Answer every question in one line.\n");
    expect(await stored(bot.id)).toMatchObject({ title: "Release scout", soul: "Answer every question in one line.",
      modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" } });

    expect(await ok(["run", "Scout", "Say hello."])).toMatchObject({ ok: true, exitCode: 0, state: "completed" });
    const turn = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(JSON.stringify(turn.prompt)).toContain("Say hello.");
    expect(turn.systemPrompt).toContain("Answer every question in one line.");
  }, 180_000);

  it("makes the same bot as MCP create_bot, from the same profile, model and instructions", async () => {
    const file = join(dir, "twin.md");
    writeFileSync(file, "Read the changelog first.\nThen answer.\n");
    const fromCli = (await ok(["bot", "create", "Twin", "--title", "Researcher", "--description", "Reads changelogs.", "--team", "Research",
      "--model", "claude/claude-sonnet-5-5", "--effort", "low", "--prompt-file", file])).bot;
    const fromMcp = (await mcpCall("create_bot", { name: "Twin by MCP", title: "Researcher", description: "Reads changelogs.", section: "Research",
      instance_id: "claude", model: "claude-sonnet-5-5", effort: "low", instructions: "Read the changelog first.\nThen answer.\n" })).bot;
    const made = await stored(fromCli.id);
    expect(made).toMatchObject({ section: "Research", soul: "Read the changelog first.\nThen answer." });
    expect(await stored(fromMcp.id)).toEqual(made);
  }, 180_000);

  it("changes a bot's profile and model, and MCP reads the same bot back", async () => {
    const before = await stored((await ok(["bot", "show", "Scout"])).bot.id);
    expect((await ok(["bot", "update", "Scout", "--title", "Changelog scout", "--dry-run"])).dryRun).toBe(true);
    expect(await stored((await ok(["bot", "show", "Scout"])).bot.id)).toEqual(before);

    const { bot } = await ok(["bot", "update", "Scout", "--name", "Changelog scout", "--title", "Reads changelogs", "--prompt", "Two lines at most.",
      "--port", port], { OMB_PORT: "" });
    await ok(["bot", "model", "changelog scout", "claude/claude-haiku-5-5", "--effort", "low"]);
    expect(await stored(bot.id)).toMatchObject({ title: "Reads changelogs", soul: "Two lines at most.",
      modelSelection: { instanceId: "claude", model: "claude-haiku-5-5", effort: "low" } });
    expect((await mcpCall("list_bots", {})).bots.find((candidate: any) => candidate.id === bot.id)).toMatchObject({
      name: "Changelog scout", title: "Reads changelogs", modelSelection: { instanceId: "claude", model: "claude-haiku-5-5", effort: "low" } });

    const refused = await cli(["bot", "model", "Changelog scout", "cursor/auto", "--json"]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error).toBe("model instance is unavailable: cursor");
    expect((await stored(bot.id)).modelSelection).toMatchObject({ model: "claude-haiku-5-5" });
  }, 180_000);
});
