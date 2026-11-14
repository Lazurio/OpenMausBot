import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const ASK_PERSON_TOOL = {
  name: "ask_person",
  description: "Ask a person in a Chat conversation here; their answer returns automatically. Stable question_id on retries; 2–4 options, recommended first except publication; meanwhile says what continues or waits. Continue independent work, end when blocked. Missing Chat CLI: ask-person-unavailable.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      question_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" },
      question: { type: "string", maxLength: 8000 },
      options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", maxLength: 400 } },
      meanwhile: { type: "string", maxLength: 4000 },
      link: { type: "string", maxLength: 2000 },
    }, required: ["question_id", "question", "options", "meanwhile", "link"],
  },
};
export async function callAskPerson(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/person-questions", { method: "POST", body: JSON.stringify(args) });
  return { text: JSON.stringify(body), ...(!ok || body.error ? { isError: true } : {}) };
}
