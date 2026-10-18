import { viewerTargetId } from "../../shared/desktop-viewer";
import { Switch } from "./SettingsPrimitives";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CalendarClock, Columns2, Box, Check, Cloud, Sparkles, Globe, Hand, Loader2, Maximize2, Monitor, Moon, Power, Settings, X } from "lucide-react";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { usePanelPage, type PanelPage } from "@/lib/page-open";
const DataPanel = lazy(() => import("./data/DataPanel").then((module) => ({ default: module.DataPanel })));
const loadLiveDesktop = () => import("./LiveDesktop").then((module) => ({ default: module.LiveDesktop }));
const LiveDesktop = lazy(loadLiveDesktop);
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { parseComputerHelp, transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { openProviderDesktop, useComputerTakeover } from "./computer-takeover";
import { SignInBanner } from "./SignInRequestCard";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { moveBetweenTabs, PANEL_TABS, panelTabProps, scrollTabsWithWheel, TAB_PANEL_FOCUS, tabPanelProps, useAndroidTabFallback } from "./computer-panel-tabs";
import { releaseComputerPanelFocus, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";
import {
  computerPanelTabs,
  readComputerPanelView,
  resolveComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import { LocalizedPanelError, panelErrorText } from "@/lib/computer-messages";

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
  help: z.unknown().optional().transform(parseComputerHelp),
  owned: z.boolean().optional(),
}).passthrough();

  const { padClass, dragProps } = useCaptionChrome();
  const { panelWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const advanced = useAdvancedMode();
  const [storedPanelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const requestedDataResult = state.dataResultFocus?.botId === bot.id ? state.dataResultFocus : undefined;
  const [dataRequest, setDataRequest] = useState<{ id: string; requestId: number }>();
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  const panelTabs = computerPanelTabs({ advanced, androidConnected });
  const panelView = resolveComputerPanelView(storedPanelView, { advanced, androidConnected });
  const panelRef = useComputerPanelEntry(profileBot.id, panelView);
  const browserAvailableHere = browserAvailable(state.config);
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
    && (browserAvailableHere || state.config?.browserEngine?.installable === true);
  const selectPanelView = (view: ComputerPanelView) => {
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  useEffect(() => {

  useEffect(() => {
    if (!requestedDataResult || requestedDataResult.consumed) return;
    setDataRequest(requestedDataResult);
    setPanelView("data");
    writeComputerPanelView(bot.id, "data");
    dispatch({ type: "dataResultFocusConsumed", requestId: requestedDataResult.requestId });
  }, [bot.id, dispatch, requestedDataResult]);

  const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
  const [signInRequest, setSignInRequest] = useState<{ url: string; site: string; nonce: number }>();
  // A published page's Open (usePageOpener): this bot's browser shows, with the page in a new tab.
  const [pageRequest, setPageRequest] = useState<PanelPage>();
  usePanelPage(bot.id, (page) => { selectPanelView("browser"); setPageRequest(page); });
  useEffect(() => {
    if (!requestedSignIn || requestedSignIn.consumed) return;
    const view = requestedSignIn.place === "browser" ? "browser" : "computer";
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
    if (view === "browser") setSignInRequest({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
    dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
  }, [bot.id, dispatch, requestedSignIn]);

  useAndroidTabFallback(bot.id, androidStatus, setPanelView);
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );

  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const requestControl = useCallback(async (action: ComputerControlAction, controlLeaseId?: string) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action, ...(controlLeaseId ? { controlLeaseId } : {}) }),
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
  const liveTarget = !computerStatusCurrent ? null
    : phase === "vm" && vmStatus?.viewer_url && vmStatus.target_key ? viewerTargetId({ key: vmStatus.target_key })
      : cloudPreviewReady && cloudBackend === "vps" ? `vps/${bot.id}` : null;
  const takeover = useComputerTakeover({
    botId: bot.id, session: `${viewerConnectionKey}:${panelView}`, held: control.held, request: requestControl,
    viewerClose: liveTarget?.startsWith("vps/") ? threadPath("computer/viewer-close") : null,
  });
  const liveHere = takeover.here && Boolean(liveTarget);
  useEffect(() => { if (liveTarget) void loadLiveDesktop(); }, [liveTarget]);

  const pageVisible = usePageVisible();
  // The first capture attempt is what makes macOS show the Screen Recording prompt (no reliable pre-grant on macOS
  // 15+), so repeated empty frames mean denied.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
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
  }, [panelView, phase, computerStatusCurrent, isLinux, pageVisible, bot.busy, bot.id, bot.threadId]);

  const frameSrc = !computerStatusCurrent ? null :
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : cloudPreviewReady || (bot.computer === "cloud" && phase === "starting")
        ? polledFrame && `data:${polledFrame.mime};base64,${polledFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(frameSrc && (liveTarget || cloudPreviewReady));

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

  const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);

    setControlPending(true);
    setError(null);
    try {
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setControlPending(false);
    }

  const bannerTakesControl = Boolean(signInHelp && signInHelp.place !== "browser" && signInHelp.place !== "local" &&
    (cloudPreviewReady || phase === "vm" || currentTeamComputer));
  const signInBanner = (take?: () => void) => signInHelp && (
    <SignInBanner
      help={signInHelp}
      askerName={signInAsker}
      takeControl={take && { onClick: take, disabled: controlPending || pending === "join", pending: pending === "join" }}
      onError={setError}
    />
  );

  const browserCanTurnOn = browserAvailableHere || state.config?.browserEngine?.installable === true;
  const [browserTurningOn, setBrowserTurningOn] = useState(false);
  const turnOnBrowser = async () => {
    if (browserTurningOn) return;
    setBrowserTurningOn(true);
    setError(null);
    try {
      if (!builtInBrowserEnabled(state.config)) {
        const config: ConfigStatus = await api("/api/config", {
          method: "PATCH",
          body: JSON.stringify({ features: { browser: true } }),
        });
        dispatch({ type: "configStatus", config });
      }
      if (profileBot.browser === false) dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: true } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setBrowserTurningOn(false);
    }
  };

  const turnOffBrowser = () => {
    setError(null);
    dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: false } });
  };
  const browserSwitchRow = (
    <div data-testid="browser-switch-row" className="mb-3 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
      <Globe size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{t("computer.browserSwitch.title", { name: bot.name })}</div>
        {!browserCanTurnOn && <div className="text-[12px] text-ink-secondary">{browserUnavailableReason(state.config)}</div>}
      </div>
      <Switch
        checked={browserEnabled}
        disabled={browserTurningOn || (!browserEnabled && !browserCanTurnOn)}
        aria-label={t("computer.browserSwitch.title", { name: bot.name })}
        onClick={() => (browserEnabled ? turnOffBrowser() : void turnOnBrowser())}
      />
    </div>
  );

  const tabClass = (active: boolean) => cn(
    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[13px] transition-colors @max-[28rem]/paneltabs:[&>svg]:hidden @max-[22rem]/paneltabs:px-2",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );

  const chooseTab = (view: ComputerPanelView) => {
    if (view === "browser") setError(null);
    selectPanelView(view);
  };


  return (
    <aside
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      ref={panelRef}
      data-computer-panel
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
                releaseComputerPanelFocus(panelRef.current, bot.id);
                dispatch({ type: "toggleComputer", open: false });
                dispatch({ type: "toggleSettings", open: true, section: "access" });
              }}
              className="absolute left-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              title={t("computer.botSettings")}
            >
              <Settings size={18} />
            </button>
          )}
          <div className="mx-9 flex min-w-0 touch-pan-x gap-0.5 overflow-x-auto whitespace-nowrap rounded-full bg-inset p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-tour="computer-tabs" data-testid="computer-tabs" role="tablist" aria-label={t("computer.tabsAria")} onWheel={scrollTabsWithWheel} onKeyDown={(event) => moveBetweenTabs(event, panelTabs, chooseTab)}>
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
            data-computer-panel-close
            onClick={() => {
              releaseComputerPanelFocus(panelRef.current, bot.id);
              dispatch({ type: "toggleComputer", open: false });
            }}
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
        </div>
      ) : panelView === "browser" && browserEnabled ? (
        <div {...tabPanelProps("browser")} className={cn("flex min-h-0 flex-1 flex-col px-4 pb-4", TAB_PANEL_FOCUS)}>
          {browserSwitchRow}
          {signInHelp?.place === "browser" && <div className="-mt-1 mb-3">{signInBanner()}</div>}
          <BrowserPanel bot={bot} signIn={signInRequest} page={pageRequest} />
            <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            </div>
          )}
        </div>
      ) : panelView === "browser" ? (
        <div {...tabPanelProps("browser")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)} data-testid="browser-off">
          {browserSwitchRow}
          <div className="mt-2 flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-8 text-center">
            <Globe size={22} className="text-ink-secondary" aria-hidden="true" />
            <div className="text-[14px] font-medium text-ink">{t("computer.browserOff.title")}</div>
            <p className="text-[12px] leading-5 text-ink-secondary">
              {browserCanTurnOn ? t("computer.browserOff.body", { name: bot.name }) : browserUnavailableReason(state.config)}
            </p>
              <div role="alert" className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              </div>
            )}
          </div>
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
            {currentTeamComputer && <span className="text-[11px]">{autoView.short}</span>}
            {phase === "local" && <span className="text-[11px]">{t("computer.badge.local")}</span>}
            {liveHere && <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink"><span className="size-1.5 rounded-full bg-success" />{t("computer.inControl")}</span>}
            {phase === "vm" && !liveHere && <span className="text-[11px]">{t("vm.dest.vm")}</span>}
            {(phase === "show-ready-boat" || phase === "show-sleeping-boat" || phase === "show-pending-boat") && (
              <span className="text-[11px]">{t("computer.badge.autoBoat")}</span>
            )}
            {computerStatusCurrent && bot.computer === "cloud" && cloudBackend === "vps" && (phase === "ready" || phase === "starting") && !liveHere && <span className="text-[11px]">{t("computer.badge.vps")}</span>}
        </div>
        <div className={cn("relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card", liveHere && "ring-2 ring-accent")}>
          {liveHere && liveTarget ? (
            <Suspense fallback={<Loader2 size={18} className="animate-spin text-ink-secondary" />}>
              <LiveDesktop
                target={liveTarget} threadId={bot.threadId} name={bot.name} poster={frameSrc}
                expanded={takeover.expanded} onExpandedChange={takeover.setExpanded}
                onHandBack={() => void handBack()} handingBack={takeover.handingBack}
                onUnreachable={() => { takeover.leave(); setError(new LocalizedPanelError("computer.err.openDesktop")); }}
              />
            </Suspense>
          ) : cloudPreviewReady || (bot.computer === "cloud" && phase === "starting") ? (
            <CloudScreenPreview
              key={`${bot.id}:${bot.threadId}:${bot.computer}:${cloudBackend}`}
              src={frameSrc}
              name={bot.name}
              error={panelErrorText(previewError)}
              refreshing={previewRefreshing}
              retry={previewRetry}
              starting={phase === "starting"}
              opening={pending === "join"}
              disabled={controlPending}
              onOpen={() => void takeControl()}
              onRetry={(discardFrame) => {
                lastLiveAt.current = 0;
                if (discardFrame) setPolledFrame(null);
                setPreviewError(null);
                setPreviewRefreshing(true);
                setPreviewRetry((n) => n + 1);
              }}
            />
          ) : frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void takeControl()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={t("computer.openLiveDesktopAria", { name: bot.name })}
              title={t("computer.openLiveDesktop")}
            >
              <img
                src={frameSrc}
                alt={t("computer.screenOf", { name: bot.name })}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                {t("computer.open")}
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={t("computer.screenOf", { name: bot.name })}
              className="h-full w-full object-contain"
              title={phase === "vm" ? t("computer.watchOnly") : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              <span className="text-[12px]">
                    ? isLinux
                      ? t("computer.linuxReady")
                      : localMisses >= 3
              </span>
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openSettings")}
                </button>
              )}
                <button
                  onClick={() => selectPanelView("browser")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openBrowserTab")}
                </button>
              )}
            </div>
          )}
        </div>

          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          </div>
        )}

        {signInHelp && signInHelp.place !== "browser" && signInBanner(bannerTakesControl && !control.held
          ? () => phase === "vm" || cloudPreviewReady ? void takeControl() : void controlAction("take")
          : undefined)}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}
              {cloudPreviewReady && !liveTarget && ` ${t(advanced ? "computer.useOpenDesktop" : "computer.simple.useFullScreen")}`}
            </div>
            <button
              onClick={() => void handBack()}
              disabled={controlPending || takeover.handingBack}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              {t("computer.handBack")}
            </button>
          </div>
        )}

        <button type="button" onClick={() => selectPanelView("routines")} className="mt-4 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left hover:bg-raised">
          <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">{t("computer.tab.routines")} <span className="ml-1 text-[11px] text-ink-secondary">{botRoutines.length}</span></span>
            <span className={cn("mt-1 block truncate text-[12px]", activeRoutineRun ? routineRunTone(activeRoutineRun) : "text-ink-secondary")}>{activeRoutineRun ? `${activeRoutineRun.routineName} · ${routineRunLabel(activeRoutineRun)}` : t("computer.routines.openTitle")}</span>
          </span>
          <span className="text-ink-secondary" aria-hidden="true">→</span>
        </button>
        </> : (
          <div className="mt-4 rounded-xl bg-card p-4" data-testid="where-works">
            <div className="text-[15px] font-medium text-ink">{t("computer.simple.whereWorks", { name: bot.name })}</div>
            <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid grid-cols-3 gap-2">
              {placeOptions.map(({ mode, Icon, selected, disabled, unavailableTitle, simpleLabel, issue, view }) => (
                <button
                  key={mode ?? "auto"}
                  type="button"
                  disabled={disabled}
                  title={unavailableTitle}
                  aria-pressed={selected}
                  onClick={() => selectPlace(mode)}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1.5 py-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                    selected
                      ? "border-accent/60 bg-accent/10 text-ink"
                      : "border-hairline/50 bg-panel/30 text-ink-secondary",
                    disabled ? "cursor-not-allowed opacity-50" : "hover:border-accent/40 hover:bg-control/60",
                  )}
                >
                  <Icon size={16} className={cn("shrink-0", selected ? "text-accent" : "text-ink-secondary")} aria-hidden="true" />
                  <span className="w-full truncate text-[12px] font-medium leading-4">{simpleLabel}</span>
                  {issue && <span className="w-full truncate text-[11px] leading-3 text-ink-secondary">{view.short}</span>}
                </button>
              ))}
            </div>
            <div className="mt-3 text-[12px] leading-5 text-ink-secondary" data-testid="place-line">
              {worksOnView.line}
              {placeActionButton(worksOnView, "mt-1 block font-medium text-accent hover:underline")}
            </div>
            {heldPin && (
              <div className="mt-2 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[12px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
                  {t("place.pinnedNoteSimple", {
                    place: placeOptions.find(({ mode }) => mode === heldPin)?.simpleLabel ?? t(placeLabelKey(heldPin)),
                  })}
                </p>
                <button
                  type="button"
                  disabled={Boolean(bot.busy)}
                  title={bot.busy ? t("place.busy") : undefined}
                  onClick={() => dispatch({ type: "updateTask", botId: profileBot.id, threadId: profileBot.threadId, patch: { surface: null } })}
                  className="shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  data-testid="place-unpin"
                >
                  {t("place.unpinSimple", {
                    place: placeOptions.find(({ selected }) => selected)?.simpleLabel ?? t(placeLabelKey(profileBot.computer ?? "auto")),
                  })}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </aside>
  );
}
