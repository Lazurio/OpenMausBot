import type { PersonQuestions } from "../lazurio-person-questions.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Refresh reads the authoritative T3 request; callers cannot supply or attest an answer. */
export function createPersonQuestionRoutes(questions: PersonQuestions): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/person-questions\/([a-f0-9]{64})\/refresh$/.exec(path);
    if (!match) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "forbidden" });
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req);
    if (!body || Object.keys(body).length) return json(res, 400, { error: "refresh-takes-no-answer" });
    if (!questions.get(match[1]!)) return json(res, 404, { error: "question-not-found" });
    const result = await questions.refresh(match[1]!);
    res.setHeader("cache-control", "no-store");
    return json(res, result.status === "pending" || result.status === "rejected" ? 503 : 200, { status: result.status, questionId: match[1], source: result.receipt.source });
  };
}

export function createPersonQuestionInternalRoute(questions: PersonQuestions, botName: (id: string) => string, card: (input: import("../lazurio-person-questions.ts").PersonQuestionInput) => void) {
  return async (ctx: { method: string; path: string; res: import("node:http").ServerResponse; json: typeof import("../harness/http.ts").json; botId: string; threadId: string; instanceId: string; readBody(): Promise<unknown> }) => {
    if (ctx.path !== "/api/internal/person-questions") return PASS;
    if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
    const body = await ctx.readBody() as Record<string, unknown> | null;
    if (!body || typeof body.question_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(body.question_id) ||
        typeof body.question !== "string" || !body.question.trim() || body.question.length > 8000 ||
        typeof body.meanwhile !== "string" || !body.meanwhile.trim() || body.meanwhile.length > 4000 ||
        typeof body.link !== "string" || !/^https:\/\/\S+$/.test(body.link) || body.link.length > 2000 ||
        !Array.isArray(body.options) || body.options.length < 2 || body.options.length > 4 || body.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 400)) return ctx.json(ctx.res, 400, { error: "invalid-person-question" });
    const input = { botId: ctx.botId, botName: botName(ctx.botId), threadId: ctx.threadId, instanceId: ctx.instanceId,
      requestId: `person-${body.question_id}`, question: `${body.question}\n\nMeanwhile: ${body.meanwhile}\n${body.link}`,
      questions: [{ question: body.question, options: (body.options as string[]).map((label) => ({ label })) }] };
    let result;
    try { result = await questions.open(input, () => card(input)); }
    catch (error) { return ctx.json(ctx.res, error instanceof Error && error.message === "question-id-conflict" ? 409 : 503, { error: error instanceof Error && error.message === "question-id-conflict" ? "question-id-conflict" : "ask-person-storage-failed" }); }
    return ctx.json(ctx.res, result.error ? 503 : 200, { questionId: result.id, threadId: result.t3ThreadId, link: result.link, ...(result.error ? { error: result.error } : {}) });
  };
}
