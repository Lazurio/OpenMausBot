import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CalendarClock,
  Hand,
  Loader2,
  Monitor,
  Settings,
  X,
} from "lucide-react";
import { api, currentTaskBot, useStore, type Bot } from "@/state/store";
import { useAdvancedMode } from "@/lib/interface-mode";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { placeOffered } from "@/lib/place";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
const DataPanel = lazy(() => import("./data/DataPanel").then((module) => ({ default: module.DataPanel })));
import { parseComputerHelp, transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { SignInBanner } from "./SignInRequestCard";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { moveBetweenTabs, PANEL_TABS, panelTabProps, TAB_PANEL_FOCUS, tabPanelProps, useAndroidTabFallback } from "./computer-panel-tabs";
import {
  computerPanelTabs,
  readComputerPanelView,
  resolveComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
  help: z.unknown().optional().transform(parseComputerHelp),
}).passthrough();

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
  }
  return PANEL_DEFAULT_WIDTH;
}

export function ComputerPanel({ bot: profileBot }: { bot: Bot }) {
  const { padClass, dragProps } = useCaptionChrome();
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const persistPanelWidth = (width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
    }
  };
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persistPanelWidth(panelWidth);
  };
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => {
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
      persistPanelWidth(next);
      return next;
    });
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  useEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    if (!panel) return;
    const read = () => setSeparatorWidth(panel.offsetWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const onSeparatorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  const { state, dispatch } = useStore();
  const bot = currentTaskBot(profileBot);
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localOffered = placeOffered("local", state.config);
  const localSelectable = localOffered && localComputerSelectable({ capabilities, providerSupportsLocal });
  const localReady = capabilitiesReady && localOffered && providerSupportsLocal && capabilities.localComputer.available;
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advanced = useAdvancedMode();
  const [storedPanelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const requestedDataResult = state.dataResultFocus?.botId === bot.id ? state.dataResultFocus : undefined;
  const [dataRequest, setDataRequest] = useState<{ id: string; requestId: number }>();
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  const panelTabs = computerPanelTabs({ advanced, androidConnected });
  const panelView = resolveComputerPanelView(storedPanelView, { advanced, androidConnected });
  const selectPanelView = (view: ComputerPanelView) => {
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  // Another conversation starts on its screen; a model change keeps the tab.
  const shownThread = useRef(profileBot.threadId);
  useEffect(() => {
    if (shownThread.current === profileBot.threadId) return;
    shownThread.current = profileBot.threadId;
    setPanelView("computer");
  }, [profileBot.threadId]);

  useEffect(() => {
    if (!requestedDataResult || requestedDataResult.consumed) return;
    setDataRequest(requestedDataResult);
    setPanelView("data");
    writeComputerPanelView(bot.id, "data");
    dispatch({ type: "dataResultFocusConsumed", requestId: requestedDataResult.requestId });
  }, [bot.id, dispatch, requestedDataResult]);

  useAndroidTabFallback(bot.id, androidStatus, setPanelView);
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );

  const pageVisible = usePageVisible();
  // The first capture attempt is what makes macOS show the Screen Recording prompt (no reliable pre-grant on macOS
  // 15+), so repeated empty frames mean denied.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    setLocalFrame(null);
    if (panelView !== "computer" || !localReady || !window.ogb || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    const timer = setInterval(shoot, bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelView, localReady, isLinux, pageVisible, bot.busy, bot.id, bot.threadId]);

  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const signInHelp = control.help ?? null;
  const signInAsker = signInHelp ? state.bots.find((candidate) => candidate.id === signInHelp.botId)?.name ?? bot.name : bot.name;
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
          help: snap.help,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  const requestControl = useCallback(async (action: ComputerControlAction) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }));
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason,
      help: snap.help,
    });
    return snap;
  }, [bot.id, dispatch]);

  const releaseControl = useCallback(async () => {
    setControlPending(true);
    setError(null);
    try {
      await transitionComputerControlLease({ action: "release", requestControl });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setControlPending(false);
    }
  }, [requestControl]);

  const signInBanner = () => signInHelp && (
    <SignInBanner help={signInHelp} askerName={signInAsker} onError={setError} />
  );

  const tabClass = (active: boolean) => cn(
    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors @max-[28rem]/paneltabs:[&>svg]:hidden @max-[22rem]/paneltabs:px-2",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );

  const chooseTab = selectPanelView;

  const frameSrc = localReady && !isLinux ? localFrame : null;
  const unavailableLine = !localOffered || localSelectable || !localDisabledReason
    ? t("computer.phase.localUnavailable") : localDisabledReason;

  return (
    <aside
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      style={{ width: panelWidth }}
    >
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"
      />
      {/* ml-1.5 keeps the drag region clear of the resize handle: a later drag region in the DOM wins. */}
      <div {...dragProps} className={cn("@container/paneltabs ml-1.5 py-3 pl-2.5 pr-4", padClass)}>
        <div className="relative flex min-h-7 items-center justify-center">
          {advanced && (
            <button
              onClick={() => {
                dispatch({ type: "toggleComputer", open: false });
                dispatch({ type: "toggleSettings", open: true, section: "access" });
              }}
              className="absolute left-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              title={t("computer.botSettings")}
            >
              <Settings size={18} />
            </button>
          )}
          <div className="mx-9 flex min-w-0 gap-0.5 overflow-x-auto rounded-full bg-inset p-1 [scrollbar-width:none]" data-tour="computer-tabs" data-testid="computer-tabs" role="tablist" aria-label={t("computer.tabsAria")} onKeyDown={(event) => moveBetweenTabs(event, panelTabs, chooseTab)}>
            {panelTabs.map((view) => {
              const { Icon, label, tour } = PANEL_TABS[view];
              return (
                <button key={view} type="button" data-tour={tour} {...panelTabProps(view, view === panelView)} title={t(label)} onClick={() => chooseTab(view)} className={tabClass(view === panelView)}>
                  <Icon size={13} /> {t(label)}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => dispatch({ type: "toggleComputer", open: false })}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("computer.close")}
            title={t("computer.close")}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {panelView === "routines" ? (
        <div {...tabPanelProps("routines")} className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", TAB_PANEL_FOCUS)}>
          <RoutinesSection key={bot.id} bot={bot} routines={botRoutines} runs={state.routineRuns} />
        </div>
      ) : panelView === "data" ? (
        <div {...tabPanelProps("data")} className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", TAB_PANEL_FOCUS)}>
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("data.loading")}</div>}>
            <DataPanel key={bot.id} bot={bot} requestedCard={dataRequest} />
          </Suspense>
        </div>
      ) : panelView === "files" ? (
        <div {...tabPanelProps("files")} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
          <ComputerFilesPane bot={bot} />
        </div>
      ) : panelView === "android" && androidConnected ? (
        <div {...tabPanelProps("android")} className={cn("flex-1 overflow-y-auto px-4 pt-2", TAB_PANEL_FOCUS)}>
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div {...tabPanelProps("computer")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)}>
        <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
          <span>{t("computer.screenOf", { name: bot.name })}</span>
          {localReady && <span className="text-[11px]">{t("computer.badge.local")}</span>}
        </div>
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc ? (
            <img src={frameSrc} alt={t("computer.screenOf", { name: bot.name })} className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {!capabilitiesReady || (localReady && !isLinux) ? <Loader2 size={18} className="animate-spin" /> : <Monitor size={22} />}
              <span className="text-[12px]">
                {!capabilitiesReady
                  ? t("computer.phase.checking")
                  : localReady
                    ? isLinux
                      ? t("computer.linuxReady")
                      : localMisses >= 3
                        ? t("computer.needsScreenPerm")
                        : t("computer.capturingLocal")
                    : unavailableLine}
              </span>
              {localReady && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openSettings")}
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        {signInBanner()}
        {control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">{t("computer.youHaveWheel")}</div>
            <button
              onClick={() => void releaseControl()}
              disabled={controlPending}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              {t("computer.handBack")}
            </button>
          </div>
        )}

        <LocalScreenPreview />
        <LinuxLocalControl />
        <MacLocalControl />

        {advanced && (
          <button type="button" onClick={() => selectPanelView("routines")} className="mt-4 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left hover:bg-raised">
            <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink">{t("computer.tab.routines")} <span className="ml-1 text-[11px] text-ink-secondary">{botRoutines.length}</span></span>
              <span className={cn("mt-1 block truncate text-[11.5px]", activeRoutineRun ? routineRunTone(activeRoutineRun) : "text-ink-secondary")}>{activeRoutineRun ? `${activeRoutineRun.routineName} · ${routineRunLabel(activeRoutineRun)}` : t("computer.routines.openTitle")}</span>
            </span>
            <span className="text-ink-secondary" aria-hidden="true">→</span>
          </button>
        )}
      </div>
      )}
    </aside>
  );
}
