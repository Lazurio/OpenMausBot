import { describe, expect, it } from "vitest";

import { callTriggerTool } from "./agents-call-triggers.ts";
import type { ToolCallContext } from "./agents-call.ts";

function context(answers: { api?: unknown; response?: { ok: boolean; status: number; body: Record<string, unknown> } } = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = {
    api: async (path: string) => { calls.push({ path }); return answers.api ?? {}; },
    apiResponse: async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return answers.response ?? { ok: true, status: 201, body: { resultId: "t-1", summary: "When an email arrives in Gmail from acme.com, Scout follows: Draft." } };
    },
  };
  return { calls, context: { botId: "scout", threadId: "thread-1", depth: 0, externalRuntime: false, sharedComputers: false, client } as unknown as ToolCallContext };
}

describe("a schedule's confirmation, in the person's words", () => {
  // tomorrow at 9:00 in India, from today's date there
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(Date.now());
  const nextRunAt = Date.parse(`${today}T03:30:00Z`) + 86_400_000;
  const applied = (action: string) => context({ response: { ok: true, status: 201, body: {
    result: { resultId: "r-1" }, nextRunAt, timeZone: "Asia/Calcutta",
    summary: `${action === "create" ? "Create routine" : "Update routine"} “AI news” · weekdays at 9:00 India time · Bot’s current model, where it usually works · no run limit`,
  } } });
  const schedule = { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] };

  it("asks for what was assumed, with the time zone as people say it and the first run in words", async () => {
    const result = await callTriggerTool("create_trigger", { when: "schedule", name: "AI news", instructions: "Send five bullets of AI news.", schedule }, applied("create").context);
    expect(result.isError).toBeUndefined();
    expect(result.text).not.toContain("Asia/Calcutta");
    expect(result.text).toMatch(/tell the person what you set up and what you assumed: when it runs, saying the time zone as "India time", never as a zone id; where its results will appear \(here in this chat\); what each run covers; and that the first run is tomorrow \(\w+, \w+ \d+\) at 9:00 AM India time\.$/);
  });

  it("says what changed and the next run for an update, and one sentence for the rest", async () => {
    const update = await callTriggerTool("manage_trigger", { trigger_id: "r-1", action: "update", changes: { schedule } }, applied("update").context);
    expect(update.text).toMatch(/Tell the person in one plain sentence what changed, saying the time zone as "India time", and that the next run is tomorrow/);
    const paused = await callTriggerTool("manage_trigger", { trigger_id: "r-1", action: "pause" }, context({ response: { ok: true, status: 201, body: { result: { resultId: "r-1" }, nextRunAt: null, timeZone: "Asia/Calcutta" } } }).context);
    expect(paused.text).toMatch(/Tell the person in one sentence what will happen\.$/);
  });
});
