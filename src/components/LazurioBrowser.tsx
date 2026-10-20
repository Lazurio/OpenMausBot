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
  viewTabOfLink,
} from "@/lib/lazurio-browser-panel";
import { api, useStore } from "@/state/store";
import { useLazurioSignIn } from "./LazurioEngineSignIn";

export const browserWords = (czech: boolean) => czech
  ? {
      browser: "Prohlížeč",
      newTab: "Nová karta",
      tab: (n: number) => `Karta ${n}`,
      openAlone: "Otevřít samostatně",
      close: "Zavřít",
      loading: "Načítám…",
      unavailableTitle: "Prohlížeč není k dispozici",
      unavailableBody: "Prohlížeč Prostředí teď není k dispozici. Karty bota se tu ukážou, až zase bude.",
      frame: "Karta prohlížeče Prostředí",
      showTab: "Ukázat kartu",
      ownBrowser: "Přihlaste se ve vlastním prohlížeči. Prohlížeč Prostředí účet Lazuria nikdy nedrží.",
      openOwnBrowser: "Otevřít ve vlastním prohlížeči",
    }
  : {
      browser: "Browser",
      newTab: "New tab",
      tab: (n: number) => `Tab ${n}`,
      openAlone: "Open on its own",
      close: "Close",
      loading: "Loading…",
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

/** The bot header's button, in Simple and Advanced alike, round in Simple mode's header. Its tooltip is its name. */
export function LazurioBrowserButton({ open, round = false }: { open: boolean; round?: boolean }) {
  const { dispatch } = useStore();
  const words = useBrowserWords();
  return (
    <button
      type="button"
      data-tour="computer"
      data-lazurio-browser-button
      onClick={() => dispatch({ type: "toggleComputer" })}
      aria-pressed={open}
      className={cn(
        "relative",
        round ? "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]" : "rounded-md p-1.5 hover:bg-raised",
        open ? "text-accent" : "text-ink-secondary hover:text-ink",
      )}
      title={words.browser}
      aria-label={words.browser}
    >
      <Globe size={18} />
    </button>
  );
}

const isPlainPrimaryClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;

const panelBesideChat = () => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 768px)").matches;

/**
 */
export function useLazurioBrowserPanel(
): void {

  useEffect(() => {

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!isPlainPrimaryClick(event) || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("data-lazurio-own-browser")) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);

  const revealId = reveal?.messageId;
  const revealTab = reveal?.tabId;
  useEffect(() => {
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