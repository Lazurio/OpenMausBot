import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  config: null as unknown,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config ?? original.initialState.config }, dispatch: fixture.dispatch }) };
});

// DesktopCapabilities reads window.ogb at module scope, and this suite runs in the node environment.
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined } } }),
}));

const { AccessSection } = await import("./AccessSection");

// WorkingFolder reads window.ogb?.pickFolder at render time, so window is stubbed per test.
beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.dispatch.mockReset();
  fixture.config = null;
});
afterEach(() => vi.unstubAllGlobals());

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    title: "Scout",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function makeDerived(overrides: Partial<ReturnType<typeof useBotSettingsDerived>> = {}): ReturnType<typeof useBotSettingsDerived> {
  return {
    patch: vi.fn(),
    engine: undefined,
    canCoordinate: false,
    sectionName: "General",
    currentChief: undefined,
    botRoutines: [],
    activeBotRoutines: 0,
    localSelectable: false,
    localDisabledReason: null,
    activeState: "idle",
    mascotMotion: null,
    ...overrides,
  } as ReturnType<typeof useBotSettingsDerived>;
}

function render(bot: Bot, derived = makeDerived()) {
  return renderToStaticMarkup(
    createElement(StoreProvider, null, createElement(AccessSection, { bot, derived })),
  );
}

describe("AccessSection always-allowed list", () => {
  it("shows a placeholder when nothing is standing yet", () => {
    const markup = render(makeBot());
    expect(markup).toContain("Nothing standing yet.");
  });

  it("lists each always-allowed entry with a Remove button", () => {
    const markup = render(makeBot({ alwaysAllow: ["shell.run", "fs.write"] }));
    expect(markup).toContain("shell.run");
    expect(markup).toContain("fs.write");
    expect(markup).toContain('aria-label="Remove shell.run from always allowed"');
    expect(markup).toContain('aria-label="Remove fs.write from always allowed"');
    expect(markup).not.toContain("Nothing standing yet.");
  });
});

describe("AccessSection without Works on", () => {
  it("offers no choice of computer: every bot works on this one", () => {
    const markup = render(makeBot());
    expect(markup).not.toContain("Where Scout works");
    expect(markup).not.toContain("Cloud backend");
    expect(markup).not.toContain("Open Computer panel");
  });
});

describe("AccessSection parts", () => {
  it("renders only the cards a page asks for, and every card without parts", () => {
    const full = render(makeBot());
    for (const text of ["Working folder", "Webhooks", "Always allowed"]) {
      expect(full).toContain(text);
    }
    for (const text of ["Browser", "browser"]) expect(full).not.toContain(text);
    expect(full).not.toContain("Connected apps");
    expect(full).not.toContain("MCP servers");
    const folder = renderToStaticMarkup(createElement(StoreProvider, null, createElement(AccessSection, { bot: makeBot(), derived: makeDerived(), parts: ["folder"] })));
    expect(folder).toContain("Working folder");
    for (const text of ["Webhooks", "Always allowed"]) expect(folder).not.toContain(text);
  });
});
