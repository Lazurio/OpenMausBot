// Lazurio overlay (DEV-6673; root decision 0191 points 13, 34 and 36–43, 0195 point 15): the ways
// into MausBot's right panel, Prohlížeč, from a chat or a room, as into a T3 Code thread's. The
// bot's header has its button in every mode; a plain click on a link to a tab of this
// Environment's view opens the panel on that tab, which the bot then holds, instead of a new tab
// of the person's browser; and the panel opens by itself, where it sits beside the chat, on a tab
// the bot's session newly opened and on the tab of a sign-in the bot asks for, once per card. A
// sign-in with the person's Lazurio account never opens there: the Environment browser holds no
// Lazurio session, so the card sends the person to their own browser. The panel itself is
// LazurioBrowserPanel.tsx.
import { useCallback, useEffect, type ReactNode } from "react";
import { ExternalLink, Globe } from "lucide-react";

import { lazurioAccountSite } from "../../shared/lazurio-browser";
import type { SignInRequestCardData } from "../../shared/wire";
import { cn } from "@/lib/cn";
import {
  botBrowserStrip,
  fetchBotBrowserStrip,
  firstReveal,
  requestBrowserTab,
  signInToReveal,
  stripHolds,
  takeAnnouncedTabs,
  useAnnouncedTabs,
  viewTabOfLink,
} from "@/lib/lazurio-browser-panel";
import { api, useStore } from "@/state/store";
import { useLazurioSignIn } from "./LazurioEngineSignIn";

export const browserWords = (czech: boolean) => czech
  ? {
      browser: "Prohlížeč",
      files: "Soubory",
      routines: "Rutiny",
      data: "Data",
      newTab: "Nová karta",
      closeTab: "Zavřít kartu",
      undo: "Vrátit",
      newTabLater: "Nová karta se ukáže, až Prostředí nabídne svůj prohlížeč.",
      notKept: "Bot si tuto kartu neponechá.",
      notKeptBody: (full: boolean) => full
        ? "Bot má tolik karet, kolik smí. Zavře se 30 s poté, co ji nikdo nesleduje."
        : "Zavře se 30 s poté, co ji nikdo nesleduje.",
      tab: (n: number) => `Karta ${n}`,
      openAlone: "Otevřít samostatně",
      close: "Zavřít",
      loading: "Načítám…",
      czech: true,
      unavailableTitle: "Prohlížeč není k dispozici",
      unavailableBody: "Prohlížeč Prostředí teď není k dispozici. Karty bota se tu ukážou, až zase bude.",
      frame: "Karta prohlížeče Prostředí",
      showTab: "Ukázat kartu",
      ownBrowser: "Přihlaste se ve vlastním prohlížeči. Prohlížeč Prostředí účet Lazuria nikdy nedrží.",
      openOwnBrowser: "Otevřít ve vlastním prohlížeči",
    }
  : {
      browser: "Browser",
      files: "Files",
      routines: "Routines",
      data: "Data",
      newTab: "New tab",
      closeTab: "Close tab",
      undo: "Undo",
      newTabLater: "New tab shows once the Environment offers its browser.",
      notKept: "This bot does not keep this tab.",
      notKeptBody: (full: boolean) => full
        ? "The bot has as many tabs as it may. It closes 30 s after nobody views it."
        : "It closes 30 s after nobody views it.",
      tab: (n: number) => `Tab ${n}`,
      openAlone: "Open on its own",
      close: "Close",
      loading: "Loading…",
      czech: false,
      unavailableTitle: "Browser unavailable",
      unavailableBody: "The Environment browser is not available right now. The bot's tabs show here once it is.",
      frame: "Environment browser tab",
      showTab: "Show the tab",
      ownBrowser: "Sign in in your own browser. The Environment browser never holds a Lazurio account.",
      openOwnBrowser: "Open in your own browser",
    };

/** The panel's words: the shell's language on a Lazurio Environment (Czech unless the profile is English),
 * English outside Lazurio. */
export function useBrowserWords() {
  return browserWords(useLazurioSignIn()?.czech ?? false);
}

/** Opens the bot's panel on its browser, on `tabId` when given. */
export function useOpenBrowserTab(botId: string) {
  const { dispatch } = useStore();
  return useCallback((tabId?: string) => {
    if (tabId) requestBrowserTab(botId, tabId);
    dispatch({ type: "toggleComputer", open: true });
  }, [botId, dispatch]);
}

/** The bot header's button, in Simple and Advanced alike. Its tooltip is its name. */
export function LazurioBrowserButton({ open }: { open: boolean }) {
  const { dispatch } = useStore();
  const words = useBrowserWords();
  return (
    <button
      type="button"
      data-tour="computer"
      data-lazurio-browser-button
      onClick={() => dispatch({ type: "toggleComputer" })}
      aria-pressed={open}
      className={cn("relative rounded-md p-1.5 hover:bg-raised", open ? "text-accent" : "text-ink-secondary hover:text-ink")}
      title={words.browser}
      aria-label={words.browser}
    >
      <Globe size={18} />
    </button>
  );
}

const isPlainPrimaryClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;

/** Where the panel sits beside the chat rather than over it: only there does it open by itself. */
const panelBesideChat = () => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 768px)").matches;

/**
 * ChatView's and GroupView's one hook, for the bots the chat shows (one, or a room's members): reads their strips
 * (so a link knows this Environment's view), opens the panel on a tab of this Environment's view a plain click asks
 * for, which the chat's bot then holds, and by itself on a tab a bot's session newly opened and on the tab of the
 * newest sign-in a bot asks for, once per card. In a room a link opens only a tab a member already holds.
 */
export function useLazurioBrowserPanel(
  botIds: readonly string[],
  messages: ReadonlyArray<{ id: string; kind?: string; signIn?: SignInRequestCardData; from?: { botId?: string } }>,
): void {
  const { dispatch } = useStore();
  const key = botIds.join(",");
  const open = useCallback((botId: string, tabId: string) => {
    requestBrowserTab(botId, tabId);
    dispatch({ type: "toggleComputer", open: true });
  }, [dispatch]);

  useEffect(() => {
    for (const botId of key.split(",").filter(Boolean)) void fetchBotBrowserStrip(botId, api).catch(() => {});
  }, [key]);

  useEffect(() => {
    const ids = key.split(",").filter(Boolean);
    const onClick = (event: MouseEvent) => {
      if (!isPlainPrimaryClick(event) || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("data-lazurio-own-browser")) return;
      const room = ids.length > 1;
      const target = ids.map((botId) => ({ botId, tabId: viewTabOfLink(link.href, botBrowserStrip(botId)) }))
        .find(({ botId, tabId }) => tabId !== null && (!room || stripHolds(botBrowserStrip(botId), tabId)));
      if (!target?.tabId) return;
      event.preventDefault();
      event.stopPropagation();
      open(target.botId, target.tabId);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [key, open]);

  const announced = useAnnouncedTabs();
  useEffect(() => {
    const taken = takeAnnouncedTabs(new Set(key.split(",").filter(Boolean)));
    const last = taken.at(-1);
    if (last && panelBesideChat()) open(last.botId, last.tabId);
  }, [announced, key, open]);

  const reveal = signInToReveal(messages, botIds.length === 1 ? botIds[0] : undefined);
  const revealId = reveal?.messageId;
  const revealTab = reveal?.tabId;
  const revealBot = reveal?.botId;
  useEffect(() => {
    if (!revealId || !revealTab || !revealBot || !panelBesideChat() || !firstReveal(revealId)) return;
    open(revealBot, revealTab);
  }, [revealId, revealTab, revealBot, open]);
}

/** The sign-in card's line about where to sign in, for the Environment browser: a Lazurio account in the person's
 * own browser, any other site in the bot's tab, which the card shows. Elsewhere upstream's line (`fallback`). */
export function LazurioSignInWhere({ botId, card, fallback }: { botId: string; card: SignInRequestCardData; fallback: ReactNode }) {
  const words = useBrowserWords();
  if (card.place !== "browser") return <>{fallback}</>;
  if (lazurioAccountSite(card.url)) {
    return (
      <div className="mt-2 text-[12.5px] leading-snug text-ink-secondary" data-lazurio-sign-in="own-browser">
        <p>{words.ownBrowser}</p>
        <a href={card.url} target="_blank" rel="noreferrer" data-lazurio-own-browser className="mt-1 inline-flex items-center gap-1 text-accent-text hover:underline">
          <ExternalLink size={12} aria-hidden="true" /> {words.openOwnBrowser}
        </a>
      </div>
    );
  }
  return (
    <>
      {fallback}
      {card.tab && <ShowTab botId={botId} tabId={card.tab} label={words.showTab} />}
    </>
  );
}

function ShowTab({ botId, tabId, label }: { botId: string; tabId: string; label: string }) {
  const open = useOpenBrowserTab(botId);
  return (
    <button type="button" onClick={() => open(tabId)} data-lazurio-sign-in="show-tab" className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-accent-text hover:underline">
      <Globe size={12} aria-hidden="true" /> {label}
    </button>
  );
}
