import { useSyncExternalStore } from "react";

import { lazurioAccountSite } from "../../shared/lazurio-browser";
import type { SignInRequestCardData } from "../../shared/wire";

/** The panel's views: the bot's tabs, its files and worktree, and in Advanced its routines and data. */
export type BrowserPanelView = "browser" | "files" | "routines" | "data";

/** Simple mode shows the browser and the files; Advanced adds routines and data. A data result the person opened
 * shows Data in either mode while it is in view. */
export function browserPanelViews(advanced: boolean, current?: BrowserPanelView): BrowserPanelView[] {
  if (advanced) return ["browser", "files", "routines", "data"];
  return current === "data" ? ["browser", "files", "data"] : ["browser", "files"];
}

export function resolveBrowserPanelView(view: BrowserPanelView, advanced: boolean): BrowserPanelView {
  return browserPanelViews(advanced, view).includes(view) ? view : "browser";
}

const VIEW_KEY = "omb-browser-panel-view";
const STORED: ReadonlySet<string> = new Set<BrowserPanelView>(["files", "routines", "data"]);

export function readBrowserPanelView(botId: string, storage: Pick<Storage, "getItem"> = localStorage): BrowserPanelView {
  try {
    const value = storage.getItem(`${VIEW_KEY}:${botId}`);
    if (value && STORED.has(value)) return value as BrowserPanelView;
  } catch {
  }
  return "browser";
}

export function writeBrowserPanelView(botId: string, view: BrowserPanelView, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(`${VIEW_KEY}:${botId}`, view);
  } catch {
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tab whose view is a view address of `viewOrigin` naming exactly that tab, or null. */
function tabOf(value: unknown, viewOrigin: string): BotBrowserTab | null {
  if (!isRecord(value) || typeof value.tabId !== "string") return null;
  const address = viewAddressOf(value.view);
}

/** The server's answer as the panel reads it; null for anything else. Only views of the declared origin count. */
export function parseBotBrowserStrip(value: unknown): BotBrowserStrip | null {
  if (!isRecord(value)) return null;
  if (value.available === false) return { available: false };
  const origin = viewAddressOf(value.viewOrigin);
  if (!origin || origin.tab !== null) return null;
  const tabs = value.tabs.map((tab) => tabOf(tab, origin.origin)).filter((tab): tab is BotBrowserTab => tab !== null);
  const current = typeof value.current === "string" && tabs.some((tab) => tab.tabId === value.current) ? value.current : null;
}

/** The tab of this Environment's view a link opens, or null: another Environment's view, any other page, and a
 * Lazurio account page open in the person's own browser as they always did (0191 points 37 and 38). */
  if (!strip?.available) return null;
  const address = viewAddressOf(href);
}

/** The view of `tabId` in this strip's Environment. */
export function viewOfTab(strip: Extract<BotBrowserStrip, { available: true }>, tabId: string): string {
  return strip.tabs.find((tab) => tab.tabId === tabId)?.view ?? `${strip.viewOrigin}/t/${tabId}`;
}

 * the Environment browser, with the bot's tab, which is no Lazurio account (that one opens in the person's own
export function signInToReveal(
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const card = message.signIn;
    if (message.kind !== "signin" || !card) continue;
    if (card.done || card.cancelled || card.superseded || card.stopped) continue;
    if (card.place !== "browser" || !card.tab || lazurioAccountSite(card.url)) continue;
  }
  return null;
}

export interface BrowserTabRequest {
  tabId: string;
  /** Makes each request new, also for the same tab. */
  nonce: number;
}

interface PanelState {
  strips: ReadonlyMap<string, BotBrowserStrip>;
  requests: ReadonlyMap<string, BrowserTabRequest>;
}

let nonce = 0;
const listeners = new Set<() => void>();
const change = (next: PanelState) => {
  state = next;
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function rememberBotBrowserStrip(botId: string, strip: BotBrowserStrip): void {
  if (JSON.stringify(state.strips.get(botId)) === JSON.stringify(strip)) return;
  change({ ...state, strips: new Map(state.strips).set(botId, strip) });
}

/** Asks the bot's panel to show `tabId`; the caller opens the panel. */
export function requestBrowserTab(botId: string, tabId: string): void {
  nonce += 1;
}

export function useBotBrowserStrip(botId: string): BotBrowserStrip | undefined {
  return useSyncExternalStore(subscribe, () => state.strips.get(botId), () => state.strips.get(botId));
}

/** The request the bot's panel has not taken yet. */
export function useBrowserTabRequest(botId: string): BrowserTabRequest | undefined {
  return useSyncExternalStore(subscribe, () => state.requests.get(botId), () => state.requests.get(botId));
}

/** The panel took the request: a later opening of the panel starts where the person left it. */
export function takeBrowserTabRequest(botId: string, request: BrowserTabRequest): void {
  if (state.requests.get(botId) !== request) return;
  const requests = new Map(state.requests);
  requests.delete(botId);
  change({ ...state, requests });
}

export function botBrowserStrip(botId: string): BotBrowserStrip | undefined {
  return state.strips.get(botId);
}

  const strip = parseBotBrowserStrip(await api(`/api/bots/${encodeURIComponent(botId)}/browser`));
  if (strip) rememberBotBrowserStrip(botId, strip);
  return strip;
}

/** The sign-in cards that already opened the panel once in this page. */
const revealed = new Set<string>();

/** True once per card: whether this card should open the panel now. */
export function firstReveal(messageId: string): boolean {
  if (revealed.has(messageId)) return false;
  revealed.add(messageId);
  return true;
}