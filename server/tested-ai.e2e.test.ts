// Real server, a fake Claude whose test message would fail: a saved default is never tested or moved.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

/** `claude`'s connection check fails. */
function freshHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omb-tested-ai-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: {
      claude: { driver: "claudeAgent", displayName: "Silent Claude", config: { cli: FAKE_CLI },
        environment: { FAKE_CLAUDE_CHECK: "fail", FAKE_CLAUDE_CHECK_LOG: join(home, "claude-checks.jsonl") } },
    },
    ...extra,
  }));
  return home;
}

async function boot(home: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    // Background test messages are off in test fixtures unless asked for.
    env: { ...verificationServerEnvironment(process.env, home, port), OMB_AI_CHECKS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<any>;
  };
  const sent = (instance: string) => existsSync(join(home, `${instance}-checks.jsonl`))
    ? readFileSync(join(home, `${instance}-checks.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).prompt as string) : [];
  const tests = async () => Object.fromEntries(((await api("GET", "/api/instances")).instances as Array<{ instanceId: string; aiTest?: string }>)
    .filter((instance) => instance.instanceId === "claude")
    .map((instance) => [instance.instanceId, instance.aiTest ?? null]));
  const starter = async () => ((await api("GET", "/api/bots?messages=0")).bots as Array<{ chiefOfStaff?: boolean; modelSelection: { instanceId: string } }>)
    .find((bot) => bot.chiefOfStaff)!;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { api, sent, tests, starter, stop };
}

it("never tests or moves a saved default", async () => {
  const server = await boot(freshHome({ defaultModelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }));
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(await server.tests()).toEqual({ claude: null });
  expect(server.sent("claude")).toEqual([]);
  expect((await server.starter()).modelSelection.instanceId).toBe("claude");
}, 60_000);
