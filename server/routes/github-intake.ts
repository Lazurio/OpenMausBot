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

/** The latest sign of progress of a run: a runtime event in its conversation's
 * thread, or progress of the work that conversation handed out and still waits
 * on, at any depth. */
export function runProgress(delegations: (threadId: string) => ReadonlyArray<{ threadId: string; createdAt: number; startedAt?: number; lastProgressAt?: number }>, now: () => number = Date.now) {
  const events = new Map<string, number>();
  return {
    observe(event: { threadId: string }): void {
      if (events.size >= 10_000) events.clear();
      events.set(event.threadId, now());
    },
    progressAt(threadId: string): number | undefined {
      let latest = events.get(threadId);
      const seen = new Set([threadId]);
      const pending = [threadId];
      while (pending.length && seen.size < 1_000) {
        for (const work of delegations(pending.pop()!)) {
          latest = Math.max(latest ?? 0, work.lastProgressAt ?? work.startedAt ?? work.createdAt, events.get(work.threadId) ?? 0);
          if (!seen.has(work.threadId)) { seen.add(work.threadId); pending.push(work.threadId); }
        }
      }
      return latest;
    },
  };
}

export interface LazurioGithubIntakeDeps extends Pick<GithubIntakeOptions, "webhooks" | "bots" | "runState" | "runs" | "cancelRun"> {
  dataDir: string;
  /** The server's workspace maintenance gate: a backup or restore defers deliveries to the next poll. */
  maintenance: { request(): () => void };
  env?: NodeJS.ProcessEnv;
  /** The work a conversation handed out and still waits on (the coordinator's `outstandingFor`). */
  delegations: Parameters<typeof runProgress>[0];
}

/** Model-free GitHub polling under this user's signed-in `gh`: real work is
 * handed to one bot through a managed webhook, so it joins the same queue,
 * receipts and untrusted-data wrapping as any webhook delivery. Off unless
 * OMB_GITHUB_INTAKE=1; an unusable setting throws, so the server stops at
 * start with the reason. */
export function createLazurioGithubIntake(deps: LazurioGithubIntakeDeps): { routes: RouteHandler; start(): void; stop(): void; observe(event: { threadId: string }): void } {
  const config = githubIntakeConfigFromEnv(deps.env);
  const progress = runProgress(deps.delegations);
  const intake = config
    ? new GithubIntake({
        config,
        gh: spawnGh(config.ghPath),
        file: join(deps.dataDir, "github-intake.json"),
        webhooks: deps.webhooks,
        bots: deps.bots,
        runState: deps.runState,
        runs: deps.runs,
        cancelRun: deps.cancelRun,
        progressAt: progress.progressAt,
        guard: maintenanceGuard(deps.maintenance),
      })
    : null;
  return {
    routes: createGithubIntakeRoutes({ intake }),
    start: () => intake?.start(),
    stop: () => intake?.stop(),
    observe: (event) => { if (intake) progress.observe(event); },
  };
}
