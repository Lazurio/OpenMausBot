import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type ConfigStatus } from "@/state/store";
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
    canUseBrowser: false,
    desktopBrowser: false,
    browserBlockedOnWindows: false,
    browserFeature: true,
    browserAllowed: true,
    browserEnabled: false,
    browserSelectable: false,
    browserDisabledReason: "The built-in browser needs the OpenMausBot desktop app",
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
  });
});

describe("AccessSection Record browser steps", () => {
  type Node = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
  const nodes = (value: ReactNode): Node[] => {
    if (!isValidElement(value)) return [];
    const node = value as Node;
    return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
  };
  const browserOn = () => makeDerived({ browserEnabled: true, desktopBrowser: true, canUseBrowser: true });

  it("asks for the browser first, then says what it saves and for how long, with no prompt", () => {
    expect(render(makeBot())).toContain("Turn on the browser first.");
    expect(render(makeBot(), browserOn())).toContain("Browser steps are not saved.");
    const on = render(makeBot({ recordBrowserSteps: true }), browserOn());
    expect(on).toContain("Saves a screenshot and a short note of each click, typing and page change");
    expect(on).toContain("Kept with this conversation for 30 days.");
    expect(on).toContain('aria-label="Record browser steps"');
  });

  it("turns it on with one bot patch", () => {
    const derived = browserOn();
    let tree!: ReturnType<typeof AccessSection>;
    function Capture() { tree = AccessSection({ bot: makeBot(), derived }); return tree; }
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
    const row = nodes(tree).find((node) => typeof node.props.onChange === "function" && "browserOn" in node.props)!;
    (row.props.onChange as (on: boolean) => void)(true);
    expect(derived.patch).toHaveBeenCalledWith({ recordBrowserSteps: true });
  });

  it("says the screenshots show the person's own Chrome when the bot uses it", () => {
    fixture.config = { browserEngine: { myChrome: true }, browserProfiles: [{ id: "mine", browser: "chrome" }] } as unknown as Partial<ConfigStatus>;
    expect(render(makeBot({ recordBrowserSteps: true, browserProfile: "mine" }), browserOn())).toContain("This bot uses your own Chrome, so the screenshots show your Chrome.");
    expect(render(makeBot({ recordBrowserSteps: true }), browserOn())).not.toContain("your own Chrome");
  });
});

    expect(markup).not.toContain("Where Scout works");
    expect(markup).not.toContain("Cloud backend");
    expect(markup).not.toContain("Open the Screen panel");
  });
});

describe("AccessSection parts", () => {
  it("renders only the cards a page asks for, and every card without parts", () => {
    const full = render(makeBot());
      expect(full).toContain(text);
    }
    expect(full).not.toContain("Connected apps");
    expect(full).not.toContain("MCP servers");
    const folder = renderToStaticMarkup(createElement(StoreProvider, null, createElement(AccessSection, { bot: makeBot(), derived: makeDerived(), parts: ["folder"] })));
    expect(folder).toContain("Working folder");
    for (const text of ["Webhooks", "Always allowed"]) expect(folder).not.toContain(text);
  });
});
