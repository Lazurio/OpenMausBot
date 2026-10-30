// Lazurio overlay: the WhatsApp intake's routes and wiring. GET
// /api/whatsapp-intake: what the intake is doing (state, follower, groups,
// recent actions). POST /api/whatsapp-intake/catch-up: read the mapped groups
// now instead of waiting for the next catch-up. Admin-scoped by default
// (request-auth lists no client rule for them).
import { join } from "node:path";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { WhatsappIntake, type WhatsappIntakeOptions } from "../whatsapp-intake.ts";
import { loadGroupMap, whatsappIntakeConfigFromEnv } from "../whatsapp-intake-config.ts";
import { spawnWacli } from "../whatsapp-intake-wacli.ts";
import { maintenanceGuard } from "./github-intake.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WhatsappIntakeRouteDeps {
  intake: Pick<WhatsappIntake, "status" | "catchUp"> | null;
}

export function createWhatsappIntakeRoutes(deps: WhatsappIntakeRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/whatsapp-intake" && path !== "/api/whatsapp-intake/catch-up") return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/whatsapp-intake" && method === "GET") {
      return json(res, 200, deps.intake ? deps.intake.status() : { enabled: false });
    }
    if (path === "/api/whatsapp-intake/catch-up" && method === "POST") {
      if (!deps.intake) return json(res, 409, { error: "The WhatsApp intake is off. Set OMB_WHATSAPP_INTAKE=1 and its settings, then restart the server." });
      const summary = await deps.intake.catchUp();
      return json(res, 200, { summary, status: deps.intake.status() });
    }
    return json(res, 405, { error: "method not allowed" });
  };
}

export interface LazurioWhatsappIntakeDeps extends Pick<WhatsappIntakeOptions, "webhooks" | "bots" | "runState"> {
  dataDir: string;
  /** The server's workspace maintenance gate: a backup or restore defers deliveries and state writes. */
  maintenance: { request(): () => void };
  env?: NodeJS.ProcessEnv;
}

/** Model-free WhatsApp group handling for one support bot through managed webhooks. Off unless
 * OMB_WHATSAPP_INTAKE=1; an unusable setting or group map throws, so the server stops at start with the reason. */
export function createLazurioWhatsappIntake(deps: LazurioWhatsappIntakeDeps): {
  routes: RouteHandler; start(): void; stop(): Promise<void>; observe(event: RuntimeEvent): void;
} {
  const config = whatsappIntakeConfigFromEnv(deps.env);
  const intake = config
    ? new WhatsappIntake({
        config,
        map: loadGroupMap(config.groupsFile),
        wacli: spawnWacli({ ...(config.wacliPath ? { bin: config.wacliPath } : {}), ...(config.store ? { store: config.store } : {}), maxDbSize: config.maxDbSize }),
        file: join(deps.dataDir, "whatsapp-intake.json"),
        webhooks: deps.webhooks,
        bots: deps.bots,
        runState: deps.runState,
        guard: maintenanceGuard(deps.maintenance),
      })
    : null;
  return {
    routes: createWhatsappIntakeRoutes({ intake }),
    start: () => { void intake?.start(); },
    stop: async () => { await intake?.stop(); },
    observe: (event) => intake?.observe(event),
  };
}
