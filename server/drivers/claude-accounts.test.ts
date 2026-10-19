import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CLAUDE_AUTH_ENV_KEYS, ClaudeDriver, resolveClaudeConfigDir } from "./claude.ts";

// Reads synthetic login labels and records its spawn contract; never the real CLI, Keychain or network.
const FAKE_CLI = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, ".claude");
const auth = JSON.parse(readFileSync(join(configDir, "fixture-auth.json"), "utf8"));
const keys = ${JSON.stringify(CLAUDE_AUTH_ENV_KEYS)};
appendFileSync(join(configDir, "calls.ndjson"), JSON.stringify({
  args, configDir, home: process.env.HOME,
  env: Object.fromEntries(keys.map(key => [key, process.env[key]]))
}) + "\\n");
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "--version") { console.log("fixture-claude"); process.exit(0); }
if (args[0] === "--help") { console.log("Usage: claude [options]\\n  --model <model>  Model"); process.exit(0); }
if (args[0] === "auth") { out(auth); process.exit(auth.loggedIn ? 0 : 1); }
if (args.includes("text")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(auth.email));
} else {
  createInterface({ input: process.stdin }).on("line", () => {
    out({ type: "system", subtype: "init", session_id: auth.email });
    out({ type: "assistant", message: { content: [{ type: "text", text: auth.email }] } });
    out({ type: "result", subtype: "success", result: auth.email, session_id: auth.email, usage: {} });
  });
}
`;

let scratch: string;
let cli: string;
const instances: ProviderInstance[] = [];

function account(name: string, auth: unknown = { loggedIn: true, email: `${name}@example.test`, orgName: `${name} team` }) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture-auth.json"), JSON.stringify(auth));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ customModels: [`${name}-model`] }));
  return dir;
}

async function create(company?: { configDir: string }, environment: Record<string, string> = {}) {
  const instance = await ClaudeDriver.create({
    instanceId: `claude-${instances.length}`,
    displayName: "Fixture Claude",
    enabled: true,
    config: { cli, permissionMode: "acceptEdits", ...(company ? { managed: true, configDir: company.configDir } : {}) },
    environment,
  });
  instances.push(instance);
  return instance;
}

function calls(dir: string): Array<{ args: string[]; configDir: string; home: string; env: NodeJS.ProcessEnv }> {
  return readFileSync(join(dir, "calls.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-claude-config-dir-"));
  cli = join(scratch, "fake-claude.mjs");
  writeFileSync(cli, FAKE_CLI, { mode: 0o755 });
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  for (const key of CLAUDE_AUTH_ENV_KEYS) vi.stubEnv(key, `fixture-parent-${key}`);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline fixture", { status: 503 })));
});

afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.dispose()));
  await removeTempDir(scratch);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Claude configuration directory", () => {
  it("is the computer's Claude login, and a directory of its own only for company models", () => {
    const home = join(scratch, "home");
    expect(ClaudeDriver.decodeConfig({ configDir: "/data/providers/claude-account" })).toEqual(ClaudeDriver.defaultConfig());
    expect(ClaudeDriver.decodeConfig({ configDir: 12 })).toEqual(ClaudeDriver.defaultConfig());
    expect(ClaudeDriver.decodeConfig({ managed: true, configDir: " " })).toEqual({ ...ClaudeDriver.defaultConfig(), managed: true });
    expect(ClaudeDriver.decodeConfig({ managed: true, configDir: " ~/company " }).configDir).toBe("~/company");
    expect(resolveClaudeConfigDir("~/work", { HOME: home })).toBe(join(home, "work"));
    expect(resolveClaudeConfigDir("~", { USERPROFILE: home })).toBe(home);
    expect(resolveClaudeConfigDir(undefined, { HOME: home })).toBe(join(home, ".claude"));
    expect(resolveClaudeConfigDir("", { HOME: home, CLAUDE_CONFIG_DIR: "~/inherited" })).toBe(join(home, "inherited"));
    expect(resolveClaudeConfigDir(join(scratch, "explicit"), { CLAUDE_CONFIG_DIR: join(scratch, "ignored") })).toBe(join(scratch, "explicit"));
    for (const configDir of [12, null, "relative/path", "~other/work", "/bad\npath"]) {
      expect(() => ClaudeDriver.decodeConfig({ managed: true, configDir })).toThrow(/configDir/);
    }
  });

  it("honors the computer's CLAUDE_CONFIG_DIR", async () => {
    const dir = account("existing");
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    const provider = await create();
    expect(provider.models.options.some(option => option.id === "existing-model")).toBe(true);
    expect(await provider.generateText?.("fixture review")).toBe("existing@example.test");
    expect(calls(dir)[0]?.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-parent-ANTHROPIC_AUTH_TOKEN");
    expect(calls(dir)[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps company models in their own directory, without the computer's login", async () => {
    const dir = account("company");
    vi.stubEnv("CLAUDE_CONFIG_DIR", account("parent"));
    const provider = await create({ configDir: dir }, { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999", ANTHROPIC_API_KEY: "fixture-company-key" });
    await provider.snapshot();
    expect(calls(dir).length).toBeGreaterThan(0);
    for (const call of calls(dir)) {
      expect(call.configDir).toBe(dir);
      expect(call.env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9999", ANTHROPIC_API_KEY: "fixture-company-key" });
    }
  });

  it("publishes only bounded display identity from a successful auth status", async () => {
    const dir = account("identity", {
      loggedIn: true, email: " person@example.test ", orgName: " Team ",
      accessToken: "must-not-appear", refreshToken: "must-not-appear", extra: { secret: "must-not-appear" },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    const provider = await create();
    expect(await provider.snapshot()).toEqual({
      state: "available", version: "fixture-claude", authenticated: true,
      account: { email: "person@example.test", organization: "Team" }, billing: "subscription",
    });
    for (const auth of [
      { loggedIn: false, email: "person@example.test", orgName: "Team" },
      { loggedIn: true, email: "not an email", orgName: { secret: "no" } },
      { loggedIn: true, email: "a".repeat(255) + "@example.test", orgName: "a".repeat(161) },
      { loggedIn: true, email: "person\n@example.test", orgName: "hidden\u202ename" },
    ]) {
      writeFileSync(join(dir, "fixture-auth.json"), JSON.stringify(auth));
      expect(await provider.snapshot()).not.toHaveProperty("account");
    }
  });
});
