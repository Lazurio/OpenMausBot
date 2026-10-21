// Lazurio: on an Environment whose Codex system layer names the Organization's AI gateway (try-01 of the
// public Organization: provider lazurio-ai-pool, requires_openai_auth false, model gpt-6-luna) and where
// nobody signed in to ChatGPT or Claude, a new bot defaults to Codex with that model and its first turn
// runs without a sign-in card, on Codex's configured provider. Real server, the repository's fake
// engines, a temporary data folder; never the person's home.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const FAKE_CODEX = fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url));
const TRY01_LAYER = { layer: "system", model_provider: "lazurio-ai-pool", model: "gpt-6-luna", requires_openai_auth: false };

it("defaults a new bot to Codex with the gateway's model and runs it without a sign-in", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const codexDump = join(dataDir, "codex-dump.json");
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude = { ...config.instances.claude, environment: { FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_MODE: "not-logged-in" } };
    config.instances.codex = {
      driver: "codex", displayName: "Codex", config: { cli: FAKE_CODEX },
      environment: { FAKE_CODEX_MODE: "logged-out", FAKE_CODEX_LUNA: "1", FAKE_CODEX_PROVIDER_LAYER: JSON.stringify(TRY01_LAYER),
        FAKE_CODEX_DUMP: codexDump, FAKE_CODEX_DUMP_TURNS_ONLY: "1" },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const instances = (await api("GET", "/api/instances")).instances as any[];
    expect(instances.find((instance) => instance.instanceId === "codex").snapshot).toMatchObject({ state: "available", authenticated: true });
    expect(instances.find((instance) => instance.instanceId === "claude").snapshot).toMatchObject({ authenticated: false });
    expect(instances.find((instance) => instance.instanceId === "codex").models.default).toBe("gpt-6-luna");
    expect((await api("GET", "/api/bot-defaults")).modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-luna" });

    const { bot } = await control("new-bot", "--name", "Luna");
    expect(bot.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-luna" });
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "First turn" });
    await control("send", "--bot", bot.id, "--task", task.threadId, "--text", "GATEWAY_FIRST_TURN_3R");
    expect((await control("wait", "--bot", bot.id, "--task", task.threadId, "--timeout", "30")).status).toBe("settled");
    const messages = (await api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages as any[];
    expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true, text: "done from fake codex" });
    expect(messages.filter((message) => message.tool?.setup || message.tool?.name?.startsWith("error:"))).toEqual([]);

    const threadStart = (JSON.parse(readFileSync(codexDump, "utf8")).calls as Array<{ method: string; params: any }>)
      .find((call) => call.method === "thread/start")!;
    expect(threadStart.params.model).toBe("gpt-6-luna");
    expect(threadStart.params).not.toHaveProperty("modelProvider");
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}, 120_000);
