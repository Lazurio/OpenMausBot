// Lazurio overlay (DEV-6673; root decision 0191 points 34 and 41): the right panel's way to a bot's
// tabs in the Environment browser (server/lazurio-environment-browser.ts), as T3 Code's thread tabs.
//   GET  /api/bots/<bot>/browser          the bot's strip with each tab's view, or {available: false}
//   POST /api/bots/<bot>/browser/hold     {tabId}: the person holds a tab (Nová karta, a link, a page's new tab,
//                                         Vrátit); the strip after
//   POST /api/bots/<bot>/browser/release  {tabId}: the person lets go of a tab (×); the strip after
// Errors are {error: <reason>}: 400 invalid-tab, 404 bot-not-found, 409 unavailable | too-many-tabs,
// 503 holder-unreadable | hold-failed. A member reaches them for the bots shown to them, as every bot route
import type { BotBrowserStrip } from "../../shared/lazurio-browser.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LazurioBrowserRouteDeps {
  browser: Pick<EnvironmentBrowser, "strip" | "hold" | "release">;
  /** A bot that exists and is not archived. */
  liveBot(id: string): boolean;
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
    const m = ROUTE.exec(path);
    if (!m) return PASS;
    const botId = m[1]!;
    const action = m[2] as "hold" | "release" | undefined;
    if (method !== (action ? "POST" : "GET")) return json(res, 405, { error: "method not allowed" });
    if (!deps.liveBot(botId)) return json(res, 404, { error: "bot-not-found" });
    res.setHeader("cache-control", "no-store");
    if (!action) {
      return json(res, 200, strip);
    }
    const body = await readBody(req);
    const tabId = typeof body?.tabId === "string" ? body.tabId : "";
    return "refused" in answer ? json(res, STATUS[answer.refused], { error: answer.refused }) : json(res, 200, answer);
  };
}