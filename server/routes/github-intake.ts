// GET /api/github-intake: what the Lazurio GitHub intake is doing (state,
// account, target bot, recent events). POST /api/github-intake/poll: poll
// GitHub now instead of waiting for the interval. Admin-scoped by default
// (server/request-auth.ts lists no client rule for them). See
// docs/lazurio-github-intake.md.
import type { GithubIntake } from "../github-intake.ts";
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
