// Lazurio overlay (DEV-6673; root decision 0191 points 13, 34 and 41, 0195 points 13–15): MausBot's
// right panel, Prohlížeč. Its first view is the bot's strip in the Environment browser, as a T3 Code
// thread's right panel shows a thread's: each tab is a frame of the Platform's view
// `https://browser.<…>/t/<id>`, where the bot and the person work in the same tab at once (nothing
// is handed over or locked). "+" is Nová karta, the shell's `<lazurio-new-tab>`: a page it opens or
// a tab chosen in Přehled joins the bot's strip; × lets a tab go, with Vrátit. The strip is the
// server's answer, read while the browser is in view. Where the Environment declares no browser,
// the view says so. The panel's other views are upstream's: the bot's files and worktree, and in
// Advanced its routines and data.
import { createElement, lazy, Suspense, useEffect, useRef, useState } from "react";
import { CalendarClock, Database, ExternalLink, FolderOpen, Globe, Loader2, Plus, X, type LucideIcon } from "lucide-react";

import { acceptViewMessage, browserTimes, newTabEventName, viewFrameAttributes } from "../../lazurio/browser-contract/pure.js";
import type { BotBrowserTab } from "../../shared/lazurio-browser";
import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import {
  browserPanelViews,
  changeBotTab,
  closeNoticeText,
  fetchBotBrowserStrip,
  newTabChoiceOf,
  readBrowserPanelView,
  resolveBrowserPanelView,
  stripHolds,
  takeBrowserTabRequest,
  useBotBrowserStrip,
  useBrowserTabRequest,
  viewOfTab,
  writeBrowserPanelView,
  type BrowserPanelView,
  type BrowserTabRequest,
} from "@/lib/lazurio-browser-panel";
import { ApiError, api, currentTaskBot, useStore, type Bot } from "@/state/store";
import { useCaptionChrome } from "./DesktopCapabilities";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { useBrowserWords } from "./LazurioBrowser";

const DataPanel = lazy(() => import("./data/DataPanel").then((module) => ({ default: module.DataPanel })));

const WIDTH_KEY = "omb-browser-panel-width";
const MIN_WIDTH = 360;
const MAX_WIDTH = 1280;
const DEFAULT_WIDTH = 560;
const RESIZE_STEP = 40;

const VIEW_ICONS: Record<BrowserPanelView, LucideIcon> = { browser: Globe, files: FolderOpen, routines: CalendarClock, data: Database };

/** The shell's Nová karta (LazurioPlatform F47 point 2, contract C10), defined by `/.lazurio/shell.js`. */
const NEW_TAB_ELEMENT = "lazurio-new-tab";
const newTabDefined = () => typeof customElements !== "undefined" && customElements.get(NEW_TAB_ELEMENT) !== undefined;

function useNewTabDefined(): boolean {
  const [defined, setDefined] = useState(newTabDefined);
  useEffect(() => {
    if (defined || typeof customElements === "undefined") return;
    let alive = true;
    void customElements.whenDefined(NEW_TAB_ELEMENT).then(() => {
      if (alive) setDefined(true);
    });
    return () => {
      alive = false;
    };
  }, [defined]);
  return defined;
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) return stored;
  } catch {
  }
  return DEFAULT_WIDTH;
}

function writeWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
  }
}

const tabId = (view: BrowserPanelView) => `browser-panel-tab-${view}`;
const panelId = (view: BrowserPanelView) => `browser-panel-view-${view}`;
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";

export function LazurioBrowserPanel({ bot: profileBot }: { bot: Bot }) {
  const { padClass, dragProps } = useCaptionChrome();
  const { state, dispatch } = useStore();
  const bot = currentTaskBot(profileBot);
  const advanced = useAdvancedMode();
  const words = useBrowserWords();
  const [width, setWidth] = useState(readWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const [stored, setStored] = useState<BrowserPanelView>(() => readBrowserPanelView(bot.id));
  const view = resolveBrowserPanelView(stored, advanced);
  const views = browserPanelViews(advanced, view);
  const choose = (next: BrowserPanelView) => {
    setStored(next);
    writeBrowserPanelView(bot.id, next);
  };

  const request = useBrowserTabRequest(bot.id);
  const [shownRequest, setShownRequest] = useState<BrowserTabRequest>();
  useEffect(() => {
    if (!request) return;
    setShownRequest(request);
    setStored("browser");
    takeBrowserTabRequest(bot.id, request);
  }, [bot.id, request]);

  const requestedData = state.dataResultFocus?.botId === bot.id ? state.dataResultFocus : undefined;
  const [dataRequest, setDataRequest] = useState<{ id: string; requestId: number }>();
  useEffect(() => {
    if (!requestedData || requestedData.consumed) return;
    setDataRequest(requestedData);
    setStored("data");
    dispatch({ type: "dataResultFocusConsumed", requestId: requestedData.requestId });
  }, [dispatch, requestedData]);

  const routines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));

  const resizeBy = (delta: number) => setWidth((current) => {
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current + delta));
    writeWidth(next);
    return next;
  });

  const onTabKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const at = Math.max(0, views.indexOf(view));
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const next = event.key === "Home" ? views[0] : event.key === "End" ? views[views.length - 1]
      : step ? views[(at + step + views.length) % views.length] : undefined;
    if (!next) return;
    event.preventDefault();
    choose(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <aside
      data-lazurio-browser-panel
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={words.browser}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const delta = event.key === "ArrowLeft" ? RESIZE_STEP : event.key === "ArrowRight" ? -RESIZE_STEP : null;
          if (delta === null) return;
          event.preventDefault();
          resizeBy(delta);
        }}
        onPointerDown={(event) => {
          resizeFrom.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!resizeFrom.current) return;
          setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX))));
        }}
        onPointerUp={(event) => {
          if (!resizeFrom.current) return;
          resizeFrom.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          writeWidth(width);
        }}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"
      />
      <div {...dragProps} className={cn("ml-1.5 py-3 pl-2.5 pr-4", padClass)}>
        <div className="relative flex min-h-7 items-center justify-center">
          <div className="mx-9 flex min-w-0 gap-0.5 overflow-x-auto rounded-full bg-inset p-1 [scrollbar-width:none]" role="tablist" aria-label={words.browser} onKeyDown={onTabKey} data-testid="browser-panel-views">
            {views.map((option) => {
              const Icon = VIEW_ICONS[option];
              const label = words[option];
              const selected = option === view;
              return (
                <button
                  key={option}
                  id={tabId(option)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId(option)}
                  tabIndex={selected ? 0 : -1}
                  data-panel-view={option}
                  title={label}
                  onClick={() => choose(option)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors",
                    selected ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  <Icon size={13} /> {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleComputer", open: false })}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={words.close}
            title={words.close}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div role="tabpanel" id={panelId(view)} aria-labelledby={tabId(view)} tabIndex={0} className={cn("flex min-h-0 flex-1 flex-col", FOCUS)}>
        {view === "browser" ? (
          <BotBrowser key={bot.id} botId={bot.id} requested={shownRequest} onView={choose} />
        ) : view === "files" ? (
          <ComputerFilesPane bot={bot} />
        ) : view === "routines" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <RoutinesSection key={bot.id} bot={bot} routines={routines} runs={state.routineRuns} />
          </div>
        ) : (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("data.loading")}</div>}>
            <DataPanel key={bot.id} bot={bot} requestedCard={dataRequest} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

/** A tab of the panel's strip: one of the bot's tabs, or a Nová karta that has not become one yet. */
type Entry = { kind: "tab"; tab: BotBrowserTab } | { kind: "new"; id: string };
const entryId = (entry: Entry) => (entry.kind === "tab" ? entry.tab.tabId : entry.id);

type Notice =
  | { kind: "closed"; tab: BotBrowserTab; title: string; description: string }
  | { kind: "not-kept"; full: boolean };

/** The bot's tabs, as a T3 Code thread's strip: the server's strip, the person's holds on their way, and Nová karta. */
function BotBrowser({ botId, requested, onView }: {
  botId: string;
  requested?: BrowserTabRequest;
  onView: (view: BrowserPanelView) => void;
}) {
  const words = useBrowserWords();
  const strip = useBotBrowserStrip(botId);
  const newTabAvailable = useNewTabDefined();
  const [selected, setSelected] = useState<string | null>(requested?.tabId ?? null);
  const [newTabs, setNewTabs] = useState<string[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  /** Tabs the person holds whose hold has not landed, or did not: the strip shows them meanwhile. */
  const [ownTabs, setOwnTabs] = useState<BotBrowserTab[]>([]);
  /** Tabs × let go of, out of the strip until a list lacks them. */
  const [released, setReleased] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const newTabCount = useRef(0);

  useEffect(() => {
    const read = () => void fetchBotBrowserStrip(botId, api).catch(() => null);
    read();
    const timer = setInterval(read, browserTimes.overviewEveryMs);
    return () => clearInterval(timer);
  }, [botId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.kind === "closed" ? browserTimes.undoMs : browserTimes.viewerGraceMs);
    return () => clearTimeout(timer);
  }, [notice]);

  const available = strip?.available === true ? strip : null;

  const hold = async (tabId: string) => {
    if (!available) return;
    setReleased((current) => {
      const next = new Set(current);
      next.delete(tabId);
      return next;
    });
    if (!stripHolds(available, tabId)) {
      setOwnTabs((current) => current.some((tab) => tab.tabId === tabId) ? current
        : [...current, { tabId, view: viewOfTab(available, tabId), agent: false, alsoHeldBy: [] }]);
    }
    try {
      await changeBotTab(botId, tabId, "hold", api);
      setOwnTabs((current) => current.filter((tab) => tab.tabId !== tabId));
    } catch (error) {
      setNotice({ kind: "not-kept", full: error instanceof ApiError && error.status === 409 });
    }
  };

  const release = async (tab: BotBrowserTab) => {
    setReleased((current) => new Set(current).add(tab.tabId));
    setOwnTabs((current) => current.filter((own) => own.tabId !== tab.tabId));
    setNotice({ kind: "closed", tab, ...closeNoticeText(tab, words.czech) });
    await changeBotTab(botId, tab.tabId, "release", api).catch(() => null);
  };

  /** The latest `hold`, for the effects below: it reads the strip of the render that runs it. */
  const holdLatest = useRef(hold);
  holdLatest.current = hold;

  const undo = (tab: BotBrowserTab) => {
    setNotice(null);
    setSelected(tab.tabId);
    void hold(tab.tabId);
  };

  // A link, a sign-in or the bot's new window asked for a tab: it comes to the front, and the bot holds it.
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requested || !available || handled.current === requested.nonce) return;
    handled.current = requested.nonce;
    setSelected(requested.tabId);
    if (!stripHolds(available, requested.tabId)) void holdLatest.current(requested.tabId);
  }, [requested, available]);

  const tabs = available ? [
    ...available.tabs.filter((tab) => !released.has(tab.tabId)),
    ...ownTabs.filter((own) => !available.tabs.some((tab) => tab.tabId === own.tabId)),
  ] : [];
  const entries: Entry[] = [...tabs.map((tab): Entry => ({ kind: "tab", tab })), ...newTabs.map((id): Entry => ({ kind: "new", id }))];
  const active = entries.find((entry) => entryId(entry) === selected)
    ?? entries.find((entry) => entry.kind === "tab" && entry.tab.tabId === available?.current)
    ?? entries[0] ?? null;
  const activeId = active ? entryId(active) : null;

  // A tab's frame mounts when it is first shown and stays, so switching back is instant and the view keeps its size.
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (active?.kind === "tab") {
      const id = active.tab.tabId;
      setMounted((current) => current.has(id) ? current : new Set(current).add(id));
    }
  }, [active]);

  const viewOrigin = available?.viewOrigin ?? null;
  useEffect(() => {
    if (!viewOrigin) return;
    const listen = (event: MessageEvent) => {
      const from = [...frames.current.entries()].find(([, frame]) => frame.contentWindow === event.source)?.[0];
      const message = acceptViewMessage({ data: event.data, origin: event.origin, fromFrame: from !== undefined }, viewOrigin);
      if (!message) return;
      if (message.kind === "info") setTitles((current) => ({ ...current, [message.tab]: message.title }));
      else if (message.kind === "new-tab") {
        if (from === activeId) setSelected(message.tab);
        void holdLatest.current(message.tab);
      } else {
        setOwnTabs((current) => current.filter((tab) => tab.tabId !== message.tab));
        void changeBotTab(botId, message.tab, "release", api).catch(() => null);
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [botId, viewOrigin, activeId]);

  const openNewTab = () => {
    newTabCount.current += 1;
    const id = `new-tab-${newTabCount.current}`;
    setNewTabs((current) => [...current, id]);
    setSelected(id);
  };
  const closeNewTab = (id: string) => setNewTabs((current) => current.filter((entry) => entry !== id));
  const chose = (newTabId: string | null, detail: unknown) => {
    const choice = newTabChoiceOf(detail, available ?? undefined);
    if (!choice) return;
    if (newTabId) closeNewTab(newTabId);
    if (choice.kind === "view") {
      onView(choice.view);
      return;
    }
    setSelected(choice.tabId);
    void hold(choice.tabId);
  };

  if (strip === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-secondary" role="status">
        <Loader2 size={16} className="animate-spin" /> {words.loading}
      </div>
    );
  }
  if (!available) return <PanelNotice title={words.unavailableTitle} body={words.unavailableBody} testId="browser-unavailable" />;

  const label = (entry: Entry, index: number) => entry.kind === "new" ? words.newTab : titles[entry.tab.tabId]?.trim() || words.tab(index + 1);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="bot-browser">
      <div className="flex items-center gap-1 border-b border-hairline/40 px-2 pb-2" role="tablist" aria-label={words.browser} data-testid="bot-browser-strip">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {entries.map((entry, index) => {
            const id = entryId(entry);
            const selectedTab = id === activeId;
            const name = label(entry, index);
            const marked = entry.kind === "tab" && (entry.tab.agent || entry.tab.alsoHeldBy.length > 0);
            return (
              <div
                key={id}
                className={cn(
                  "group flex max-w-[13rem] shrink-0 items-center rounded-md text-[12px]",
                  selectedTab ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedTab}
                  data-tab-id={id}
                  title={name}
                  onClick={() => setSelected(id)}
                  className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-1"
                >
                  <span className="relative inline-flex shrink-0">
                    {entry.kind === "new" ? <Plus size={12} aria-hidden="true" /> : <Globe size={12} aria-hidden="true" />}
                    {marked && (
                      <span
                        aria-hidden="true"
                        data-tab-mark={entry.tab.agent ? "agent" : "shared"}
                        className={cn("absolute -right-0.5 -top-0.5 size-1.5 rounded-full", entry.tab.agent ? "bg-accent" : "bg-ink-tertiary")}
                      />
                    )}
                  </span>
                  <span className="truncate">{name}</span>
                </button>
                <button
                  type="button"
                  data-close-tab={id}
                  onClick={() => (entry.kind === "new" ? closeNewTab(entry.id) : void release(entry.tab))}
                  className="mr-1 rounded p-0.5 text-ink-tertiary hover:bg-control hover:text-ink"
                  title={words.closeTab}
                  aria-label={words.closeTab}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        {newTabAvailable && (
          <button
            type="button"
            onClick={openNewTab}
            data-testid="bot-browser-new-tab"
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title={words.newTab}
            aria-label={words.newTab}
          >
            <Plus size={15} />
          </button>
        )}
        {active?.kind === "tab" && (
          <a
            href={active.tab.view}
            target="_blank"
            rel="noopener"
            data-lazurio-own-browser
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title={words.openAlone}
            aria-label={words.openAlone}
          >
            <ExternalLink size={15} />
          </a>
        )}
      </div>
      {entries.length === 0 ? (
        newTabAvailable
          ? <NewTab strip={available.strip} filesLabel={words.files} onChoice={(detail) => chose(null, detail)} />
          : <PanelNotice title={words.newTab} body={words.newTabLater} testId="bot-browser-empty" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1">
          {active?.kind === "new" && (
            <div className="col-start-1 row-start-1 flex min-h-0 flex-col">
              <NewTab key={active.id} strip={available.strip} filesLabel={words.files} onChoice={(detail) => chose(active.id, detail)} />
            </div>
          )}
          {tabs.filter((tab) => mounted.has(tab.tabId)).map((tab) => {
            const visible = tab.tabId === activeId;
            return (
              <iframe
                key={tab.tabId}
                ref={(frame) => {
                  if (frame) frames.current.set(tab.tabId, frame);
                  else frames.current.delete(tab.tabId);
                }}
                src={tab.view}
                title={words.frame}
                data-tab-id={tab.tabId}
                className={cn("col-start-1 row-start-1 h-full min-h-0 w-full border-0 bg-white", !visible && "invisible")}
                inert={!visible}
                allow={viewFrameAttributes.allow}
                referrerPolicy={viewFrameAttributes.referrerpolicy}
                sandbox={viewFrameAttributes.sandbox}
              />
            );
          })}
        </div>
      )}
      {notice && (
        <div role="status" data-testid="bot-browser-notice" className="absolute inset-x-3 bottom-3 flex items-start gap-3 rounded-xl border border-hairline/60 bg-menu px-4 py-3 shadow-lg">
          <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
            <div className="font-medium text-ink">{notice.kind === "closed" ? notice.title : words.notKept}</div>
            <div className="mt-0.5 text-ink-secondary">{notice.kind === "closed" ? notice.description : words.notKeptBody(notice.full)}</div>
          </div>
          {notice.kind === "closed" && (
            <button type="button" onClick={() => undo(notice.tab)} className="shrink-0 rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover">
              {words.undo}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Nová karta: the shell's element, which frames the Launchpad's `/new-tab` and says what it became. */
function NewTab({ strip, filesLabel, onChoice }: { strip: string; filesLabel: string; onChoice: (detail: unknown) => void }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const choose = useRef(onChoice);
  choose.current = onChoice;
  useEffect(() => {
    if (!element) return;
    const listen = (event: Event) => choose.current((event as CustomEvent<unknown>).detail);
    element.addEventListener(newTabEventName, listen);
    return () => element.removeEventListener(newTabEventName, listen);
  }, [element]);
  return createElement(NEW_TAB_ELEMENT, {
    ref: setElement,
    strip,
    tools: JSON.stringify([{ id: "files", label: filesLabel }]),
    "data-testid": "bot-browser-new-tab-view",
    className: "flex min-h-0 w-full flex-1",
  });
}

function PanelNotice({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center" data-testid={testId}>
      <Globe size={22} className="text-ink-secondary" aria-hidden="true" />
      <div className="text-[14px] font-medium text-ink">{title}</div>
      <p className="max-w-sm text-[12.5px] leading-snug text-ink-secondary">{body}</p>
    </div>
  );
}
