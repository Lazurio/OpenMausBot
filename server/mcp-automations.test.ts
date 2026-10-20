// scripts/mcp-server.ts snapshots process.env at import time: scrub ambient OMB_* / OPENMAUSBOT_* values first.
import "./testing/scrub-ambient-omb-env.ts";

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { parseInstant, parseWeekdays } from "../scripts/mcp-automations.ts";
import { handleToolCall, processMcpMessage, TOOLS, ToolInputError } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type Rec = Record<string, any>;

const dir = mkdtempSync(join(tmpdir(), "omb-mcp-automations-"));
afterAll(() => removeTempDir(dir));

const AUTOMATION_TOOLS = ["list_routines", "get_routine", "create_routine", "update_routine", "delete_routine", "run_routine",
  "list_webhooks", "create_webhook", "delete_webhook", "rotate_webhook_secret"];

function api(responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body?: Rec }> = [];
  const fetcher = vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const answer = responses[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    if (method === "POST" && path === "/api/routines") return { routine: { id: "r1", ...JSON.parse(String(init.body)) } };
    if (method === "PATCH") return { routine: { id: path.split("/").at(-1), ...JSON.parse(String(init.body)) } };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { calls, fetcher };
}

const inputError = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolInputError);
  return (error as Error).message;
};

describe("the automation tools in the MCP server", () => {
  it("are listed with flat, closed and annotated schemas", async () => {
    const listed = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })))!).result.tools as Rec[];
    const automation = listed.filter((tool) => AUTOMATION_TOOLS.includes(tool.name));
    expect(automation.map((tool) => tool.name)).toEqual(AUTOMATION_TOOLS);
    for (const tool of automation) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.annotations, tool.name).toBeTruthy();
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/"(oneOf|anyOf|allOf|const|format)"/);
    }
    expect(Object.fromEntries(automation.map((tool) => [tool.name, tool.annotations.readOnlyHint]))).toMatchObject({
      list_routines: true, get_routine: true, list_webhooks: true, create_routine: false, delete_routine: false, rotate_webhook_secret: false,
    });
    expect(listed.find((tool) => tool.name === "delete_routine")!.annotations.destructiveHint).toBe(true);
    expect(TOOLS.map((tool) => tool.name)).toEqual(listed.map((tool) => tool.name));
  });

  it("creates a routine from a model's loose input: inferred schedule, short days, a one-digit hour", async () => {
    const { calls, fetcher } = api();
    expect(await handleToolCall("create_routine", { bot_id: "b1", name: " Brief ", prompt: "Report.", time: "8:30", weekdays: ["Mon", "wed", 5] }, fetcher))
      .toEqual({ success: true, routine: expect.objectContaining({ id: "r1", name: "Brief" }) });
    await handleToolCall("create_routine", { bot_id: "b1", name: "Monthly", prompt: "x", cron: "0 9 1 * *", time_zone: "Asia/Kolkata", run_on_startup: true }, fetcher);
    expect(calls.map((call) => call.body)).toEqual([
      { name: "Brief", prompt: "Report.", botId: "b1", schedule: { type: "daily", time: "08:30", weekdays: [1, 3, 5] } },
      { name: "Monthly", prompt: "x", botId: "b1", schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "Asia/Kolkata" }, runOnStartup: true },
    ]);
  });

  it("reads days, ranges that wrap and dates with an offset", () => {
    expect(parseWeekdays(["mon-fri"])).toEqual([1, 2, 3, 4, 5]);
    expect(parseWeekdays(["fri-mon"])).toEqual([0, 1, 5, 6]);
    expect(parseWeekdays(["weekend", "Wednesday", "2"])).toEqual([0, 2, 3, 6]);
    expect(parseInstant("2026-11-02T09:00+01:00", "at")).toBe(Date.UTC(2026, 10, 2, 8));
    expect(parseInstant("2026-11-02 08:00:00.250z", "at")).toBe(Date.UTC(2026, 10, 2, 8, 0, 0, 250));
    expect(parseInstant("1792501051521", "at")).toBe(1792501051521);
    for (const bad of ["2026-11-02T09:00:00", "2026-02-30T09:00:00Z", "2026-11-02T24:00:00Z", "tomorrow"]) {
      expect(() => parseInstant(bad, "at"), bad).toThrow("at must be a date and time with its offset");
    }
  });

  it("teaches the shape of a schedule instead of guessing one", async () => {
    const { calls, fetcher } = api();
    const base = { bot_id: "b1", name: "R", prompt: "x" };
    expect(await inputError(handleToolCall("create_routine", base, fetcher))).toContain("a routine needs a schedule, for example {\"schedule\":\"daily\"");
    expect(await inputError(handleToolCall("create_routine", { ...base, schedule: "once", time: "09:00" }, fetcher))).toBe("time does not belong to once schedules, which take at");
    expect(await inputError(handleToolCall("create_routine", { ...base, schedule: "weekly", time: "09:00" }, fetcher))).toContain("weekly schedules need time and weekdays");
    expect(await inputError(handleToolCall("create_routine", { ...base, cron: "0 9 * * *" }, fetcher))).toContain("cron schedules need cron and time_zone");
    expect(await inputError(handleToolCall("create_routine", { ...base, at: "2099-01-01T09:00:00Z", every_minutes: 30 }, fetcher)))
      .toContain("these fields belong to different schedules (once, interval)");
    expect(await inputError(handleToolCall("create_routine", { ...base, weekdays: ["mon"] }, fetcher))).toContain("weekdays needs a daily, weekly or interval schedule");
    expect(await inputError(handleToolCall("create_routine", { ...base, every_minutes: 30, window_start: "09:00" }, fetcher))).toContain("window_start and window_end go together");
    expect(await inputError(handleToolCall("create_routine", { ...base, at: "2001-01-01T09:00:00Z" }, fetcher))).toBe("at must be in the future");
    expect(await inputError(handleToolCall("create_routine", { ...base, every_minutes: 4 }, fetcher))).toContain("every_minutes must be at least 5");
    expect(calls).toEqual([]);
  });

  it("replaces a schedule whole on update, clears what null clears, and moves a room goal back to its bot", async () => {
    const { calls, fetcher } = api();
    await handleToolCall("update_routine", { routine_id: "r1", every_minutes: 120, starts_at: "2099-01-01T08:00:00Z", timeout_minutes: null, results_thread_id: "main" }, fetcher);
    await handleToolCall("update_routine", { routine_id: "r1", channel_id: null, enabled: false }, fetcher);
    expect(calls).toEqual([
      { method: "PATCH", path: "/api/routines/r1", body: {
        schedule: { type: "interval", everyMinutes: 120, anchorAt: Date.UTC(2099, 0, 1, 8), weekdays: null, window: null, endsAt: null },
        timeoutMinutes: null, resultsThreadId: null,
      } },
      { method: "PATCH", path: "/api/routines/r1", body: { target: "bot", groupId: null, enabled: false } },
    ]);
    expect(await inputError(handleToolCall("update_routine", { routine_id: "r1" }, fetcher))).toContain("give at least one field to change");
  });

  it("checks a room goal's lead against the room before writing", async () => {
    const fleet = { bots: [{ id: "b1", name: "Henry" }, { id: "b2", name: "Ada" }], groups: [{ id: "g1", name: "Launch", memberIds: ["b1"] }, { id: "d1", dm: true, memberIds: ["b1", "b2"] }] };
    const { calls, fetcher } = api({ "GET /api/bots?messages=0": fleet, "GET /api/routines": { routines: [{ id: "r1", botId: "b2" }], runs: [] } });
    await handleToolCall("create_routine", { bot_id: "b1", channel_id: "g1", name: "Goal", prompt: "x", schedule: "daily", time: "09:00" }, fetcher);
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { botId: "b1", target: "room-goal", groupId: "g1" } });
    expect(await inputError(handleToolCall("update_routine", { routine_id: "r1", channel_id: "g1" }, fetcher)))
      .toBe("bot b2 is not in the room \"Launch\": a room goal's bot_id must be one of its members, Henry (b1)");
    expect(await inputError(handleToolCall("create_routine", { bot_id: "b1", channel_id: "d1", name: "Goal", prompt: "x", time: "09:00" }, fetcher)))
      .toContain("channel_id d1 is not a room");
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });

  it("lists routines without prompts, reads one with its latest runs, and names a gone one", async () => {
    const routines = [{ id: "r1", name: "A", botId: "b1", prompt: "long", attachments: [{ id: "f" }] }, { id: "r2", name: "B", botId: "b2", prompt: "x" }];
    const runs = [{ id: "u3", routineId: "r1", prompt: "long", attachments: [], status: "running" }, { id: "u2", routineId: "r2" }, { id: "u1", routineId: "r1", status: "completed" }];
    const gone = Object.assign(new Error("OpenMausBot API error (404): {\"error\":\"no such routine\"}"), { status: 404 });
    const { fetcher } = api({ "GET /api/routines": { routines, runs }, "DELETE /api/routines/r9": gone, "POST /api/routines/r9/run": gone });
    expect(await handleToolCall("list_routines", { bot_id: "b1" }, fetcher)).toEqual({ routines: [{ id: "r1", name: "A", botId: "b1", attachmentCount: 1 }] });
    expect(await handleToolCall("get_routine", { routine_id: "r1", runs: 5 }, fetcher)).toEqual({
      routine: routines[0], runs: [{ id: "u3", routineId: "r1", status: "running" }, { id: "u1", routineId: "r1", status: "completed" }],
    });
    for (const [tool, args] of [["get_routine", { routine_id: "r9" }], ["delete_routine", { routine_id: "r9" }], ["run_routine", { routine_id: "r9" }]] as const) {
      await expect(handleToolCall(tool, args, fetcher)).rejects.toThrow("Routine not found: r9 (list_routines lists them)");
    }
  });
});

describe("webhook secrets in the MCP server", () => {
  const SECRET = "whsec_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const answer = (id = "w1") => ({
    webhook: { id, endpointId: "wh_1", name: "Deploys", botId: "b1" }, ingress: { available: true, baseUrl: "http://127.0.0.1:4103" },
    credential: { endpointUrl: "http://127.0.0.1:4103/hooks/wh_1", secret: SECRET, url: `http://127.0.0.1:4103/hooks/wh_1/${SECRET}` },
  });

  it("refuses to make a secret that would go nowhere, or into a file it would overwrite, before asking the server", async () => {
    const { calls, fetcher } = api();
    const taken = join(dir, "taken");
    writeFileSync(taken, "old\n");
    expect(await inputError(handleToolCall("create_webhook", { bot_id: "b1", name: "Deploys" }, fetcher))).toContain("pass show_secret true to see it, or secret_file");
    expect(await inputError(handleToolCall("create_webhook", { bot_id: "b1", name: "Deploys", secret_file: taken }, fetcher))).toContain("already exists: pass replace_secret_file true");
    expect(await inputError(handleToolCall("rotate_webhook_secret", { webhook_id: "w1", secret_file: join(dir, "no", "such", "folder") }, fetcher))).toContain("does not exist");
    expect(await inputError(handleToolCall("rotate_webhook_secret", { webhook_id: "w1", secret_file: dir }, fetcher))).toContain("is not a regular file");
    expect(await inputError(handleToolCall("rotate_webhook_secret", { webhook_id: "w1", secret_file: "/dev/stdout" }, fetcher))).toContain("never a terminal");
    expect(await inputError(handleToolCall("create_webhook", { bot_id: "b1", name: "Deploys", show_secret: true, replace_secret_file: true }, fetcher))).toBe("replace_secret_file goes with secret_file");
    expect(readFileSync(taken, "utf8")).toBe("old\n");
    expect(calls).toEqual([]);
  });

  it("keeps the secret out of the result unless show_secret, and saves it to a private file when asked", async () => {
    const { calls, fetcher } = api({ "POST /api/webhooks": answer(), "POST /api/webhooks/w1/rotate": answer() });
    const file = join(dir, "deploys.secret");
    const saved = await handleToolCall("create_webhook", { bot_id: "b1", name: "Deploys", event_types: ["push"], delivery: "post", enabled: false, secret_file: file }, fetcher);
    expect(saved).toEqual({ success: true, webhook: answer().webhook, ingress: answer().ingress, credential: { endpointUrl: "http://127.0.0.1:4103/hooks/wh_1", secretFile: file } });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(readFileSync(file, "utf8")).toBe(`${SECRET}\n`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(calls[0]).toEqual({ method: "POST", path: "/api/webhooks", body: { name: "Deploys", prompt: "", botId: "b1", eventTypes: ["push"], delivery: "post", enabled: false } });

    writeFileSync(file, "stale\n", { mode: 0o644 });
    const both = await handleToolCall("rotate_webhook_secret", { webhook_id: "w1", show_secret: true, secret_file: file, replace_secret_file: true }, fetcher) as Rec;
    expect(both.credential).toEqual({ endpointUrl: "http://127.0.0.1:4103/hooks/wh_1", secret: SECRET, url: `http://127.0.0.1:4103/hooks/wh_1/${SECRET}`, secretFile: file });
    expect(readFileSync(file, "utf8")).toBe(`${SECRET}\n`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lists webhooks with their address and deletes one", async () => {
    const gone = Object.assign(new Error("OpenMausBot API error (404): {\"error\":\"no such webhook\"}"), { status: 404 });
    const { fetcher } = api({
      "GET /api/webhooks": { webhooks: [{ id: "w1", endpointId: "wh_1", botId: "b1" }, { id: "w2", endpointId: "wh_2", botId: "b2" }], attempts: [{ id: "a" }], ingress: { available: true, baseUrl: "http://127.0.0.1:4103/" } },
      "DELETE /api/webhooks/w1": { ok: true }, "DELETE /api/webhooks/w9": gone,
    });
    expect(await handleToolCall("list_webhooks", { bot_id: "b2" }, fetcher)).toEqual({
      webhooks: [{ id: "w2", endpointId: "wh_2", botId: "b2", endpointUrl: "http://127.0.0.1:4103/hooks/wh_2" }], ingress: { available: true, baseUrl: "http://127.0.0.1:4103/" },
    });
    expect(await handleToolCall("delete_webhook", { webhook_id: "w1" }, fetcher)).toEqual({ success: true, webhookId: "w1" });
    await expect(handleToolCall("delete_webhook", { webhook_id: "w9" }, fetcher)).rejects.toThrow("Webhook not found: w9 (list_webhooks lists them)");
  });

  it("answers a bad call over JSON-RPC as invalid params, as every other tool does", async () => {
    const response = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_webhook", arguments: { bot_id: "b1", name: "Deploys" } },
    })))!);
    expect(response.error).toMatchObject({ code: -32602, message: expect.stringContaining("shown only once") });
  });
});
