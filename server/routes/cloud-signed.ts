// The Admin's signed requests to a Cloud home. They run before the session gate: the signature is the credential. Never
// log their headers, bodies or codes. A bad pairing signature counts against the pairing lockout; a health read opens
// nothing, so each route has its own nonces and never locks the Admin out of pairing.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoxReport } from "../bot-box/box.ts";
import { boxSummary } from "../cloud-health.ts";
import { CLOUD_HEALTH_PATH, CLOUD_PAIRING_PATH, createCloudPairing, createCloudRequestVerifier, readSignedBody } from "../cloud-home.ts";
import { teamMemberEmail, type CloudTeam } from "../cloud-team.ts";
import type { CloudHealth } from "../cloud-health.ts";
import { json } from "../harness/http.ts";
import { requestSource } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedRequest { req: IncomingMessage; res: ServerResponse; url: URL; path: string; method: string }

/** The bot box's self-report (server/bot-box): `{ box: "bwrap" | "off" | …, checks: "n/n" }`, read like health. */
export const CLOUD_BOX_PATH = "/api/cloud/box";

/** A Team Cloud's member left (removed, or they left): `{ email }`, signed with the body. What was
 * theirs alone is deleted here (host/team-member-left.ts). */
export const CLOUD_TEAM_MEMBER_LEFT_PATH = "/api/cloud/team/member-left";

export function createCloudSignedRoutes(deps: {
  secret: string;
  sessions: Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  /** A Team Cloud: every pairing body must carry the Admin's member claim (cloud-team.ts). */
  team?: CloudTeam | null;
  health: Pick<CloudHealth, "report">;
  /** The bot box's report; absent on a server without one. */
  box?: () => BoxReport;
  /** A Team Cloud's member left: delete what was theirs alone; absent on a My Cloud. */
  memberLeft?: ((email: string) => Promise<Record<string, unknown>>) | null;
  now?: () => number;
}) {
  const pairing = createCloudPairing({ secret: deps.secret, sessions: deps.sessions, team: deps.team ?? null, now: deps.now });
  const healthRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const boxReads = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const memberLeftRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  /** True when the request was one of these and has been answered. */
  return async ({ req, res, url, path, method }: CloudSignedRequest): Promise<boolean> => {
    const memberLeft = path === CLOUD_TEAM_MEMBER_LEFT_PATH && deps.team ? deps.memberLeft ?? null : null;
    if (path !== CLOUD_PAIRING_PATH && path !== CLOUD_HEALTH_PATH && path !== CLOUD_BOX_PATH && !memberLeft) return false;
    res.setHeader("cache-control", "no-store");
    const source = requestSource(req);
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : undefined; };
    const signed = { timestamp: header("x-omb-cloud-timestamp"), nonce: header("x-omb-cloud-nonce"), signature: header("x-omb-cloud-signature") };
    if (memberLeft) {
      if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { json(res, 415, { error: "send the request as JSON (content-type: application/json)" }); return true; }
      const body = await readSignedBody(req);
      const verdict = memberLeftRequests.verify({ ...signed, method, target: `${path}${url.search}`, body });
      if (!verdict.ok) { console.warn(`team member-left request refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { json(res, 400, { error: "invalid_body" }); return true; }
      const email = teamMemberEmail((parsed as { email?: unknown } | null)?.email);
      if (!email) { json(res, 400, { error: "invalid_member" }); return true; }
      json(res, 200, { ok: true, ...(await memberLeft(email)) });
      return true;
    }
    if (path === CLOUD_BOX_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = boxReads.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) { console.warn(`bot box report read refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      json(res, 200, { v: 1, at: (deps.now ?? Date.now)(), ...(boxSummary(deps.box?.()) ?? { box: "off", reason: "not-cloud", checks: null, failed: [], boxed: 0, refused: { egress: 0, harness: 0 }, broker: { on: false, tokens: 0, forwarded: 0, refused: 0, unbrokered: [] }, hardening: { seccomp: "off", denied: 0, hidepid: false, flyApiPrivate: true } }) });
      return true;
    }
    if (path === CLOUD_HEALTH_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = healthRequests.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) {
        console.warn(`cloud health refused from ${source}: ${verdict.error}`);
        json(res, verdict.status, { error: verdict.error });
        return true;
      }
      json(res, 200, deps.health.report(url.searchParams.get("after")));
      return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      json(res, 415, { error: "send the pairing request as JSON (content-type: application/json)" });
      return true;
    }
    const result = pairing.handle({ ...signed, body: await readSignedBody(req), source });
    if (result.status !== 200) console.warn(`cloud pairing refused from ${source}: ${String(result.body.error)}`);
    json(res, result.status, result.body);
    return true;
  };
}
