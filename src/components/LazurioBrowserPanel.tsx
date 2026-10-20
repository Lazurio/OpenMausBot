// Lazurio overlay (DEV-6673; root decision 0191 points 13, 34 and 41): MausBot's right panel,
// Prohlížeč. Its first view is the bot's strip in the Environment browser, as a T3 Code thread's
// right panel shows a thread's: each tab is a frame of the Platform's view
// `https://browser.<…>/t/<id>`, where the bot and the person work in the same tab at once (nothing
// is handed over or locked), and "+" opens the bot's window (`lazurio browser window --session
// bot-<id>`, through the server). The strip is the server's answer, read while the browser is in
// view. Where the Environment declares no browser, the view says so. The panel's other views are
// upstream's: the bot's files and worktree, and in Advanced its routines and data.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CalendarClock, Database, ExternalLink, FolderOpen, Globe, Loader2, Plus, X, type LucideIcon } from "lucide-react";

import { acceptViewMessage, browserTimes, viewFrameAttributes } from "../../lazurio/browser-contract/pure.js";
import type { BotBrowserTab, BotBrowserWindow } from "../../shared/lazurio-browser";
import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import {
  browserPanelViews,
  fetchBotBrowserStrip,
  readBrowserPanelView,
  resolveBrowserPanelView,
  takeBrowserTabRequest,
  useBotBrowserStrip,
  useBrowserTabRequest,
  viewOfTab,
  writeBrowserPanelView,
  type BrowserPanelView,
  type BrowserTabRequest,
} from "@/lib/lazurio-browser-panel";
import type { LocaleKey } from "@/locales";
import { api, currentTaskBot, useStore, type Bot } from "@/state/store";
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

const UPSTREAM_VIEWS: Record<Exclude<BrowserPanelView, "browser">, { Icon: LucideIcon; label: LocaleKey }> = {
  files: { Icon: FolderOpen, label: "computer.tab.files" },
  routines: { Icon: CalendarClock, label: "computer.tab.routines" },
  data: { Icon: Database, label: "computer.tab.data" },
};

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
              const { Icon, label } = option === "browser" ? { Icon: Globe, label: words.browser } : { Icon: UPSTREAM_VIEWS[option].Icon, label: t(UPSTREAM_VIEWS[option].label) };
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
          <BotBrowser key={bot.id} botId={bot.id} requested={shownRequest} />
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

/** The bot's tabs: its strip and the tabs its pages opened, which only this panel shows. */
function BotBrowser({ botId, requested }: { botId: string; requested?: BrowserTabRequest }) {
  const words = useBrowserWords();
  const strip = useBotBrowserStrip(botId);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [selected, setSelected] = useState<string | null>(requested?.tabId ?? null);
  const [extra, setExtra] = useState<BotBrowserTab[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const frames = useRef(new Map<string, HTMLIFrameElement>());

  useEffect(() => {
    const read = () => void fetchBotBrowserStrip(botId, api).catch(() => null);
    read();
    const timer = setInterval(read, browserTimes.overviewEveryMs);
    return () => clearInterval(timer);
  }, [botId]);

  useEffect(() => {
    if (requested) setSelected(requested.tabId);
  }, [requested]);

  const available = strip?.available === true ? strip : null;
  const tabs = available ? [...available.tabs, ...extra.filter((tab) => !available.tabs.some((own) => own.tabId === tab.tabId))] : [];
  const requestedTab = available && selected && !tabs.some((tab) => tab.tabId === selected) && selected === requested?.tabId
    ? { tabId: selected, view: viewOfTab(available, selected) } : null;
  const shown = requestedTab ? [...tabs, requestedTab] : tabs;
  const active = shown.find((tab) => tab.tabId === selected) ?? shown.find((tab) => tab.tabId === available?.current) ?? shown[0] ?? null;

  const viewOrigin = available?.viewOrigin ?? null;
  const activeId = active?.tabId ?? null;
  // A tab's frame mounts when it is first shown and stays, so switching back is instant and the view keeps its size.
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (activeId) setMounted((current) => current.has(activeId) ? current : new Set(current).add(activeId));
  }, [activeId]);
  useEffect(() => {
    if (!viewOrigin) return;
    const listen = (event: MessageEvent) => {
      const from = [...frames.current.entries()].find(([, frame]) => frame.contentWindow === event.source)?.[0];
      const message = acceptViewMessage({ data: event.data, origin: event.origin, fromFrame: from !== undefined }, viewOrigin);
      if (!message) return;
      if (message.kind === "info") setTitles((current) => ({ ...current, [message.tab]: message.title }));
      else if (message.kind === "new-tab") {
        setExtra((current) => current.some((tab) => tab.tabId === message.tab) ? current : [...current, { tabId: message.tab, view: `${viewOrigin}/t/${message.tab}` }]);
        if (from === activeId) setSelected(message.tab);
      } else {
        setExtra((current) => current.filter((tab) => tab.tabId !== message.tab));
        void fetchBotBrowserStrip(botId, api).catch(() => null);
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [botId, viewOrigin, activeId]);

  const openWindow = async () => {
    setOpening(true);
    setFailed(false);
    try {
      const answer = await api<BotBrowserWindow>(`/api/bots/${encodeURIComponent(botId)}/browser/window`, { method: "POST" });
      setSelected(answer.tab.tabId);
      await fetchBotBrowserStrip(botId, api);
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };

  if (strip === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-secondary" role="status">
        <Loader2 size={16} className="animate-spin" /> {words.loading}
      </div>
    );
  }
  if (!available) return <Notice title={words.unavailableTitle} body={words.unavailableBody} testId="browser-unavailable" />;

  const label = (tab: BotBrowserTab, index: number) => titles[tab.tabId]?.trim() || words.tab(index + 1);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bot-browser">
      <div className="flex items-center gap-1 border-b border-hairline/40 px-2 pb-2" role="tablist" aria-label={words.browser} data-testid="bot-browser-strip">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {shown.map((tab, index) => {
            const selectedTab = tab.tabId === active?.tabId;
            const name = label(tab, index);
            return (
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={selectedTab}
                data-tab-id={tab.tabId}
                title={name}
                onClick={() => setSelected(tab.tabId)}
                className={cn(
                  "flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px]",
                  selectedTab ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                <Globe size={12} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void openWindow()}
          disabled={opening}
          data-testid="bot-browser-new-tab"
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
          title={words.newTab}
          aria-label={words.newTab}
        >
          {opening ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        </button>
        {active && (
          <a
            href={active.view}
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
      {failed && <p role="alert" className="mx-3 mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{words.openFailed}</p>}
      {shown.length === 0 ? (
        <Notice title={words.emptyTitle} body={words.emptyBody} testId="bot-browser-empty" action={{ label: words.newTab, onClick: () => void openWindow(), busy: opening }} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1">
          {shown.filter((tab) => mounted.has(tab.tabId)).map((tab) => {
            const visible = tab.tabId === active?.tabId;
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
    </div>
  );
}

function Notice({ title, body, testId, action }: {
  title: string;
  body: string;
  testId: string;
  action?: { label: string; onClick: () => void; busy: boolean };
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center" data-testid={testId}>
      <Globe size={22} className="text-ink-secondary" aria-hidden="true" />
      <div className="text-[14px] font-medium text-ink">{title}</div>
      <p className="max-w-sm text-[12.5px] leading-snug text-ink-secondary">{body}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.busy}
          className="mt-1 flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {action.busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          {action.label}
        </button>
      )}
    </div>
  );
}
