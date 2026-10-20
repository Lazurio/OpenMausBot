// Lazurio overlay (DEV-6673; root decision 0191 points 34 and 41): the right panel's way to a bot's
// tabs in the Environment browser (server/lazurio-environment-browser.ts), as T3 Code's thread tabs.
//   GET  /api/bots/<bot>/browser          the bot's strip with each tab's view, or {available: false}
//   POST /api/bots/<bot>/browser/hold     {tabId}: the person holds a tab (Nová karta, a link, a page's new tab,
//                                         Vrátit); the strip after
//   POST /api/bots/<bot>/browser/release  {tabId}: the person lets go of a tab (×); the strip after
// Errors are {error: <reason>}: 400 invalid-tab, 404 bot-not-found, 409 unavailable | too-many-tabs,
// 503 holder-unreadable | hold-failed. A member reaches them for the bots shown to them, as every bot route
// (server/index.ts's gate), and each tab names only the other holders that member may see (StripAudience).
import type { BotBrowserStrip } from "../../shared/lazurio-browser.ts";
import type { Viewer, VisibleSet } from "../bot-visibility.ts";
import type { BotTabRefusal, EnvironmentBrowser, StripAudience } from "../lazurio-environment-browser.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LazurioBrowserRouteDeps {
  browser: Pick<EnvironmentBrowser, "strip" | "hold" | "release">;
  /** A bot that exists and is not archived. */
  liveBot(id: string): boolean;
  /** Who is asking, by the rules that gate `/api/bots/<bot>`. */
  audience(auth: RequestAuth): StripAudience;
}

/** Who asks, as the strip names other holders to them: the bots `visible` shows this viewer (the rules that gate
 * `/api/bots/<bot>`), and everything only for whoever sees everything (the owner, an admin, a local service). A
 * member who happens to see every bot still sees no T3 Code thread's name, whose audience MausBot does not know. */
export function stripAudienceOf(viewer: Viewer, visible: Pick<VisibleSet, "bot">): StripAudience {
  return { everything: viewer.kind === "all", bot: (id) => visible.bot(id) };
}

const ROUTE = /^\/api\/bots\/([\w-]+)\/browser(?:\/(hold|release))?$/u;

const STATUS: Record<BotTabRefusal, number> = {
  "invalid-tab": 400,
  "bot-not-found": 404,
  unavailable: 409,
  "too-many-tabs": 409,
  "holder-unreadable": 503,
  "hold-failed": 503,
};

export function createLazurioBrowserRoutes(deps: LazurioBrowserRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = ROUTE.exec(path);
    if (!m) return PASS;
    const botId = m[1]!;
    const action = m[2] as "hold" | "release" | undefined;
    if (method !== (action ? "POST" : "GET")) return json(res, 405, { error: "method not allowed" });
    if (!deps.liveBot(botId)) return json(res, 404, { error: "bot-not-found" });
    res.setHeader("cache-control", "no-store");
    const audience = deps.audience(auth);
    if (!action) {
      const strip: BotBrowserStrip = await deps.browser.strip(botId, audience);
      return json(res, 200, strip);
    }
    const body = await readBody(req);
    const tabId = typeof body?.tabId === "string" ? body.tabId : "";
    const answer = await deps.browser[action](botId, tabId, audience);
    return "refused" in answer ? json(res, STATUS[answer.refused], { error: answer.refused }) : json(res, 200, answer);
  };
}
