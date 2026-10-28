// An Environment's MausBot sends no background test message to its engines unless OMB_AI_CHECKS=1 asks for them.
// Real server, a fake Claude that logs every connection check, a temporary home.
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

async function boot(checks: string | undefined) {
  const home = mkdtempSync(join(tmpdir(), "omb-lazurio-ai-checks-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const log = join(home, "claude-checks.jsonl");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_CHECK_LOG: log } } },
  }));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...verificationServerEnvironment(process.env, home, port) };
  delete env.OMB_AI_CHECKS;
  if (checks !== undefined) env.OMB_AI_CHECKS = checks;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const sent = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  const aiTest = async () => ((await (await fetch(`${base}/api/instances`, { headers: { origin: base } })).json()) as { instances: Array<{ instanceId: string; aiTest?: string }> })
    .instances.find((instance) => instance.instanceId === "claude")?.aiTest ?? null;
  return { sent, aiTest };
}

it("sends no background test message when OMB_AI_CHECKS is unset or 0", async () => {
  for (const checks of [undefined, "0"]) {
    const server = await boot(checks);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(server.sent(), String(checks)).toBe(0);
    expect(await server.aiTest(), String(checks)).toBeNull();
  }
}, 60_000);

it("sends them when OMB_AI_CHECKS=1 asks for them", async () => {
  const server = await boot("1");
  await expect.poll(server.sent, { timeout: 30_000, interval: 250 }).toBeGreaterThan(0);
  await expect.poll(server.aiTest, { timeout: 30_000, interval: 250 }).toBe("passed");
}, 60_000);
