// Lazurio overlay: the GitHub intake's routes and wiring (server/github-intake.ts,
// docs/lazurio-github-intake.md). GET /api/github-intake: what the intake is
// doing (state, account, target bot, recent events). POST
// /api/github-intake/poll: poll GitHub now instead of waiting for the
// interval. Admin-scoped by default (server/request-auth.ts lists no client
// rule for them). index.ts builds it once, pushes `routes` into ROUTES, and
// starts polling once the server listens.
import { join } from "node:path";

import { GithubIntake, githubIntakeConfigFromEnv, spawnGh, type GithubIntakeOptions } from "../github-intake.ts";
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

export interface LazurioGithubIntakeDeps extends Pick<GithubIntakeOptions, "webhooks" | "bots" | "runState" | "runs"> {
  dataDir: string;
  /** The server's workspace maintenance gate: a backup or restore defers deliveries to the next poll. */
  maintenance: { request(): () => void };
  env?: NodeJS.ProcessEnv;
}

/** Model-free GitHub polling under this user's signed-in `gh`: real work is
 * handed to one bot through a managed webhook, so it joins the same queue,
 * receipts and untrusted-data wrapping as any webhook delivery. Off unless
 * OMB_GITHUB_INTAKE=1; an unusable setting throws, so the server stops at
 * start with the reason. */
export function createLazurioGithubIntake(deps: LazurioGithubIntakeDeps): { routes: RouteHandler; start(): void; stop(): void } {
  const config = githubIntakeConfigFromEnv(deps.env);
  const intake = config
    ? new GithubIntake({
        config,
        gh: spawnGh(config.ghPath),
        file: join(deps.dataDir, "github-intake.json"),
        webhooks: deps.webhooks,
        bots: deps.bots,
        runState: deps.runState,
        runs: deps.runs,
        guard: maintenanceGuard(deps.maintenance),
      })
    : null;
  return {
    routes: createGithubIntakeRoutes({ intake }),
    start: () => intake?.start(),
    stop: () => intake?.stop(),
  };
}
