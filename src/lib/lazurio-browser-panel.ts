// Lazurio overlay (DEV-6673; root decision 0191 points 13, 34 and 36–43, 0195 points 13–15): the
// state of MausBot's right panel, Prohlížeč, which shows a bot's tabs in the Environment browser
// through the Platform's view, as a T3 Code thread's right panel does. The server's answer
// (`GET /api/bots/<bot>/browser`) is the one truth about the strip; this module keeps the last
// answer per bot, the person's holds and releases on their way, the tab a link, a sign-in or the
// bot's new window asked the panel to show, and the panel's views and words.
import { useSyncExternalStore } from "react";

import { isStrip, newTabViewOf, parseNewTabChoice, viewAddressOf } from "../../lazurio/browser-contract/pure.js";
import type { BotBrowserHolder, BotBrowserStrip, BotBrowserTab } from "../../shared/lazurio-browser";
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

function holdersOf(value: unknown): BotBrowserHolder[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((holder) => isRecord(holder) && typeof holder.strip === "string" && typeof holder.label === "string"
    ? [{ strip: holder.strip, label: holder.label }] : []);
}

/** A tab whose view is a view address of `viewOrigin` naming exactly that tab, or null. */
function tabOf(value: unknown, viewOrigin: string): BotBrowserTab | null {
  if (!isRecord(value) || typeof value.tabId !== "string") return null;
  const address = viewAddressOf(value.view);
  if (!address || address.origin !== viewOrigin || address.tab !== value.tabId) return null;
  return {
    tabId: address.tab,
    view: address.view,
    agent: value.agent === true,
    alsoHeldBy: holdersOf(value.alsoHeldBy),
    alsoHeldElsewhere: value.alsoHeldElsewhere === true,
  };
}

/** The server's answer as the panel reads it; null for anything else. Only views of the declared origin count. */
export function parseBotBrowserStrip(value: unknown): BotBrowserStrip | null {
  if (!isRecord(value)) return null;
  if (value.available === false) return { available: false };
  if (value.available !== true || typeof value.viewOrigin !== "string" || !Array.isArray(value.tabs) || !isStrip(value.strip)) return null;
  const origin = viewAddressOf(value.viewOrigin);
  if (!origin || origin.tab !== null) return null;
  const tabs = value.tabs.map((tab) => tabOf(tab, origin.origin)).filter((tab): tab is BotBrowserTab => tab !== null);
  const current = typeof value.current === "string" && tabs.some((tab) => tab.tabId === value.current) ? value.current : null;
  return { available: true, strip: value.strip, viewOrigin: origin.origin, tabs, current };
}

/** The tab of this Environment's view a link opens, or null: another Environment's view, any other page, and a
 * Lazurio account page open in the person's own browser as they always did (0191 points 37 and 38). */
export function viewTabOfLink(href: string, strip: BotBrowserStrip | undefined): string | null {
  if (!strip?.available) return null;
  const address = viewAddressOf(href);
  return address && address.origin === strip.viewOrigin && address.tab !== null ? address.tab : null;
}

/** Whether the strip holds the tab. */
export function stripHolds(strip: BotBrowserStrip | undefined, tabId: string): boolean {
  return strip?.available === true && strip.tabs.some((tab) => tab.tabId === tabId);
}

/** What Nová karta became, as the panel takes it: a tab of this Environment's view (a page it opened or one chosen
 * in Přehled), or one of the panel's own views; null for anything else. */
export function newTabChoiceOf(detail: unknown, strip: BotBrowserStrip | undefined):
  { kind: "tab"; tabId: string } | { kind: "view"; view: BrowserPanelView } | null {
  const choice = parseNewTabChoice(detail);
  if (!choice) return null;
  if (choice.kind === "tool") return choice.id === "files" ? { kind: "view", view: "files" } : null;
  if (!strip?.available || newTabViewOf(choice.view, choice.tab) === null) return null;
  return viewAddressOf(choice.view)?.origin === strip.viewOrigin ? { kind: "tab", tabId: choice.tab } : null;
}

/** The view of `tabId` in this strip's Environment. */
export function viewOfTab(strip: Extract<BotBrowserStrip, { available: true }>, tabId: string): string {
  return strip.tabs.find((tab) => tab.tabId === tabId)?.view ?? `${strip.viewOrigin}/t/${tabId}`;
}

type SignInMessage = { id: string; kind?: string; signIn?: SignInRequestCardData; from?: { botId?: string } };

/** The sign-in card that should open the panel on a bot's tab: the newest one still waiting for the person, in
 * the Environment browser, with the bot's tab, which is no Lazurio account (that one opens in the person's own
 * browser). In a room the asking bot is the card's sender. Null when there is none. */
export function signInToReveal(
  messages: ReadonlyArray<SignInMessage>,
  chatBotId?: string,
): { messageId: string; tabId: string; botId: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const card = message.signIn;
    if (message.kind !== "signin" || !card) continue;
    if (card.done || card.cancelled || card.superseded || card.stopped) continue;
    if (card.place !== "browser" || !card.tab || lazurioAccountSite(card.url)) continue;
    const botId = message.from?.botId ?? chatBotId;
    if (!botId) continue;
    return { messageId: message.id, tabId: card.tab, botId };
  }
  return null;
}

/** Where else a tab is: in Apps, in a T3 Code thread, with another bot, or another strip's label; `elsewhere`
 * adds the strips the server names to nobody this person (a restricted bot, a T3 Code thread). */
export function placesOf(holders: ReadonlyArray<BotBrowserHolder>, czech: boolean, elsewhere = false): string {
  const places = holders.map((holder) =>
    holder.strip === "launchpad" ? (czech ? "v Apps" : "in Apps")
      : holder.strip.startsWith("t3-") ? (czech ? `ve vlákně „${holder.label}“` : `in the thread “${holder.label}”`)
        : holder.strip.startsWith("bot-") ? (czech ? `u bota „${holder.label}“` : `with the bot “${holder.label}”`)
          : holder.label || holder.strip);
  if (elsewhere) places.push(czech ? "jinde v Prostředí" : "elsewhere in the Environment");
  const last = places.at(-1) ?? "";
  if (places.length < 2) return last;
  return `${places.slice(0, -1).join(", ")} ${czech ? "a" : "and"} ${last}`;
}

/** What becomes of a tab × let go of, said from the last strip, as T3 Code's strip says it. */
export function closeNoticeText(tab: BotBrowserTab | undefined, czech: boolean): { title: string; description: string } {
  return {
    title: czech ? "Karta zmizela z lišty tohoto bota." : "The tab left this bot's strip.",
    description: tab?.agent
      ? czech ? "Pracuje v ní bot, takže zůstává otevřená." : "The bot works in it, so it stays open."
      : tab && (tab.alsoHeldBy.length > 0 || tab.alsoHeldElsewhere)
        ? czech ? `Dál je ${placesOf(tab.alsoHeldBy, true, tab.alsoHeldElsewhere)}.` : `It stays ${placesOf(tab.alsoHeldBy, false, tab.alsoHeldElsewhere)}.`
        : czech ? "Zavře se v Prostředí." : "It closes in the Environment.",
  };
}

export interface BrowserTabRequest {
  tabId: string;
  /** Makes each request new, also for the same tab. */
  nonce: number;
}

interface PanelState {
  strips: ReadonlyMap<string, BotBrowserStrip>;
  /** The tab a link, a sign-in or the bot's new window asked the panel to show, per bot, until the panel takes it. */
  requests: ReadonlyMap<string, BrowserTabRequest>;
  /** The bot whose panel a request opened last: in a room, the panel shows that member's tabs. */
  panelBotId: string | null;
  /** Tabs the bot's session newly bound (the server's `lazurio-browser-tab` event), not yet taken by a chat. */
  announced: ReadonlyArray<{ botId: string; tabId: string; nonce: number }>;
  /** Per bot, the tabs × let go of whose release is on its way: out of the panel's strip until the server answers. */
  releasing: ReadonlyMap<string, ReadonlySet<string>>;
}

const NOTHING_RELEASING: ReadonlySet<string> = new Set();

let state: PanelState = { strips: new Map(), requests: new Map(), panelBotId: null, announced: [], releasing: new Map() };
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
  change({ ...state, requests: new Map(state.requests).set(botId, { tabId, nonce }), panelBotId: botId });
}

/** The server said the bot's session newly bound a tab: a chat that shows the bot opens its panel on it. */
export function announceBotBrowserTab(botId: string, tabId: string): void {
  nonce += 1;
  change({ ...state, announced: [...state.announced, { botId, tabId, nonce }].slice(-16) });
}

/** The announcements for these bots, taken: each opens a panel at most once. */
export function takeAnnouncedTabs(botIds: ReadonlySet<string>): Array<{ botId: string; tabId: string }> {
  const taken = state.announced.filter((entry) => botIds.has(entry.botId));
  if (!taken.length) return [];
  change({ ...state, announced: state.announced.filter((entry) => !botIds.has(entry.botId)) });
  return taken;
}

export function useAnnouncedTabs(): PanelState["announced"] {
  return useSyncExternalStore(subscribe, () => state.announced, () => state.announced);
}

/** The tabs of the bot's strip whose release is on its way. */
export function useReleasingTabs(botId: string): ReadonlySet<string> {
  const read = () => state.releasing.get(botId) ?? NOTHING_RELEASING;
  return useSyncExternalStore(subscribe, read, read);
}

export function releasingTabs(botId: string): ReadonlySet<string> {
  return state.releasing.get(botId) ?? NOTHING_RELEASING;
}

function markReleasing(botId: string, tabId: string, on: boolean): void {
  const current = state.releasing.get(botId) ?? NOTHING_RELEASING;
  if (current.has(tabId) === on) return;
  const tabs = new Set(current);
  if (on) tabs.add(tabId);
  else tabs.delete(tabId);
  const releasing = new Map(state.releasing);
  if (tabs.size) releasing.set(botId, tabs);
  else releasing.delete(botId);
  change({ ...state, releasing });
}

/** The tabs the panel shows: the server's strip without the tabs whose release is on its way, then the person's
 * holds on their way that the strip does not have yet. */
export function shownTabs(
  strip: Extract<BotBrowserStrip, { available: true }>,
  releasing: ReadonlySet<string>,
  ownTabs: ReadonlyArray<BotBrowserTab>,
): BotBrowserTab[] {
  return [
    ...strip.tabs.filter((tab) => !releasing.has(tab.tabId)),
    ...ownTabs.filter((own) => !strip.tabs.some((tab) => tab.tabId === own.tabId)),
  ];
}

/** Whether a tab the panel was asked to show (a link, a sign-in, the bot's new window) needs the person's hold:
 * the strip does not hold it, or × is letting it go. */
export function requestNeedsHold(strip: BotBrowserStrip | undefined, releasing: ReadonlySet<string>, tabId: string): boolean {
  return !stripHolds(strip, tabId) || releasing.has(tabId);
}

export function useBotBrowserStrip(botId: string): BotBrowserStrip | undefined {
  return useSyncExternalStore(subscribe, () => state.strips.get(botId), () => state.strips.get(botId));
}

/** The request the bot's panel has not taken yet. */
export function useBrowserTabRequest(botId: string): BrowserTabRequest | undefined {
  return useSyncExternalStore(subscribe, () => state.requests.get(botId), () => state.requests.get(botId));
}

/** The bot whose panel a link, a sign-in or a new window opened last. */
export function useBrowserPanelBotId(): string | null {
  return useSyncExternalStore(subscribe, () => state.panelBotId, () => state.panelBotId);
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

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export async function fetchBotBrowserStrip(botId: string, api: Api): Promise<BotBrowserStrip | null> {
  const strip = parseBotBrowserStrip(await api(`/api/bots/${encodeURIComponent(botId)}/browser`));
  if (strip) rememberBotBrowserStrip(botId, strip);
  return strip;
}

/** The person holds (`hold`) or lets go of (`release`) a tab of the bot's strip; resolves with the strip after.
 * A hold takes the tab out of the releasing ones at once (Vrátit, a request for it, a page's new tab). */
export async function changeBotTab(botId: string, tabId: string, action: "hold" | "release", api: Api): Promise<BotBrowserStrip | null> {
  if (action === "hold") markReleasing(botId, tabId, false);
  const strip = parseBotBrowserStrip(await api(`/api/bots/${encodeURIComponent(botId)}/browser/${action}`, {
    method: "POST",
    body: JSON.stringify({ tabId }),
  }));
  if (strip) rememberBotBrowserStrip(botId, strip);
  return strip;
}

/**
 * × on a tab: it leaves the panel's strip while the release is on its way, and the server's answer decides
 * after. On success the strip after is the server's, without the tab, so a tab the bot binds again later
 * shows again; on a failure the tab comes back as the server still holds it. Resolves with whether the
 * release landed.
 */
export async function releaseBotTab(botId: string, tabId: string, api: Api): Promise<boolean> {
  markReleasing(botId, tabId, true);
  try {
    await changeBotTab(botId, tabId, "release", api);
    return true;
  } catch {
    return false;
  } finally {
    markReleasing(botId, tabId, false);
  }
}

/** The sign-in cards that already opened the panel once in this page. */
const revealed = new Set<string>();

/** True once per card: whether this card should open the panel now. */
export function firstReveal(messageId: string): boolean {
  if (revealed.has(messageId)) return false;
  revealed.add(messageId);
  return true;
}
