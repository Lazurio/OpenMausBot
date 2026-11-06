// Lazurio overlay: the GitHub intake's routes and wiring (server/github-intake.ts,
// docs/lazurio-github-intake.md). GET /api/github-intake: what the intake is
// doing (state, account, target bot, recent events). POST
// /api/github-intake/poll: poll GitHub now instead of waiting for the
// interval. Admin-scoped by default (server/request-auth.ts lists no client
// rule for them). index.ts builds it once, pushes `routes` into ROUTES, and
// starts polling once the server listens.
import { join } from "node:path";

import { spawnGh } from "../github-intake-gh.ts";
import { GithubIntake, githubIntakeConfigFromEnv, type GithubIntakeOptions } from "../github-intake.ts";
import type { RunReceipt } from "../github-intake-recovery.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface GithubIntakeRouteDeps {
  intake: Pick<GithubIntake, "status" | "pollOnce"> | null;
}

export function createGithubIntakeRoutes(deps: GithubIntakeRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/github-intake" && path !== "/api/github-intake/poll") return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/github-intake" && method === "GET") {
      return json(res, 200, deps.intake ? deps.intake.status() : { enabled: false });
    }
    if (path === "/api/github-intake/poll" && method === "POST") {
      if (!deps.intake) return json(res, 409, { error: "The GitHub intake is off. Set OMB_GITHUB_INTAKE=1 and OMB_GITHUB_INTAKE_BOT, then restart the server." });
      const summary = await deps.intake.pollOnce();
      return json(res, 200, { summary, status: deps.intake.status() });
    }
    return json(res, 405, { error: "method not allowed" });
  };
}

/** The intake's guard: every delivery and state write claims the server's
 * maintenance gate, which refuses while a backup or a pending restore owns
 * the quiet workspace. */
export function maintenanceGuard(maintenance: { request(): () => void }): <T>(work: () => T) => T {
  return (work) => {
    const release = maintenance.request();
    try { return work(); } finally { release(); }
  };
}

/** One coordinated piece of work as the coordinator's `job` lists it. */
export interface TreeRow {
  id: string; parentId?: string; status: string; createdAt: number; startedAt?: number; lastActivityAt?: number;
  assignee: { destination: { threadId: string; groupId?: string } };
}

/** What the intake needs of the coordinator: the whole tree a conversation was
 * given and handed out since a time, and its cancels, each of which settles a
 * node with everything under it and aborts their running turns. */
export interface RunTreeCoordinator {
  job(threadId: string, since: number): { rows: readonly TreeRow[] };
  cancelDirect(threadId: string, reason?: string): void;
  cancelRoom(groupId: string, threadId?: string, reason?: string): void;
}

const ENDED = new Set(["completed", "failed", "cancelled"]);
const MAX_THREADS = 10_000;

/** The work of one run's conversation, at any depth. `job` lists it even after
 * the conversation's own node was settled, so a teammate a stop left running
 * still counts. */
export function runTree(coordinator: RunTreeCoordinator, now: () => number = Date.now) {
  const events = new Map<string, number>();
  const live = (threadId: string, since: number) => coordinator.job(threadId, since).rows.filter((row) => !ENDED.has(row.status));
  return {
    /** Remembers the latest event of up to `MAX_THREADS` threads; the one silent longest is forgotten first. */
    observe(event: { threadId: string }): void {
      events.delete(event.threadId);
      events.set(event.threadId, now());
      if (events.size > MAX_THREADS) events.delete(events.keys().next().value!);
    },
    /** The latest runtime event in the conversation or in any thread of its tree, or the tree's own latest activity; undefined when none is known. */
    progressAt(threadId: string, since: number): number | undefined {
      const times = [events.get(threadId), ...coordinator.job(threadId, since).rows.flatMap((row) =>
        [row.lastActivityAt ?? row.startedAt ?? row.createdAt, events.get(row.assignee.destination.threadId)])];
      const known = times.filter((at): at is number => at !== undefined);
      return known.length ? Math.max(...known) : undefined;
    },
    live: (threadId: string, since: number): boolean => live(threadId, since).length > 0,
    /** Cancels the topmost live nodes; each cancel cascades to everything under them. */
    stop(threadId: string, since: number, reason: string): void {
      const rows = live(threadId, since);
      const ids = new Set(rows.map((row) => row.id));
      for (const row of rows) {
        if (row.parentId && ids.has(row.parentId)) continue;
        const { threadId: at, groupId } = row.assignee.destination;
        if (groupId) coordinator.cancelRoom(groupId, at, reason);
        else coordinator.cancelDirect(at, reason);
      }
    },
  };
}

/** The intake's stop of a run: its delegated tree first, while the run's own
 * node still holds it together (the routine's interrupt settles that node and
 * leaves a teammate mid-turn running), then the routine run itself. */
export function stopIntakeRun(tree: Pick<ReturnType<typeof runTree>, "stop">, routines: IntakeRoutines, runId: string, reason: string): void {
  const run = routines.list().find((candidate) => candidate.id === runId);
  const since = run?.startedAt ?? run?.createdAt;
  if (run?.threadId && since !== undefined) tree.stop(run.threadId, since, reason);
  routines.cancel(runId, reason).catch((error) => console.error(`github-intake: could not stop run ${runId}`, error));
}

/** The server's routine runs, which the intake reads and stops. */
export interface IntakeRoutines {
  list(): ReadonlyArray<RunReceipt & { id: string; webhookId?: string; deliveryId?: string }>;
  cancel(runId: string, reason: string): Promise<unknown>;
}

export interface LazurioGithubIntakeDeps extends Pick<GithubIntakeOptions, "webhooks" | "bots"> {
  dataDir: string;
  /** The server's workspace maintenance gate: a backup or restore defers deliveries to the next poll. */
  maintenance: { request(): () => void };
  env?: NodeJS.ProcessEnv;
  routines: IntakeRoutines;
  coordinator: RunTreeCoordinator;
}

/** Model-free GitHub polling under this user's signed-in `gh`: real work is
 * handed to one bot through a managed webhook, so it joins the same queue,
 * receipts and untrusted-data wrapping as any webhook delivery. Off unless
 * OMB_GITHUB_INTAKE=1; an unusable setting throws, so the server stops at
 * start with the reason. */
export function createLazurioGithubIntake(deps: LazurioGithubIntakeDeps): { routes: RouteHandler; start(): void; stop(): void; observe(event: { threadId: string }): void } {
  const config = githubIntakeConfigFromEnv(deps.env);
  const tree = runTree(deps.coordinator);
  const intake = config
    ? new GithubIntake({
        config,
        gh: spawnGh(config.ghPath),
        file: join(deps.dataDir, "github-intake.json"),
        webhooks: deps.webhooks,
        bots: deps.bots,
        runState: (runId) => deps.routines.list().find((run) => run.id === runId) ?? null,
        runs: () => deps.routines.list(),
        cancelRun: (runId, reason) => stopIntakeRun(tree, deps.routines, runId, reason),
        progressAt: tree.progressAt,
        workLive: tree.live,
        guard: maintenanceGuard(deps.maintenance),
      })
    : null;
  return {
    routes: createGithubIntakeRoutes({ intake }),
    start: () => intake?.start(),
    stop: () => intake?.stop(),
    observe: (event) => { if (intake) tree.observe(event); },
  };
}
