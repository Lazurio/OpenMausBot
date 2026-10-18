// The proactive main agent, wired from ordinary routines: the checks a routine runs before any AI turn and the brief
// its results become. The brief is there only while a briefing routine of the proactive bot is on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { NeedsYouItem } from "../../shared/today.ts";
import type { Notification } from "../../shared/notification.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { AppConfig } from "../config.ts";
import type { Routine, RoutineChecks, RoutineManager, RoutineRun } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";
import { createBrief, type BriefDeps, type MorningDeps } from "./brief.ts";
import { mainChief, proactiveOwner } from "./proactive-owner.ts";
import { createRoutineChecks } from "./routine-checks.ts";
import type { ValueKind } from "./value-ledger.ts";

export { WATCH_INSTRUCTIONS, WATCH_NAME } from "./default-watch.ts";
export const WATCH_FILE = "watch.json";
const ACTIVE = new Set(["queued", "running", "waiting"]);
const MAX_HANDED = 50;
const watchSchema = z.object({
  version: z.literal(1),
  routineId: z.string().max(512).optional(),
  /** The default routine was made here: it is never made again. */
  createdAt: z.number().finite().nonnegative().optional(),
  /** Each briefing routine, by id, and the proactive bot it was placed on: it is handed to a bot once, so one the person
   * moves off it later is left where they put it. */
  handed: z.record(z.string().max(512), z.string().max(512)).optional(),
});
type WatchRecord = Omit<z.infer<typeof watchSchema>, "version">;
const isWatch = (routine: Routine): boolean => routine.target === "bot" && routine.deliver === "brief" && Boolean(routine.checks?.length);

export interface ProactiveDeps {
  store: Store;
  cfg: AppConfig;
  dataDir: string;
  /** A hosted team workspace or a Team Cloud. */
  team: boolean;
  /** This computer's bots moved to My Cloud: nothing here is changed. */
  frozen?: () => boolean;
  routines(): RoutineManager | null;
  mainThread: BriefDeps["mainThread"];
  threadBusy: BriefDeps["threadBusy"];
  notify(notification: Notification | null): void;
  engineName(instanceId: string): string;
  needsYou(): NeedsYouItem[];
  hostTimeZone(): string | undefined;
  /** The owner's last nightly dream, for the brief's Ideas. */
  ideas?: BriefDeps["ideas"];
  /** What the proactive bot did, counted as it happens: emails sorted, replies drafted, meetings prepared. */
  counted?(kind: ValueKind, count: number): void;
  morning?: MorningDeps;
}

export function createProactive(deps: ProactiveDeps) {
  const { store, cfg } = deps;
  const runs = (): RoutineRun[] => [...(deps.routines()?.listRuns() ?? [])].reverse();
  const owner = () => proactiveOwner(store);
  /** The owner's briefing routine is on: pausing or deleting it switches the brief off. */
  const watching = (): boolean => {
    const bot = owner();
    return Boolean(bot && deps.routines()?.listRoutines().some((routine) => routine.botId === bot.id && routine.deliver === "brief" && routine.enabled));
  };

  const brief = createBrief({
    store, dataDir: deps.dataDir, hosted: deps.team, watching, mainThread: deps.mainThread, threadBusy: deps.threadBusy, runs,
    needsYou: deps.needsYou, engineName: deps.engineName, hostTimeZone: deps.hostTimeZone, language: () => cfg.language,
    notify: (bot, threadId, detail) => deps.notify(briefNotification(bot, threadId, detail)),
    session: () => null,
    address: () => checks.address(),
    failRun: (runId, why) => deps.routines()?.rejectResult(runId, why),
    keep: (key) => checks.commit(key),
    items: (key) => checks.items(key),
    ...(deps.ideas ? { ideas: deps.ideas } : {}),
    prepped: () => deps.counted?.("prepped", 1),
    ...(deps.morning ? { morning: deps.morning } : {}),
  });
  const checks = createRoutineChecks({
    dataDir: deps.dataDir, fenced: () => false, runs, timeZone: brief.timeZone, dismissedFrom: brief.dismissedFrom,
    report: (found) => brief.report(found),
    sorted: (routineId, count) => {
      if (deps.routines()?.listRoutines().find((routine) => routine.id === routineId)?.botId === owner()?.id) deps.counted?.("sorted", count);
    },
  });
  /** One brief, the main agent's: a briefing routine of any other bot finds nothing to do. */
  const routineChecks: RoutineChecks = {
    check: (routine, context) => (deps.team || (routine.deliver === "brief" && routine.botId !== owner()?.id) ? Promise.resolve({}) : checks.check(routine, context)),
    release: checks.release,
    settled: (run) => {
      checks.settled(run);
      if (run.deliver === "brief" && run.status === "failed") void brief.refresh();
    },
  };
  const watchFile = join(deps.dataDir, WATCH_FILE);
  let record: WatchRecord | undefined;
  const watchRecord = (): WatchRecord => {
    if (!record) {
      try {
        const parsed = watchSchema.safeParse(JSON.parse(readFileSync(watchFile, "utf8")));
        record = parsed.success ? { ...parsed.data } : {};
      } catch {
        record = {};
      }
    }
    return record;
  };
  const remember = (next: WatchRecord): void => {
    record = next;
    try {
      writeFileAtomic(watchFile, `${JSON.stringify({ version: 1, ...next })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`watch: could not save ${watchFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The watch the main Chief holds becomes the proactive bot's, once: the same routine, so its switch, the instructions
   * the person edited, its checks' cursors and seen ids and its daily cap stay as they are. Never while one of its runs
   * is queued or working. A briefing routine newly on the bot, handed over or arrived with it, is the one: every other is
   * paused, never deleted, and the brief moves to the bot's chat. A restart between the steps finishes them. */
  function handOver(manager: RoutineManager, bot: BotRecord): void {
    const kept = watchRecord();
    const handed = { ...kept.handed };
    const watches = manager.listRoutines().filter(isWatch);
    const chief = mainChief(store);
    const before = chief && chief.id !== bot.id ? watches.filter((routine) => routine.botId === chief.id && handed[routine.id] !== bot.id) : [];
    const runs = before.length ? manager.listRuns() : [];
    if (before.some((routine) => runs.some((run) => run.routineId === routine.id && ACTIVE.has(run.status)))) return;
    const placed = watches.filter((routine) => routine.botId === bot.id && handed[routine.id] !== bot.id).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const routine of before) {
      const moved = manager.update(routine.id, { botId: bot.id });
      if (moved) placed.push(moved);
    }
    const watch = placed.at(-1);
    if (!watch) return;
    for (const other of manager.listRoutines()) if (isWatch(other) && other.id !== watch.id && other.enabled) manager.update(other.id, { enabled: false });
    brief.moveTo(bot.id);
    for (const routine of placed) handed[routine.id] = bot.id;
    remember({ ...kept, handed: Object.fromEntries(Object.entries(handed).slice(-MAX_HANDED)) });
  }

  /** A briefing routine is handed to the proactive bot. Asked at start and every minute, since a MausBot can arrive
   * after the routine was made. */
  function ensureWatch(): void {
    const manager = deps.routines();
    const bot = owner();
    if (deps.team || deps.frozen?.() || !manager || !bot) return;
    try {
      handOver(manager, bot);
    } catch (error) {
      console.warn(`watch: not handed over yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    checks: routineChecks, brief,
    /** The brief is on: the proactive bot's briefing routine is. */
    briefOn: watching,
    /** Only the owner dreams, and only while its brief is on: at most one model call a night, with no switch of its own. */
    dreamer: (): string | undefined => (watching() ? owner()?.id : undefined),
    ensureWatch,
    /** A routine run's turn ended: a briefing run's answer becomes the brief's rows. */
    runSettled: (run: RoutineRun, turnId: string | undefined): void => void brief.consume(run, turnId).catch((error: unknown) => console.warn("brief: a run's answer was not kept", error)),
    start(): void {
      if (timer || deps.team) return;
      timer = setInterval(() => {
        brief.tick();
        try { ensureWatch(); } catch (error) { console.warn("watch: not made yet", error); }
      }, 60_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function briefNotification(bot: BotRecord, threadId: string, detail: string): Notification | null {
  if (bot.notifications === false) return null;
  return { kind: "brief", botId: bot.id, botName: bot.name, threadId, title: bot.name, body: detail.slice(0, 200), ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) };
}

export type Proactive = ReturnType<typeof createProactive>;
