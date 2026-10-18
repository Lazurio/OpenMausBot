import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";

// Hook-by-call-order harness: state survives between renders, effects never run, handlers are read off the element
// tree.
const fixture = vi.hoisted(() => {
  const view = { current: "computer" as string };
  const ogb: Record<string, unknown> = {};
  vi.stubGlobal("window", { ogb });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key.startsWith("omb-computer-panel-view") ? view.current : null, setItem: () => {} });
  return {
    advanced: false,
    view,
    ogb,
    platform: "darwin" as "darwin" | "win32" | "linux",
    values: [] as unknown[],
    index: 0,
    own: 0,
    config: {} as FeatureFlagConfig & { cloudHome?: boolean },
    instances: [] as InstanceInfo[],
    android: false,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    setAdvancedMode: (() => {}) as (enabled: boolean) => void,
    ownerOrAdmin: null as boolean | null,
  };
});

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advanced,
  setAdvancedMode: (enabled: boolean) => fixture.setAdvancedMode(enabled),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: fixture.platform, label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: true, support: "supported", enabled: true, status: "ready" },
    },
  }),
}));
vi.mock("./AndroidDevicePanel", () => ({
  AndroidDevicePanel: () => null,
  useAndroidUsbDevices: () => ({ devices: fixture.android ? [{ serial: "p1" }] : [] }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => createElement("div", null, "BROWSER-PANEL") }));
vi.mock("./LocalScreenPreview", () => ({ LocalScreenPreview: () => null }));
vi.mock("./LinuxLocalControl", () => ({ LinuxLocalControl: () => null }));
vi.mock("./MacLocalControl", () => ({ MacLocalControl: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({
    state: {
      config: fixture.config,
      instances: fixture.instances,
      computerControl: {},
      routines: [],
      routineRuns: [],
    },
    dispatch: fixture.dispatch,
    flushBotPatches: () => Promise.resolve(null),
  }),
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { ComputerFilesPane } = await import("./ComputerFilesPane");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function text(value: ReactNode): string {
  return Children.toArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement(child) ? text((child as Node).props.children) : "";
  }).join("").trim();
}

const engine = (): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo);

function makeBot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
    color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "m" },
    ...patch,
  } as Bot;
}

function render(forBot: Bot) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = ComputerPanel({ bot: forBot });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const buttons = all.filter((node) => node.type === "button");
  const button = (label: string) => buttons.find((node) => text(node.props.children) === label);
  return { html, nodes: all, buttons, button };
}

const tabs = (rendered: ReturnType<typeof render>) => {
  const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
  return nodes(bar.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children));
};
const computerPanel = (rendered: ReturnType<typeof render>) =>
  rendered.nodes.find((node) => node.props.id === "computer-panel-tabs-panel-computer");

beforeEach(() => {
  fixture.advanced = false;
  fixture.view.current = "computer";
  fixture.platform = "darwin";
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.config = { features: { browser: true }, browserEngine: { kind: "engine" } };
  fixture.instances = [engine()];
  fixture.android = false;
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({ features: { browser: true } }));
  fixture.setAdvancedMode = vi.fn();
  fixture.ownerOrAdmin = null;
  for (const key of Object.keys(fixture.ogb)) delete fixture.ogb[key];
});

describe("Computer panel tabs", () => {
  it("centres the tabs as a pill with close pinned right, in both modes", () => {
    for (const advanced of [false, true]) {
      fixture.advanced = advanced;
      fixture.values = [];
      const rendered = render(makeBot());
      const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
      expect(String(bar.props.className).split(" ")).toEqual(expect.arrayContaining(["rounded-full", "mx-9"]));
      expect(String(bar.props.className).split(" ")).not.toContain("flex-wrap");
      const firstTab = Children.toArray(bar.props.children).find(isValidElement) as Node;
      expect(String(firstTab.props.className).split(" ")).toEqual(expect.arrayContaining(["shrink-0", "@max-[28rem]/paneltabs:[&>svg]:hidden"]));
      expect(rendered.nodes.some((node) => String(node.props.className ?? "").split(" ").includes("@container/paneltabs"))).toBe(true);
      const row = rendered.nodes.find((node) => Children.toArray(node.props.children)
        .some((child) => isValidElement(child) && (child as Node).props["data-testid"] === "computer-tabs"))!;
      expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining(["relative", "flex", "justify-center"]));
      const close = rendered.nodes.find((node) => node.props["aria-label"] === "Close computer panel")!;
      expect(String(close.props.className).split(" ")).toEqual(expect.arrayContaining(["absolute", "right-0"]));
    }
  });

  it("shows Computer, Browser, Data and Files in Simple mode", () => {
    fixture.android = true;
    expect(tabs(render(makeBot()))).toEqual(["Computer", "Browser", "Data", "Files"]);
  });

  it("keeps the Advanced tabs unchanged", () => {
    fixture.advanced = true;
    fixture.android = true;
    expect(tabs(render(makeBot()))).toEqual(["Computer", "Routines", "Android", "Browser", "Data"]);
    fixture.config = {};
    fixture.android = false;
    expect(tabs(render(makeBot()))).toEqual(["Computer", "Routines", "Browser", "Data"]);
  });

  it("reads a Routines view stored by Advanced as the Computer tab in Simple", () => {
    fixture.view.current = "routines";
    const rendered = render(makeBot());
    expect(computerPanel(rendered)).toBeDefined();
  });

  it("lists the files this chat changed in the Files tab", () => {
    fixture.view.current = "files";
    const digest = (files: { added?: string[]; changed?: string[]; deleted?: string[] }) => ({
      id: Math.random().toString(36), role: "assistant", kind: "digest", text: "",
      digest: { files: { added: [], changed: [], deleted: [], ...files } },
    }) as unknown as Message;
    const rendered = render(makeBot({ messages: [
      digest({ added: ["/Users/me/work/report.md", "/Users/me/work/old.txt"] }),
      digest({ changed: ["/Users/me/work/notes.md"], deleted: ["/Users/me/work/old.txt"] }),
    ] }));
    expect(rendered.nodes.some((node) => node.type === ComputerFilesPane)).toBe(true);
    expect(rendered.html).toContain("notes.md");
    expect(rendered.html).toContain("report.md");
    expect(rendered.html).not.toContain("old.txt");
    expect(rendered.html).toContain("~/work");
    expect(rendered.html).toContain("Scout&#x27;s private folder");
  });

  it("explains an empty Files tab", () => {
    fixture.view.current = "files";
    expect(render(makeBot()).html).toContain("Files Scout makes or changes in this chat will show up here.");
  });

  it("shows the selected chat's pinned folder after the bot default changes", () => {
    fixture.view.current = "files";
    const rendered = render(makeBot({
      cwd: "/workspace/new-project",
      tasks: [
        { threadId: "other-thread", title: "Other chat", createdAt: 1, cwd: "/workspace/other-project" },
        { threadId: "thread-scout", title: "Existing chat", createdAt: 2, cwd: "/Users/me/original-project" },
      ],
    }));
    expect(rendered.html).toContain('title="/Users/me/original-project"');
    expect(rendered.html).toContain("~/original-project");
    expect(rendered.html).not.toContain("/workspace/new-project");
    expect(rendered.html).not.toContain("/workspace/other-project");
    expect(rendered.html).toContain("Change default");
    expect(rendered.html).toContain("This chat keeps its current folder.");
  });

  it("keeps showing the pinned private folder after the bot default is cleared", () => {
    fixture.view.current = "files";
    const rendered = render(makeBot({ tasks: [
      { threadId: "thread-scout", title: "Existing chat", createdAt: 1, cwd: "/Users/me/.openmausbot/task-workspaces/scout/thread-scout" },
    ] }));
    expect(rendered.html).toContain('title="/Users/me/.openmausbot/task-workspaces/scout/thread-scout"');
    expect(rendered.html).toContain("~/.openmausbot/task-workspaces/scout/thread-scout");
    expect(rendered.html).not.toContain("Scout&#x27;s private folder");
  });

  it("shows a legacy home-folder pin instead of the new bot default", () => {
    fixture.view.current = "files";
    const rendered = render(makeBot({
      cwd: "/workspace/new-project",
      tasks: [{ threadId: "thread-scout", title: "Legacy chat", createdAt: 1, cwd: null }],
    }));
    expect(rendered.html).toContain("Home folder");
    expect(rendered.html).not.toContain("/workspace/new-project");
    expect(rendered.html).not.toContain("Scout&#x27;s private folder");
    expect(rendered.html).toContain("Change default");
  });

  it("uses the bot default until the selected chat has a folder pin", () => {
    fixture.view.current = "files";
    for (const tasks of [undefined, [{ threadId: "thread-scout", title: "New chat", createdAt: 1 }]]) {
      const rendered = render(makeBot({ cwd: "/Users/me/new-project", tasks }));
      expect(rendered.html).toContain('title="/Users/me/new-project"');
      expect(rendered.html).toContain("~/new-project");
      expect(rendered.html).not.toContain("This chat keeps its current folder.");
      expect(rendered.html).not.toContain("Change default");
    }
  });
});

describe("Simple Browser tab with the browser off", () => {
  it("explains and turns on the same installation setting as Settings", async () => {
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("The browser is off");
    expect(rendered.html).not.toContain("BROWSER-PANEL");
    (browserSwitch(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { browser: true } } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("turns on this bot's own browser switch when only that is off", async () => {
    fixture.view.current = "browser";
    const rendered = render(makeBot({ browser: false }));
    expect(browserSwitch(rendered).props.checked).toBe(false);
    (browserSwitch(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: true } }));
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("says why when this server cannot have a browser", () => {
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "unavailable", reason: "No engine here." } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("No engine here.");
    expect(browserSwitch(rendered).props.disabled).toBe(true);
  });

  it("shows the real browser once it is on, under a switch that turns it off for this bot only", () => {
    fixture.view.current = "browser";
    const rendered = render(makeBot());
    expect(rendered.html).toContain("BROWSER-PANEL");
    expect(browserSwitch(rendered).props.checked).toBe(true);
    (browserSwitch(rendered).props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: false } });
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("keeps the Browser tab and its switch in Advanced mode when the browser is off", () => {
    fixture.advanced = true;
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("The browser is off");
    expect(browserSwitch(rendered).props.checked).toBe(false);
  });
});

function browserSwitch(rendered: ReturnType<typeof render>) {
  return rendered.nodes.find((node) => node.props["aria-label"] === "Let Scout use a browser")!;
}

describe("This computer", () => {
  it("shows this computer's screen when the desktop app can drive it", () => {
    const rendered = render(makeBot());
    expect(rendered.html).toContain("this computer");
    expect(rendered.html).toContain("Capturing this computer&#x27;s screen…");
    for (const removed of ["Works on", "Cloud computer", "Local VM", "Where Scout works"]) expect(rendered.html).not.toContain(removed);
  });

  it("says a bot on My Cloud works in the built-in browser, and opens it", () => {
    fixture.config = { ...fixture.config, cloudHome: true };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("Works in the built-in browser only: web pages, no desktop apps.");
    (rendered.button("Open the Browser tab")!.props.onClick as () => void)();
    expect(fixture.values).toContain("browser");
  });
});

describe("Technical controls", () => {
  it("hides the gear and Routines card in Simple and keeps them in Advanced", () => {
    const simple = render(makeBot());
    expect(simple.nodes.some((node) => node.props.title === "Bot settings")).toBe(false);
    expect(simple.buttons.some((node) => text(node.props.children).startsWith("Routines"))).toBe(false);

    fixture.advanced = true;
    fixture.values = [];
    const advanced = render(makeBot());
    expect(advanced.nodes.some((node) => node.props.title === "Bot settings")).toBe(true);
    expect(advanced.buttons.some((node) => text(node.props.children).startsWith("Routines"))).toBe(true);
  });
});
