// Lazurio overlay (DEV-6673; root decision 0191 points 34 and 41): the right panel's way to a bot's
import { PASS, type RouteHandler } from "./table.ts";

export interface LazurioBrowserRouteDeps {
  /** A bot that exists and is not archived. */
  liveBot(id: string): boolean;
}


export function createLazurioBrowserRoutes(deps: LazurioBrowserRouteDeps): RouteHandler {
    const m = ROUTE.exec(path);
    if (!m) return PASS;
    const botId = m[1]!;
    res.setHeader("cache-control", "no-store");
      return json(res, 200, strip);
    }
  };
}