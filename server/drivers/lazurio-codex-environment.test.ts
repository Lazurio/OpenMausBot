// Lazurio: Codex follows the Environment's Codex configuration, as Lazurio's T3 Code does. The fixture is
// the system layer Lazurio Machines write on a work Environment with an AI gateway (try-01 of the public
// Organization): provider lazurio-ai-pool, requires_openai_auth false, model gpt-6-luna, no ChatGPT login.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { selectDefaultModelSelection, type SelectableInstance } from "../default-model-selection.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { codexNotSignedIn } from "./codex-errors.ts";
import { codexEnvironmentCatalog, codexEnvironmentProvider } from "./lazurio-codex-environment.ts";

vi.mock("./codex-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-release.ts")>(),
  readLatestCodexRelease: async () => "0.156.1",
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

const TRY01_LAYER = { layer: "system", model_provider: "lazurio-ai-pool", model: "gpt-6-luna", requires_openai_auth: false };
// A local provider in the person's own ~/.codex/config.toml, as codex-cli 0.163.0 reports it.
const OMLX_LAYER = { layer: "user", model_provider: "omlx", model: "qwen3", requires_openai_auth: false };

// config/read and account/read as codex-cli 0.163.0 answered them (macOS, 2026-10-21).
const origin = (type: string, extra: Record<string, unknown> = {}) => ({ name: { type, ...extra }, version: "sha256:fixture" });
const configRead = (provider: unknown, layer: Record<string, unknown> | undefined, model: unknown = "gpt-6-luna") => ({
  config: { model, model_provider: provider },
  origins: layer ? { model_provider: layer, model: layer } : {},
  layers: null,
});
const SYSTEM = origin("system", { file: "/etc/codex/config.toml" });
const ready = { account: null, requiresOpenaiAuth: false, workspaceRouting: null };

describe("the Environment's Codex provider", () => {
  it("is the system layer's provider when it needs no OpenAI sign-in, with the configured model", () => {
    expect(codexEnvironmentProvider(configRead("lazurio-ai-pool", SYSTEM), ready))
      .toEqual({ provider: "lazurio-ai-pool", model: "gpt-6-luna" });
    expect(codexEnvironmentProvider(configRead("lazurio-ai-pool", SYSTEM, null), ready))
      .toEqual({ provider: "lazurio-ai-pool", model: null });
    expect(codexEnvironmentProvider(configRead("lazurio-ai-pool", SYSTEM, "gpt luna\n"), ready))
      .toEqual({ provider: "lazurio-ai-pool", model: null });
  });

  it.each([
    ["the person's own config.toml", origin("user", { file: "/home/ada/.codex/config.toml", profile: null })],
    ["a project's .codex", origin("project", { dotCodexFolder: "/work/.codex" })],
    ["a -c flag", origin("sessionFlags")],
    ["an MDM layer", origin("mdm", { domain: "com.openai.codex", key: "config" })],
    ["packaged defaults", origin("packagedDefaults", { file: "/opt/codex/defaults.toml" })],
    ["no origin", undefined],
  ])("is not set from %s", (_name, layer) => {
    expect(codexEnvironmentProvider(configRead("omlx", layer), ready)).toBeNull();
  });

  it("is not set for openai, an unset provider, an OpenAI sign-in requirement or an unreadable answer", () => {
    expect(codexEnvironmentProvider(configRead("openai", SYSTEM), ready)).toBeNull();
    expect(codexEnvironmentProvider(configRead(null, undefined), ready)).toBeNull();
    expect(codexEnvironmentProvider(configRead("lazurio-ai-pool", SYSTEM), { account: null, requiresOpenaiAuth: true })).toBeNull();
    expect(codexEnvironmentProvider(configRead("lazurio-ai-pool", SYSTEM), undefined)).toBeNull();
    expect(codexEnvironmentProvider(undefined, ready)).toBeNull();
    expect(codexEnvironmentProvider({ config: "x", origins: [] }, ready)).toBeNull();
    expect(codexEnvironmentProvider(configRead("bad provider", SYSTEM), ready)).toBeNull();
  });

  it("makes the configured model the catalog's default and lists it", () => {
    const catalog = { default: "gpt-6.1-sol", options: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-6-luna", label: "GPT-6 Luna" }] };
    expect(codexEnvironmentCatalog(catalog, { provider: "lazurio-ai-pool", model: "gpt-6-luna" })).toEqual({ ...catalog, default: "gpt-6-luna" });
    expect(codexEnvironmentCatalog(catalog, { provider: "lazurio-ai-pool", model: "pool-model" }).options[0]).toEqual({ id: "pool-model", label: "pool-model" });
    expect(codexEnvironmentCatalog(catalog, { provider: "lazurio-ai-pool", model: null })).toBe(catalog);
    expect(codexEnvironmentCatalog(catalog, null)).toBe(catalog);
  });
});

describe("the Codex engine on an Environment's Codex configuration (fake app-server)", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  const create = async (knobs: Record<string, string>, signedIn = false) => {
    const codexHome = join(scratch, ".codex");
    mkdirSync(codexHome, { recursive: true });
    if (signedIn) writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { refresh_token: "synthetic-fixture" } }));
    instance = await CodexDriver.create({
      instanceId: `codex-env-${Math.random().toString(36).slice(2)}`,
      displayName: "Codex",
      environment: { HOME: scratch, USERPROFILE: scratch, CODEX_HOME: codexHome, FAKE_CODEX_DUMP: join(scratch, "dump.json"),
        FAKE_CODEX_TEXT_LOG: join(scratch, "exec.jsonl"), ...knobs },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return instance;
  };
  const dump = () => JSON.parse(readFileSync(join(scratch, "dump.json"), "utf8")) as { calls: Array<{ method: string; params: any }> };
  const call = (method: string) => dump().calls.find((entry) => entry.method === method);
  const turn = async (threadId: string, model: string | undefined, extra: Record<string, unknown> = {}) => {
    const { turnId } = await instance!.adapter.sendTurn({ threadId, text: "hi", ...(model ? { model } : {}), ...extra });
    const done = await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return { done, errors: recorder!.events.filter((event) => event.type === "runtime.error" && event.turnId === turnId) };
  };
  const oneShotArgv = async () => {
    await instance!.generateMemoryText!("hello");
    const log = join(scratch, "exec.jsonl");
    expect(existsSync(log)).toBe(true);
    return (JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!) as { argv: string[] }).argv;
  };
  const claudeSignedOut: SelectableInstance = {
    instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false },
    models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] },
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-environment-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  describe("try-01's system layer, without a ChatGPT login", () => {
    const knobs = { FAKE_CODEX_MODE: "logged-out", FAKE_CODEX_LUNA: "1", FAKE_CODEX_PROVIDER_LAYER: JSON.stringify(TRY01_LAYER) };

    it("is ready, defaults new bots to Codex with gpt-6-luna and names no ChatGPT account", async () => {
      const codex = await create(knobs);
      const snapshot = await codex.snapshot();
      expect(snapshot).toEqual({ state: "available", version: "codex-cli 0.147.0", authenticated: true,
        update: expect.objectContaining({ title: "Update Codex to 0.156.1" }), billing: "subscription" });
      expect(codex.models.default).toBe("gpt-6-luna");
      const selectable = { instanceId: codex.instanceId, driverKind: "codex", snapshot, models: codex.models };
      expect(selectDefaultModelSelection([claudeSignedOut, selectable])).toEqual({ instanceId: codex.instanceId, model: "gpt-6-luna" });
    });

    it("runs a turn with no sign-in card, and thread/start and thread/resume leave the provider to Codex", async () => {
      await (await create({ ...knobs, FAKE_CODEX_MODE: "resume", FAKE_CODEX_ACCOUNT_MODE: "none" })).snapshot();
      const started = await turn("t-luna", "gpt-6-luna");
      expect(started.errors).toEqual([]);
      expect(started.done).toMatchObject({ ok: true });
      expect(call("thread/start")!.params.model).toBe("gpt-6-luna");
      expect(call("thread/start")!.params).not.toHaveProperty("modelProvider");
      const resumed = await turn("t-luna", "gpt-6-luna", { resumeCursor: "codex-thread-1" });
      expect(resumed.done).toMatchObject({ ok: true });
      expect(call("thread/resume")!.params).toMatchObject({ threadId: "codex-thread-1", model: "gpt-6-luna" });
      expect(call("thread/resume")!.params).not.toHaveProperty("modelProvider");
    });

    it("runs a turn sent while the server's engine check is still reading Codex on that reading", async () => {
      const codex = await create(knobs);
      const checked = codex.snapshot();
      const { done, errors } = await turn("t-first", "gpt-6-luna");
      expect(errors).toEqual([]);
      expect(done).toMatchObject({ ok: true });
      expect(call("thread/start")!.params).not.toHaveProperty("modelProvider");
      await expect(checked).resolves.toMatchObject({ authenticated: true });
    });

    it("asks background one-shots the configured model on Codex's configured provider", async () => {
      await (await create(knobs)).snapshot();
      const argv = await oneShotArgv();
      expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-6-luna");
      expect(argv.some((arg) => arg.startsWith("model_provider="))).toBe(false);
    });
  });

  describe("controls: today's behaviour", () => {
    it("an openai provider with a ChatGPT login: the same snapshot, default, thread/start and one-shot", async () => {
      const codex = await create({}, true);
      expect(await codex.snapshot()).toEqual({ state: "available", version: "codex-cli 0.147.0", authenticated: true,
        account: { email: "ada@example.test" }, update: expect.objectContaining({ title: "Update Codex to 0.156.1" }), billing: "subscription" });
      expect(codex.models.default).toBe("gpt-fake-default");
      const { done } = await turn("t-openai", "gpt-5.6-sol");
      expect(done).toMatchObject({ ok: true });
      expect(dump().calls.map((entry) => entry.method)).toEqual(["initialize", "initialized", "config/read", "thread/start", "turn/start"]);
      expect(call("thread/start")!.params).toEqual({
        developerInstructions: expect.any(String), cwd: expect.any(String), model: "gpt-5.6-sol", modelProvider: "openai",
        approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: false,
      });
      expect(await oneShotArgv()).toContain('model_provider="openai"');
    });

    it("an openai provider without a login: signed out, and a turn gets the sign-in card", async () => {
      const codex = await create({ FAKE_CODEX_MODE: "logged-out" });
      expect(await codex.snapshot()).toMatchObject({ state: "available", authenticated: false });
      const { done, errors } = await turn("t-signed-out", "gpt-5.6-sol");
      expect(errors).toEqual([expect.objectContaining({ message: codexNotSignedIn(), setup: true })]);
      expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    });

    it("an unreadable config/read: the system layer is not trusted and official models stay on openai", async () => {
      const codex = await create({ FAKE_CODEX_MODE: "config-read-error", FAKE_CODEX_PROVIDER_LAYER: JSON.stringify(TRY01_LAYER) }, true);
      expect(await codex.snapshot()).toMatchObject({ authenticated: true, account: { email: "ada@example.test" } });
      expect(codex.models.default).toBe("gpt-fake-default");
      expect(await oneShotArgv()).toContain('model_provider="openai"');
    });

    it("a local provider in ~/.codex/config.toml (oMLX): official models are still forced to openai", async () => {
      const codex = await create({ FAKE_CODEX_PROVIDER_LAYER: JSON.stringify(OMLX_LAYER) }, true);
      expect(await codex.snapshot()).toMatchObject({ authenticated: true, account: { email: "ada@example.test" } });
      await turn("t-omlx", "gpt-5.6-sol");
      expect(call("thread/start")!.params).toMatchObject({ model: "gpt-5.6-sol", modelProvider: "openai" });
      expect(await oneShotArgv()).toContain('model_provider="openai"');
    });
  });
});
