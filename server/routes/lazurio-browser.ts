// Lazurio overlay (DEV-6673; root decision 0191 points 34 and 41): the right panel's way to a bot's
// tabs in the Environment browser (server/lazurio-environment-browser.ts).
//   GET  /api/bots/<bot>/browser         the bot's strip with each tab's view, or {available: false}
//   POST /api/bots/<bot>/browser/window  the bot's window (`lazurio browser window --session bot-<id>`):
//                                        200 {tab}, 409 unavailable, 502 window-failed
// A member reaches them for the bots shown to them, as every bot route (server/index.ts's gate).
import type { BotBrowserStrip, BotBrowserWindow } from "../../shared/lazurio-browser.ts";
import type { EnvironmentBrowser } from "../lazurio-environment-browser.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LazurioBrowserRouteDeps {
  browser: Pick<EnvironmentBrowser, "strip" | "openWindow">;
  /** A bot that exists and is not archived. */
  liveBot(id: string): boolean;
}

const ROUTE = /^\/api\/bots\/([\w-]+)\/browser(\/window)?$/u;

export function createLazurioBrowserRoutes(deps: LazurioBrowserRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    const m = ROUTE.exec(path);
    if (!m) return PASS;
    const botId = m[1]!;
    const window = m[2] !== undefined;
    if (method !== (window ? "POST" : "GET")) return json(res, 405, { error: "method not allowed" });
    if (!deps.liveBot(botId)) return json(res, 404, { error: "no such bot" });
    res.setHeader("cache-control", "no-store");
    if (!window) {
      const strip: BotBrowserStrip = await deps.browser.strip(botId);
      return json(res, 200, strip);
    }
    const opened = await deps.browser.openWindow(botId);
    if (opened.kind === "unavailable") return json(res, 409, { error: "unavailable" });
    if (opened.kind === "failed") return json(res, 502, { error: "window-failed" });
    const answer: BotBrowserWindow = { tab: opened.tab };
    return json(res, 200, answer);
  };
}
