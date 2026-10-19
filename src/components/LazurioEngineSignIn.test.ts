import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineSetup } from "./EngineSetup";
import { forgetLazurioSignIn, lazurioSignInOf, loadLazurioSignIn, signedOutHeadline } from "./LazurioEngineSignIn";
import { StoreProvider, type InstanceInfo } from "@/state/store";

const LAUNCHPAD = "https://launchpad.vm-01.example.lazurio.io/";
const SETTINGS = "https://launchpad.vm-01.example.lazurio.io/settings/start";

  return {
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "vm-01.example",
    operator: { initials: null, login: null, avatar: null },
    environments: [{
      id: "vm-01.example", label: null, kind: "team", organizations: ["example"], assignee: null,
    }],
    organizations: [],
    dashboard: "https://dashboard.lazurio.io/",
    account: "https://dashboard.lazurio.io/account",
    addOrganization: null,
    ...overrides,
  };
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

  vi.stubGlobal("window", { ogb: { platform: "linux" } });
  vi.stubGlobal("document", { documentElement: { dataset: shell ? { lazurioTheme: "light" } : {} } });
}

function render(instance: InstanceInfo): string {
  return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance })));
}

beforeEach(() => forgetLazurioSignIn());
afterEach(() => vi.unstubAllGlobals());

describe("the shell's document", () => {
  });

  });

  it("is read once, from this origin", async () => {
    page({ shell: true });
    vi.stubGlobal("fetch", fetch);
    await loadLazurioSignIn();
    await loadLazurioSignIn();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/.lazurio/shell.json", { credentials: "same-origin", cache: "no-store" });
  });
});

  for (const instance of [codex, claude]) {
    it(`${instance.displayName}: links to the Environment settings and shows no terminal command`, async () => {
      page({ shell: true });
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
    const markup = render(codex);
    expect(markup).toContain("Open Environment settings");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain("codex login");
  });

    page({ shell: true });
    const markup = render(codex);
    expect(markup).toContain("Nastavení Prostředí");
    expect(markup).toContain("Zkontrolovat znovu");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("codex login");
  });

  it("names the account in the chat's error line too", async () => {
    page({ shell: true });
  });
});

describe("outside Lazurio", () => {
  it("keeps upstream's card with the engine's own sign-in command", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await loadLazurioSignIn();
    const markup = render(codex);
    expect(fetch).not.toHaveBeenCalled();
    expect(markup).not.toContain("data-lazurio-engine-sign-in");
    expect(markup).toContain("Finish signing in to your account in Terminal");
    expect(markup).toContain("codex login");
  });
});