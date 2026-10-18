import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER } from "@/lib/onboarding";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn(), analyticsChoiceKnown: () => true }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }) }));
import { AppNotices } from "./AppNotices";
import { PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, STAR_NOTICE } from "@/lib/notices";
import { track } from "@/lib/analytics";
import { api } from "@/state/store";

const NOW = new Date(2026, 9, 9, 12).getTime();
const STAR = "Enjoying OpenMausBot?";
const PH = "live on Product Hunt";

let storage: Map<string, string>;
let now: number;
let openExternal: ReturnType<typeof vi.fn>;

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer: LOCAL_VIEWER, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer: LOCAL_VIEWER, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const hints = () => f.state.config.onboarding.hintsSeen as string[];
const showWindow = (ogb: Record<string, unknown> | undefined) => {
  vi.stubGlobal("window", { ...(ogb ? { ogb } : {}), addEventListener: vi.fn(), removeEventListener: vi.fn(), open: vi.fn() });
};

beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW;
  setLocale("en");
  f.state = { connected: true, bots: [], groups: [], routines: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  openExternal = vi.fn(async () => true);
  // This computer's own page in the desktop app.
  showWindow({ remoteClient: { active: false }, openExternal });
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("the star", () => {
  it("is for someone who has used the app before, and Not now ends it for good", async () => {
    storage.set(PRODUCT_HUNT_NOTICE, "1");
    expect(await launch()).toBe("");
    returning();
    expect(await launch()).toContain(STAR);
    press("Not now");
    expect(storage.get(STAR_NOTICE)).toBe("1"); expect(hints()).toContain(STAR_NOTICE);
    expect(await launch()).toBe("");
  });

  it("never on a branded build, a remote client or a browser tab", async () => {
    storage.set(PRODUCT_HUNT_NOTICE, "1"); returning();
    f.brand = "file";
    expect(await launch()).toBe("");
    f.brand = "default"; showWindow({ remoteClient: { active: true }, openExternal });
    expect(await launch()).toBe("");
    showWindow(undefined);
    expect(await launch()).toBe("");
  });
});

describe("the Product Hunt launch card", () => {
  it("comes first, for everyone, and the upvote opens the launch and ends it for good", async () => {
    returning();
    const html = await launch();
    expect(html).toContain(PH); expect(html).toContain("Upvote on Product Hunt"); expect(html).not.toContain(STAR);
    press("Upvote on Product Hunt"); await flush();
    expect(openExternal).toHaveBeenCalledWith(PRODUCT_HUNT_URL);
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "upvote" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1"); expect(hints()).toContain(PRODUCT_HUNT_NOTICE);
    expect(await launch()).toContain(STAR);
  });

  it("Not now ends it for good too", async () => {
    expect(await launch()).toContain(PH);
    press("Not now");
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "not_now" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1");
    expect(await launch()).not.toContain(PH);
  });

  it("never on a branded build, never after the launch window, never over an update", async () => {
    f.brand = "file";
    expect(await launch()).not.toContain(PH);
    f.brand = "default"; now = PRODUCT_HUNT_UNTIL;
    expect(await launch()).not.toContain(PH);
    now = NOW; f.updater = { status: "available", version: "9.9.9" };
    expect(await launch()).not.toContain(PH);
  });
});
