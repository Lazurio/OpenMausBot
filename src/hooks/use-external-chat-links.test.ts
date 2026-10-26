import type { EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Action, type AppState, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], link: null as string | null, showThreads: true }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: () => [fixture.link, (next: string | null) => { fixture.link = next; }],
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));

import { useExternalChatLinks } from "./use-external-chat-links";

const scout: Bot = {
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: "scout-main", title: "Main", createdAt: 1 }],
};
const loading: AppState = { ...initialState, bots: [], selectedId: "" };
const loaded: AppState = { ...initialState, bots: [scout], selectedId: "scout", hydrated: true };
const reporting: Bot = { ...scout, tasks: [...scout.tasks!, { threadId: "scout-report", title: "Report", createdAt: 2 }] };
const ada: Bot = { ...scout, id: "ada", name: "Ada", threadId: "ada-main", tasks: [{ threadId: "ada-main", title: "Main", createdAt: 1 }] };

/** One render: run its effects in order, as React would after commit. */
function render(state: AppState, dispatch: (action: Action) => void) {
  fixture.effects = [];
  useExternalChatLinks(state, dispatch);
  return fixture.effects.map((effect) => effect());
}

/** A page at `path`, with the desktop bridge when given; returns every address the app writes. */
function browser(path: string, ogb?: unknown): string[] {
  const addresses: string[] = [];
  const location = { pathname: path };
  vi.stubGlobal("window", {
    ...(ogb === undefined ? {} : { ogb }),
    location,
    history: {
      replaceState: (_state: unknown, _title: string, next: string) => {
        addresses.push(next);
        location.pathname = new URL(next, "https://mausbot.example.test").pathname;
      },
    },
  });
  return addresses;
}

afterEach(() => { vi.unstubAllGlobals(); fixture.effects = []; fixture.link = null; fixture.showThreads = true; });

describe("useExternalChatLinks", () => {
  it("holds a link that arrives at launch until the bots have loaded, then opens it once", () => {
    let deliver: ((link: string) => void) | undefined;
    const unsubscribe = vi.fn();
    browser("/", { onChatLink: (cb: (link: string) => void) => { deliver = cb; return unsubscribe; } });
    const dispatch = vi.fn();

    const [cleanup] = render(loading, dispatch);
    expect(cleanup).toBe(unsubscribe);
    deliver!("openmausbot://bot/scout");
    render(loading, dispatch);
    expect(dispatch).not.toHaveBeenCalled();

    render(loaded, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
    expect(fixture.link).toBeNull();

    dispatch.mockClear();
    render(loaded, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("closes Settings and the shortcuts list so the linked chat is not left behind them", () => {
    browser("/");
    fixture.link = "openmausbot://bot/scout";
    const dispatch = vi.fn();
    render({ ...loaded, appSettingsOpen: true, shortcutsOpen: true }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "toggleAppSettings", open: false },
      { type: "toggleShortcuts", open: false },
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("opens a bot's link as its row would: at its main thread while threads are hidden", () => {
    browser("/");
    fixture.link = "openmausbot://bot/scout";
    fixture.showThreads = false;
    const dispatch = vi.fn();
    const left = { ...scout, threadId: "scout-report", mainThreadId: "scout-main",
      tasks: [...scout.tasks!, { threadId: "scout-report", title: "Report", createdAt: 2, unread: true }] };
    render({ ...loaded, bots: [left] }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "scout-main" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("does nothing without the desktop bridge", () => {
    const addresses = browser("/");
    const dispatch = vi.fn();
    expect(render(loaded, dispatch)).toEqual([undefined, undefined, undefined]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(addresses).toEqual([]);
  });
});

describe("a conversation's web address, /c/<thread id>", () => {
  it("waits for the bots to load, opens like a chat link to that thread, then leaves the address for /", () => {
    const addresses = browser("/c/scout-report");
    const dispatch = vi.fn();
    render(loading, dispatch);
    expect(fixture.link).toBe("openmausbot://thread/scout-report");
    render(loading, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(addresses).toEqual([]);

    render({ ...loaded, bots: [reporting] }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "switchTask", botId: "scout", threadId: "scout-report" },
      { type: "revealThread", threadId: "scout-report" },
    ]);
    expect(addresses).toEqual(["/"]);

    dispatch.mockClear();
    render({ ...loaded, bots: [reporting] }, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(addresses).toEqual(["/"]);
  });

  it("lands in that conversation with its bot in front, from another bot, another view and open Settings", () => {
    browser("/c/scout-report");
    let state: AppState = { ...loaded, bots: [ada, reporting], selectedId: "ada", activeView: "routines", appSettingsOpen: true };
    const dispatch = (action: Action) => { state = reducer(state, action); };
    render(state, dispatch);
    render(state, dispatch);
    expect(state.selectedId).toBe("scout");
    expect(state.activeView).toBe("chat");
    expect(state.appSettingsOpen).toBe(false);
    expect(state.bots.find((bot) => bot.id === "scout")?.switchingTo).toBe("scout-report");
    expect(state.revealThread?.threadId).toBe("scout-report");
    expect(state.notice).toBeNull();
  });

  it("opens the bot's own thread as its row would while threads are hidden", () => {
    browser("/c/scout-main");
    fixture.showThreads = false;
    let state: AppState = { ...loaded, bots: [ada, scout], selectedId: "ada" };
    const dispatch = (action: Action) => { state = reducer(state, action); };
    render(state, dispatch);
    render(state, dispatch);
    expect(state.selectedId).toBe("scout");
    expect(state.activeView).toBe("chat");
    expect(state.notice).toBeNull();
  });

  it("an id this app does not know lands on / with the notice that the conversation is gone, and nothing else", () => {
    const addresses = browser("/c/0f0e0d0c-0b0a-4909-8807-060504030201");
    let state: AppState = loaded;
    const actions: Action[] = [];
    const dispatch = (action: Action) => { actions.push(action); state = reducer(state, action); };
    render(state, dispatch);
    render(state, dispatch);
    expect(actions).toEqual([{ type: "notice", notice: { kind: "thread-gone", botName: null } }]);
    expect(state.selectedId).toBe("scout");
    expect(state.activeView).toBe("chat");
    expect(addresses).toEqual(["/"]);
  });

  it("an address that names no conversation opens nothing and leaves for / at once", () => {
    for (const path of ["/c/", "/c/a/b", "/c/%E0%A4%A", "/c/%61bc", "/c/" + "x".repeat(257)]) {
      const addresses = browser(path);
      const dispatch = vi.fn();
      render(loaded, dispatch);
      render(loaded, dispatch);
      expect({ path, link: fixture.link, addresses }).toEqual({ path, link: null, addresses: ["/"] });
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("any other address stays as it is", () => {
    for (const path of ["/", "/pair", "/c", "/settings/c/scout-main"]) {
      const addresses = browser(path);
      const dispatch = vi.fn();
      render(loaded, dispatch);
      expect({ path, link: fixture.link, addresses }).toEqual({ path, link: null, addresses: [] });
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
});
