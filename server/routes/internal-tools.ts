// The agents tools' internal calls that need only the capability's bot, its body and its folders: the helper models'
// decide and extract, and MausBot's notifications. Runs inside index.ts's /api/internal/ block, after the
// capability bearer is checked; each route answers its own paths and passes the rest on.
import { createHelperToolRoutes, type HelperToolContext, type HelperToolDeps } from "./helper-tools.ts";
import { createMausBotNotificationRoutes, type LiveNotificationsDeps } from "./mausbot-notifications.ts";
import { PASS } from "./table.ts";

export function createInternalToolRoutes(deps: { helpers: HelperToolDeps; notifications: LiveNotificationsDeps }) {
  const routes = [createHelperToolRoutes(deps.helpers), createMausBotNotificationRoutes(deps.notifications)];
  return async (ctx: HelperToolContext): Promise<typeof PASS | void> => {
    for (const route of routes) if (await route(ctx) !== PASS) return;
    return PASS;
  };
}
