import { PASS, type RouteHandler } from "./table.ts";

export interface BotLifecycleRouteDeps {
  deleteBotWithLifecycle(botId: string): Promise<{ status: number; body: unknown }>;
}

export function createBotLifecycleRoutes(deps: BotLifecycleRouteDeps): RouteHandler {
  const { deleteBotWithLifecycle } = deps;
  return async ({ res, path, method, json }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const result = await deleteBotWithLifecycle(m[1]);
      return json(res, result.status, result.body);
    }
    return PASS;
  };
}
