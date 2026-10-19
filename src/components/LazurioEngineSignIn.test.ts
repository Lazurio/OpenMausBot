// Lazurio overlay (DEV-6673): on a Lazurio Environment a signed-out Codex or Claude card sends the
// person to the Environment settings of this Environment's Launchpad, where the Environment's own CLI
// is signed in, as Lazurio's T3 Code does; it shows no terminal command and starts no sign-in. The
// link is shown only for exactly this Environment's Launchpad. Engines the Launchpad cannot sign in,
// and everything outside Lazurio, keep upstream's card.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineSetup } from "./EngineSetup";
import { forgetLazurioSignIn, lazurioSignInOf, loadLazurioSignIn, signedOutHeadline } from "./LazurioEngineSignIn";
import { StoreProvider, type InstanceInfo } from "@/state/store";

const PAGE = "https://mausbot.vm-01.example.lazurio.io";
const LAUNCHPAD = "https://launchpad.vm-01.example.lazurio.io/";
const SETTINGS = "https://launchpad.vm-01.example.lazurio.io/settings/start";
const SHELL_URL = `${PAGE}/.lazurio/shell.json`;

function shellDocument(overrides: Record<string, unknown> = {}, apps: unknown = LAUNCHPAD) {
  return {
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "vm-01.example",
    operator: { initials: null, login: null, avatar: null },
    environments: [{
      id: "vm-01.example", label: null, kind: "team", organizations: ["example"], assignee: null,
      apps: { apps, chat: "https://t3code.vm-01.example.lazurio.io/", automate: `${PAGE}/` },
    }],
    organizations: [],
    dashboard: "https://dashboard.lazurio.io/",
    account: "https://dashboard.lazurio.io/account",
    addOrganization: null,
    ...overrides,
  };
}

/** What fetch answers: the document, from `url`, redirected or not. */
function answer(body: unknown, { url = SHELL_URL, redirected = false, ok = true } = {}) {
  return { ok, url, redirected, json: async () => body };
}

const codex: InstanceInfo = {
  instanceId: "codex",
  driverKind: "codex",
  displayName: "Codex",
  models: { default: "gpt-5", options: [] },
  snapshot: { state: "available", authenticated: false, version: "0.159.0" },
  install: { command: { linux: "npm install -g @openai/codex" }, signInCommand: "codex login", docsUrl: "https://github.com/openai/codex" },
};
const claude: InstanceInfo = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  models: { default: "claude-opus", options: [] },
  snapshot: { state: "available", authenticated: false, version: "2.1.0" },
  install: { command: { linux: "npm install -g @anthropic-ai/claude-code" }, signInCommand: "claude", docsUrl: "https://docs.claude.com" },
};
const cursor: InstanceInfo = {
  instanceId: "cursor",
  driverKind: "cursorAgent",
  displayName: "Cursor",
  models: { default: "auto", options: [] },
  snapshot: { state: "available", authenticated: false, version: "2026.10.01" },
  install: { command: { linux: "curl https://cursor.com/install -fsS | bash" }, signInCommand: "cursor-agent login", docsUrl: "https://cursor.com/cli" },
};

/** One page load on MausBot's origin: the shell marks its tokens on <html> when it ran (interface v1 `declares.theme`). */
function page({ shell, origin = PAGE }: { shell: boolean; origin?: string }) {
  vi.stubGlobal("window", { ogb: { platform: "linux" } });
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("document", { documentElement: { dataset: shell ? { lazurioTheme: "light" } : {} } });
}

async function loaded(response: ReturnType<typeof answer>) {
  vi.stubGlobal("fetch", async () => response);
  await loadLazurioSignIn();
}

function render(instance: InstanceInfo): string {
  return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance })));
}

beforeEach(() => forgetLazurioSignIn());
afterEach(() => vi.unstubAllGlobals());

describe("the shell's document", () => {
  it("points to Getting started of this Environment's Launchpad, in the person's language", () => {
    expect(lazurioSignInOf(shellDocument(), PAGE)).toEqual({ settingsUrl: SETTINGS, czech: true });
    expect(lazurioSignInOf(shellDocument({ locale: "en" }), PAGE)).toEqual({ settingsUrl: SETTINGS, czech: false });
    expect(lazurioSignInOf(shellDocument({}, LAUNCHPAD.slice(0, -1)), PAGE).settingsUrl).toBe(SETTINGS);
  });

  it("links nowhere but this Environment's own Launchpad", () => {
    for (const apps of [
      "https://unrelated.example/",
      "https://launchpad.vm-02.example.lazurio.io/",
      "https://launchpad.vm-01.example.lazurio.io.evil.example/",
      "https://launchpad.vm-01.example.lazurio.io:8443/",
      "https://launchpad.vm-01.example.lazurio.io/other/",
      "http://launchpad.vm-01.example.lazurio.io/",
      "/",
      42,
    ]) expect(lazurioSignInOf(shellDocument({}, apps), PAGE).settingsUrl, String(apps)).toBeNull();
  });

  it("gives no link when the document's current Environment is not this page's", () => {
    expect(lazurioSignInOf(shellDocument({ current: "vm-02.example" }), PAGE).settingsUrl).toBeNull();
    expect(lazurioSignInOf(shellDocument({ current: null }), PAGE).settingsUrl).toBeNull();
    expect(lazurioSignInOf(shellDocument(), "https://mausbot.vm-02.example.lazurio.io").settingsUrl).toBeNull();
    expect(lazurioSignInOf(shellDocument(), "https://openmausbot.example").settingsUrl).toBeNull();
  });

  it("gives no link for anything but lazurio.shell.v1", () => {
    expect(lazurioSignInOf("<!doctype html>", PAGE)).toEqual({ settingsUrl: null, czech: true });
    expect(lazurioSignInOf({ ...shellDocument(), schema: "lazurio.shell.v2" }, PAGE).settingsUrl).toBeNull();
  });

  it("is read once, from this origin", async () => {
    page({ shell: true });
    const fetch = vi.fn(async () => answer(shellDocument()));
    vi.stubGlobal("fetch", fetch);
    await loadLazurioSignIn();
    await loadLazurioSignIn();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/.lazurio/shell.json", { credentials: "same-origin", cache: "no-store" });
  });
});

describe("a signed-out Codex or Claude on a Lazurio Environment", () => {
  for (const instance of [codex, claude]) {
    it(`${instance.displayName}: links to the Environment settings and shows no terminal command`, async () => {
      page({ shell: true });
      await loaded(answer(shellDocument()));
      const markup = render(instance);
      expect(markup).toContain("data-lazurio-engine-sign-in");
      expect(markup).toContain(`href="${SETTINGS}"`);
      expect(markup).toContain('target="_blank"');
      expect(markup).toContain("Otevřít Nastavení Prostředí");
      expect(markup).toContain("Zkontrolovat znovu");
      expect(markup).not.toContain(instance.install!.signInCommand!);
      expect(markup).not.toMatch(/<code|Copy command|Terminal|View setup guide/);
    });
  }

  it("speaks English where the person's profile does", async () => {
    page({ shell: true });
    await loaded(answer(shellDocument({ locale: "en" })));
    const markup = render(codex);
    expect(markup).toContain("Open Environment settings");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain("codex login");
  });

  it("still says where to connect it, without a link, while the shell's document is unreadable", async () => {
    page({ shell: true });
    await loaded(answer("not found", { ok: false }));
    const markup = render(codex);
    expect(markup).toContain("Nastavení Prostředí");
    expect(markup).toContain("Zkontrolovat znovu");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("codex login");
  });

  for (const [what, response] of [
    ["a foreign Launchpad origin", answer(shellDocument({}, "https://unrelated.example/"))],
    ["a mismatched current Environment", answer(shellDocument({ current: "vm-02.example" }))],
    ["a redirected shell response", answer(shellDocument(), { redirected: true, url: "https://unrelated.example/.lazurio/shell.json" })],
    ["a response from another origin", answer(shellDocument(), { url: "https://unrelated.example/.lazurio/shell.json" })],
  ] as const) {
    it(`renders the card without a link for ${what}`, async () => {
      page({ shell: true });
      await loaded(response);
      const markup = render(claude);
      expect(markup).toContain("data-lazurio-engine-sign-in");
      expect(markup).not.toContain("<a ");
      expect(markup).not.toContain("unrelated.example");
      expect(markup).toContain("Zkontrolovat znovu");
    });
  }

  it("names the account in the chat's error line too", async () => {
    page({ shell: true });
    await loaded(answer(shellDocument()));
    expect(signedOutHeadline(codex)).toBe("Účet pro Codex zatím není připojený. Připojte ho v Nastavení Prostředí a zprávu pošlete znovu.");
  });
});

describe("an engine the Launchpad cannot sign in", () => {
  it("keeps upstream's card with its own CLI command on a Lazurio Environment (Cursor)", async () => {
    page({ shell: true });
    await loaded(answer(shellDocument()));
    const markup = render(cursor);
    expect(markup).not.toContain("data-lazurio-engine-sign-in");
    expect(markup).not.toContain("Nastavení Prostředí");
    expect(markup).toContain("Finish signing in to your account in Terminal");
    expect(markup).toContain("cursor-agent login");
    expect(signedOutHeadline(cursor)).toBeNull();
  });
});

describe("outside Lazurio", () => {
  it("keeps upstream's card with the engine's own sign-in command", async () => {
    page({ shell: false, origin: "http://127.0.0.1:4317" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await loadLazurioSignIn();
    const markup = render(codex);
    expect(fetch).not.toHaveBeenCalled();
    expect(markup).not.toContain("data-lazurio-engine-sign-in");
    expect(markup).toContain("Finish signing in to your account in Terminal");
    expect(markup).toContain("codex login");
    expect(signedOutHeadline(codex)).toBeNull();
  });
});
