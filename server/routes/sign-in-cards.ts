// POST /api/bots/<bot>/sign-in-cards/<message>/(done|cancel) with {threadId}.
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type SignInOutcome = "done" | "cancelled";

type Answer = { status: number; body: Record<string, unknown> };

export interface SignInCardRouteDeps {
  settle(botId: string, threadId: string, messageId: string, outcome: SignInOutcome): Answer;
  /** A member reaches a card only in a thread shown to them, which in a room can be narrower than the bot. */
  threadVisible(auth: RequestAuth, threadId: string): boolean;
}

const HIDDEN: Answer = { status: 404, body: { error: "no such sign-in request" } };

// Lazurio overlay (DEV-6673 M3): no saving a login from the card; the person signs in on the page.
const CARD = /^\/api\/bots\/([\w-]+)\/sign-in-cards\/([\w-]+)\/(done|cancel)$/u;

export function createSignInCardRoutes(deps: SignInCardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = CARD.exec(path);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const threadId = String(body.threadId ?? "");
    const result = deps.threadVisible(auth, threadId) ? deps.settle(m[1]!, threadId, m[2]!, m[3] === "done" ? "done" : "cancelled") : HIDDEN;
    return json(res, result.status, result.body);
  };
}
