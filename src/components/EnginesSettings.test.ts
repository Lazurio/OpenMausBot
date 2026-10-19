import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
afterEach(() => vi.unstubAllGlobals());

describe("Settings → Engines → Grok", () => {
  function renderGrok(authenticated: boolean): string {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.instances = [{
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", cliDefault: "grok",
      snapshot: { state: "available", authenticated, version: "grok 1.0.41" },
      models: { default: "grok-4.7", options: [] },
      install: { command: { linux: "curl -fsSL https://x.ai/cli/install.sh | bash" }, signInCommand: "grok login" },
    }];
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings));
  }

  it("signs in with Grok's own command on this computer, never an in-app code", () => {
    const html = renderGrok(false);
    expect(html).toContain("grok login");
    expect(html).not.toContain("data-device-sign-in");
    expect(html).toContain("Finish signing in to your account in Terminal");
  });
});

describe("Settings → Engines → setup cards", () => {
  it.each([true, false])("offers no way to add an account to any engine (authenticated: %s)", (authenticated) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [
      { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", cliDefault: "claude", snapshot: { state: "available", authenticated }, models: { default: "sonnet", options: [] } },
      { instanceId: "codex", driverKind: "codex", displayName: "Codex", cliDefault: "codex", snapshot: { state: "available", authenticated }, models: { default: "gpt", options: [] } },
    ];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).not.toMatch(/Add another|Add Google account|data-accounts/);
    expect(html.match(/data-engine-card=/g)).toHaveLength(2);
  });

  it("shows every Company provider as read-only while preserving personal controls", () => {
    vi.stubGlobal("window", {});
    fixture.bots = [];
    fixture.instances = ["claudeAgent", "codex", "openai-compat"].map((driverKind) => ({
      instanceId: `company.fixture.${driverKind}`, displayName: `Company ${driverKind}`, driverKind, readOnly: true,
      snapshot: { state: "available", authenticated: true }, models: { default: "model", options: [] },
    }));
    const companyOnly = renderToStaticMarkup(createElement(EnginesSettings));
    for (const driver of ["claudeAgent", "codex", "openai-compat"]) expect(companyOnly).toContain(`Company ${driver}`);
    expect(companyOnly).toContain("managed by your organization");
    for (const control of ["Set CLI", "CLI path and updates", "Sign out of ChatGPT", "Update Claude", "fixture login", "Add another Claude account", "Add another ChatGPT account"]) expect(companyOnly).not.toContain(control);
    fixture.instances.push({ instanceId: "personal", displayName: "Personal Claude", driverKind: "claudeAgent", cliDefault: "claude",
      snapshot: { state: "available" }, models: { default: "sonnet", options: [] } });
    const withPersonal = renderToStaticMarkup(createElement(EnginesSettings));
    expect(withPersonal).toContain("Set CLI"); expect(withPersonal).toContain("CLI path and updates"); expect(withPersonal).toContain("Update Claude");
  });

  it("preserves one-click server installs and updates inside engine cards", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "kimi", displayName: "Kimi", driverKind: "kimiAgent", cliDefault: "kimi",
      snapshot: { state: "unavailable" }, models: { default: "model", options: [] },
      install: { server: { package: "kimi-fixture" }, command: { linux: "npm install -g kimi-fixture" } },
    }];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain("Install Kimi here");
    fixture.instances[0].snapshot = {
      state: "available", authenticated: true,
      update: { title: "Kimi update available", message: "A newer version is available.", command: "npm install -g kimi-fixture@latest" },
    };
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("Update Kimi here");
    expect(html).not.toContain("Install Kimi here");
  });

  it("shows a standing warning from the snapshot without a command to run", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", cliDefault: "claude",
      snapshot: {
        state: "available", authenticated: true,
        warning: { title: "Bots inherit this machine's Claude Code setup", message: "OMB_CLAUDE_INHERIT_USER_CONFIG=1 is set." },
      },
      models: { default: "model", options: [] },
    }];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("data-engine-warning-notice");
    expect(html).toContain("Bots inherit this machine&#x27;s Claude Code setup");
    expect(html).toContain("OMB_CLAUDE_INHERIT_USER_CONFIG=1 is set.");
    expect(html).not.toContain("data-engine-update-notice");
    delete fixture.instances[0].snapshot.warning;
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("data-engine-warning-notice");
  });

  it("keeps an API-key engine listed after its key is saved and links to changing the key", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    const openai = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      instanceId: "openai", displayName: "OpenAI", driverKind: "openai-compat", access: "api",
      snapshot, models: { default: "gpt-5", options: [] },
    });
    fixture.instances = [openai({ state: "unavailable", reason: "No API key" })];
    const before = renderToStaticMarkup(createElement(EnginesSettings));
    expect(before).toContain("OpenAI needs an API key");
    expect(before).toContain("Open API keys");
    expect(before).not.toContain("Change key");

    fixture.instances = [openai({ state: "available", authenticated: true, version: null })];
    const saved = renderToStaticMarkup(createElement(EnginesSettings));
    expect(saved).toContain('data-engine-card="openai"');
    expect(saved).toContain('data-engine-setup-api-key="configured"');
    expect(saved).toContain("OpenAI uses your API key");
    expect(saved).toContain("Change key");
    expect(saved).not.toContain("OpenAI needs an API key");

    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const remote = renderToStaticMarkup(createElement(EnginesSettings));
    expect(remote).toContain("open Settings → API keys on the computer running OpenMausBot");
    expect(remote).not.toContain("Change key");

    vi.stubGlobal("window", {});
    fixture.instances = [{ ...openai({ state: "available", authenticated: true, version: null }), managed: { organizationId: "org", organizationName: "Acme" } }];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("Change key");
  });
});

describe("Settings → Engines → Claude", () => {
  const claude = (authenticated?: boolean, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", cliDefault: "claude", access: "subscription",
    snapshot: { state: "available", authenticated, ...(authenticated ? { account: { email: "personal@example.test" } } : {}) },
    models: { default: "sonnet", options: [] }, install: { signInCommand: "claude auth login" },
    ...extra,
  });
  function renderClaude(...instances: InstanceInfo[]) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.instances = instances;
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings));
  }

  it.each([true, false, undefined])("is one engine on the computer's Claude login, with no accounts to add, name or remove (authenticated: %s)", (authenticated) => {
    const html = renderClaude(claude(authenticated));
    expect(html.match(/data-engine-card=/g)).toHaveLength(1);
    expect(html).toContain('data-engine-card="claude"');
    for (const gone of ["data-accounts", "data-account=", "Add another Claude account", "Options for Claude", "Use an existing Claude folder"]) expect(html).not.toContain(gone);
  });

  it("shows Claude Code's setup while it is missing", () => {
    const html = renderClaude(claude(undefined, { snapshot: { state: "unavailable", reason: "`claude` CLI not found" } }));
    expect(html).not.toContain("data-accounts");
    expect(html).toContain("CLI not found");
    expect(html).toContain("Needs setup");
  });
});

describe("Settings → AI in Simple mode", () => {
  const engine = (instanceId: string, driverKind: string, authenticated: boolean, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId, driverKind, displayName: instanceId, cliDefault: instanceId,
    snapshot: { state: "available", authenticated }, models: { default: "model", options: [] }, ...extra,
  });
  const simple = (open = false) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings, { simple: true, more: { id: "ai-more", open, onToggle: () => {} } }));
  };
  const rows = (html: string) => [...html.matchAll(/data-simple-engine="([^"]+)"/g)].map((match) => match[1]);

  it("lists each ready provider, and each one the Environment settings sign in, as a row with Manage or Set up", () => {
    fixture.instances = [
      engine("claude", "claudeAgent", true),
      engine("codex", "codex", false),
      engine("kimi", "kimiAgent", false),
    ];
    const html = simple();
    expect(html).toContain(">Your AI</h3>");
    expect(rows(html)).toEqual(["claude", "codex"]);
    expect(html).toMatch(/data-simple-engine="claude"[\s\S]*?>Manage<\/button>/);
    expect(html).toMatch(/data-simple-engine="codex"[\s\S]*?>Set up<\/button>/);
    expect(html).not.toContain("Model providers and accounts");
  });

  it("folds every other provider under More AI providers, with the count", () => {
    fixture.instances = [engine("claude", "claudeAgent", true), engine("kimi", "kimiAgent", false), engine("mistral", "mistral", false)];
    expect(simple()).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?More AI providers \(2\)/);
    expect(simple(true)).toContain('data-engine-card="kimi"');
  });
});
