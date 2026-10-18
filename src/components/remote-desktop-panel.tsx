
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import type { Routine } from "@/lib/routines";
import { scheduleLabel } from "@/lib/schedule-label";
import { releaseComputerPanelFocus, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { RoutineEditor } from "./RoutinesPage";
import { BrowserPanel, type BrowserSignIn } from "./BrowserPanel";
import { SignInBanner } from "./SignInRequestCard";

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "cron" || routine.schedule.type === "limit_reset") return scheduleLabel(routine.schedule);
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (routine.schedule.type === "interval") {
    const cadence = routine.schedule.everyMinutes % 60 === 0
      ? `Every ${routine.schedule.everyMinutes / 60} hr`
      : `Every ${routine.schedule.everyMinutes} min`;
    return `${cadence} · starting ${new Date(routine.schedule.anchorAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  const days = routine.schedule.weekdays;
  const cadence =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function RemoteDesktopPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { padClass, dragProps } = useCaptionChrome();
  const panelRef = useComputerPanelEntry(bot.id);
  const [error, setError] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [signIn, setSignIn] = useState<BrowserSignIn>();
  const help = state.computerControl[bot.id]?.help ?? null;
  const asker = help ? state.bots.find((candidate) => candidate.id === help.botId)?.name ?? bot.name : bot.name;
  const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
  useEffect(() => {
    if (!requestedSignIn || requestedSignIn.consumed) return;
    if (requestedSignIn.place === "browser") setSignIn({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
    dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
  }, [dispatch, requestedSignIn]);
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );

  return (
    <aside className="relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline bg-panel" ref={panelRef} data-computer-panel>
      <div {...dragProps} className={cn("flex items-center justify-between border-b border-hairline px-5 py-4", padClass)}>
        <div>
          <div className="text-[14px] font-medium text-ink">{bot.name}&apos;s computer</div>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-full bg-inset p-0.5" aria-label="Bot panel view">
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                aria-pressed={view === option}
                className={cn("flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px]", view === option ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}
              >
              </button>
            ))}
          </div>
          <button
            type="button"
            data-computer-panel-close
            onClick={() => {
              releaseComputerPanelFocus(panelRef.current, bot.id);
              dispatch({ type: "toggleComputer", open: false });
            }}
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label="Close computer panel"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {view === "browser" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-1">
          <BrowserPanel bot={bot} signIn={signIn} />
          {error && <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
            Watching and driving this browser needs browser control for this paired device, in Settings → Remote access on the host computer.
          </p>
        </div>
      ) : (
      <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-6 py-5 text-center">
        <div className="w-full rounded-xl bg-card p-4 text-left">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <CalendarClock size={16} className="text-accent" />
              Scheduled tasks
            </div>
            {botRoutines.length > 0 && (
              <span className="rounded-full bg-control px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
                {botRoutines.length}
              </span>
            )}
          </div>
          {activeRoutineRun && (
            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {botRoutines.slice(0, 3).map((routine) => (
                <button
                  type="button"
                  key={routine.id}
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex w-full items-center gap-2 rounded-lg bg-inset px-3 py-2 text-left hover:bg-control/60"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/40")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[11px] text-ink-secondary">
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setCreatingRoutine(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110"
            >
              <Plus size={14} />
              Create schedule
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
              title="Open schedules"
            >
              <CalendarDays size={14} />
              Schedules
            </button>
          </div>
        </div>
      </div>
      )}
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
  );
}
