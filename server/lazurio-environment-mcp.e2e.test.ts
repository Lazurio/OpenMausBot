// Lazurio overlay (DEV-6673, principles 3 and 5 of LAZURIO.md): bots get the
// MCP servers the Environment registers for every agent, Executor and Computer
// Use (`computer`) among them: a Claude bot's turn gets the user scope of
// ~/.claude.json as registered, and Codex reads its own ~/.codex/config.toml.
// There is no switch that leaves them out. Real server, the repository's fake
// engines, a temporary home; never the person's home.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

// The entry LazurioPlatform registers with `claude mcp add --scope user` and `codex mcp add`.
const COMPUTER = { type: "stdio", command: "/home/operator/.local/bin/cua-driver", args: ["mcp", "--socket", "/run/user/1000/lazurio-computer/driver.sock"], env: {} };

it("hands Claude and Codex bots the Environment's registered MCP servers, with no switch to leave them out", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { dataDir: home, url, logPath } = fixture.info;
  const codexDump = join(home, "codex-dump.json");
  let server: ChildProcess | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const start = async () => {
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, home, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const turn = async (botId: string, threadId: string) => {
    await control("send", "--bot", botId, "--task", threadId, "--text", "Open the program on the screen.");
    expect((await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // The Environment's home as LazurioPlatform leaves it, and a config.json in which upstream's switch was saved off.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { computer: COMPUTER } }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.computer]\ncommand = "${COMPUTER.command}"\nargs = ${JSON.stringify(COMPUTER.args)}\n`);
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.codex.environment = { FAKE_CODEX_DUMP: codexDump };
    config.features = { claudeUserMcp: false };
    writeFileSync(configPath, JSON.stringify(config));
    await start();
    expect((await call("GET", "/api/config")).body.features).not.toHaveProperty("claudeUserMcp");
    for (const value of [true, false]) {
      const refused = await call("PUT", "/api/config", { features: { claudeUserMcp: value } });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.error).toMatch(/features\.claudeUserMcp is not available in this distribution \(it was removed\)/);
    }

    const instances = (await call("GET", "/api/instances")).body.instances as any[];
    const model = (instanceId: string) => ({ instanceId, model: instances.find((item) => item.instanceId === instanceId).models.default });
    const bots: Record<string, { id: string; threadId: string }> = {};
    for (const instanceId of ["claude", "codex"]) {
      const created = await call("POST", "/api/bots", { name: `Screen ${instanceId}`, modelSelection: model(instanceId) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const task = (await call("POST", `/api/bots/${created.body.bot.id}/tasks`, { title: "Use a program" })).body.task;
      bots[instanceId] = { id: created.body.bot.id, threadId: task.threadId };
      await turn(bots[instanceId].id, task.threadId);
    }

    // Claude Code's user-scope servers reach the turn as registered; the rest of the machine's setup stays out.
    const claude = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(claude.mcpConfig.mcpServers.computer).toEqual(COMPUTER);
    expect(claude.argv).toContain("--strict-mcp-config");
    expect(claude.argv[claude.argv.indexOf("--setting-sources") + 1]).toBe("project");

    // Codex reads ~/.codex/config.toml; MausBot neither moves its home nor mounts its own `computer`.
    const codex = JSON.parse(readFileSync(codexDump, "utf8"));
    expect(codex.env.HOME).toBe(home);
    expect(codex.env.CODEX_HOME).toBeUndefined();
    expect((codex.argv as string[]).filter((arg) => arg.startsWith("mcp_servers.computer"))).toEqual([]);
    expect(codex.argv).not.toContain("--profile");
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, fixtureRemoved: !existsSync(home) }));
  }
}, 120_000);