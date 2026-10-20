import "../testing/scrub-ambient-omb-env.ts";

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;

const dir = mkdtempSync(join(tmpdir(), "omb-automations-cli-"));
afterAll(() => removeTempDir(dir));

const SECRET = "whsec_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const refused = (status: number, error: string) => Object.assign(new Error(`OpenMausBot API error (${status}): ${JSON.stringify({ error })}`), { status });

/** The workspace's routine and webhook routes, in memory: what the CLI sends through the real MCP tools, and what it reads. */
function workspace() {
  const bots: Rec[] = [
    { id: "b-henry", name: "Henry", title: "Chief of Staff", section: "Steward", chiefOfStaff: true, threadId: "t-henry", tasks: [{ threadId: "t-henry", title: "Main" }],
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } },
    { id: "b-ada", name: "Ada", threadId: "t-ada", tasks: [{ threadId: "t-ada", title: "Main" }] },
    { id: "b-twin-1", name: "Twin", threadId: "t-twin-1", tasks: [] },
    { id: "b-twin-2", name: "twin", threadId: "t-twin-2", tasks: [] },
  ];
  const groups: Rec[] = [{ id: "g-launch", name: "Launch", memberIds: ["b-henry", "b-ada"], threadId: "t-launch", tasks: [] }];
  const routines: Rec[] = [
    { id: "r-brief", name: "Morning brief", prompt: "Summarize the night.", target: "bot", botId: "b-henry", enabled: true,
      schedule: { type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: Date.UTC(2026, 10, 2, 7, 30), attachments: [], updatedAt: 1 },
    { id: "r-tidy", name: "Tidy", prompt: "Tidy up.", target: "bot", botId: "b-ada", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 },
      nextRunAt: null, updatedAt: 1 },
  ];
  const runs: Rec[] = [
    { id: "run-2", routineId: "r-brief", status: "completed", scheduledFor: 2, prompt: "Summarize the night.", output: "All quiet." },
    { id: "run-x", routineId: "r-tidy", status: "failed", scheduledFor: 3 },
    { id: "run-1", routineId: "r-brief", status: "failed", scheduledFor: 1, error: "engine unavailable" },
  ];
  const webhooks: Rec[] = [
    { id: "w-deploy", endpointId: "wh_deploy", name: "Deploys", prompt: "Check the deploy.", botId: "b-henry", enabled: true, deliveryCount: 3, eventTypes: ["push"] },
  ];
  const ingress = { available: true, baseUrl: "http://127.0.0.1:18800" };
  const writes: Array<{ method: string; path: string; body?: Rec }> = [];
  let created = 0;
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, path, ...(body && Object.keys(body).length ? { body } : {}) });
    if (path === "/api/bots?messages=0") return { bots, groups };
    if (path === "/api/routines" && method === "GET") return { routines, runs };
    if (path === "/api/routines" && method === "POST") {
      if (body.name === "Refused") throw refused(400, "Time must use HH:MM");
      const routine = { id: `r-new-${++created}`, ...body, enabled: body.enabled !== false, nextRunAt: 1_000, updatedAt: 1 };
      routines.push(routine);
      return { routine };
    }
    let match = /^\/api\/routines\/([\w-]+)(\/run)?$/.exec(path);
    if (match) {
      const routine = routines.find((candidate) => candidate.id === match![1]);
      if (!routine) throw refused(404, "no such routine");
      if (match[2]) return { run: { id: "run-now", routineId: routine.id, status: "queued", prompt: routine.prompt, attachments: [] } };
      if (method === "DELETE") { routines.splice(routines.indexOf(routine), 1); return { ok: true }; }
      Object.assign(routine, body);
      return { routine };
    }
    if (path === "/api/webhooks" && method === "GET") return { webhooks, attempts: [{ id: "a1" }], ingress };
    const credential = (webhook: Rec) => ({ endpointUrl: `${ingress.baseUrl}/hooks/${webhook.endpointId}`, secret: SECRET, url: `${ingress.baseUrl}/hooks/${webhook.endpointId}/${SECRET}` });
    if (path === "/api/webhooks" && method === "POST") {
      const webhook = { id: `w-new-${++created}`, endpointId: `wh_new${created}`, deliveryCount: 0, enabled: body.enabled !== false, ...body };
      webhooks.push(webhook);
      return { webhook, ingress, credential: credential(webhook) };
    }
    match = /^\/api\/webhooks\/([\w-]+)(\/rotate)?$/.exec(path);
    if (match) {
      const webhook = webhooks.find((candidate) => candidate.id === match![1]);
      if (!webhook) throw refused(404, "no such webhook");
      if (match[2]) return { webhook, ingress, credential: credential(webhook) };
      webhooks.splice(webhooks.indexOf(webhook), 1);
      return { ok: true };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const run = async (argv: string[], stdin = "") => {
    const out: string[] = [];
    const err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => stdin };
    const code = await runHeadless(argv, { io, env: { OPENMAUSBOT_URL: "http://127.0.0.1:19996" }, request: request as any });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
  };
}

describe("openmausbot routine", () => {
  it("creates a routine from flags, finding the bot by name in any case, and prints the tool's result", async () => {
    const w = workspace();
    const made = await w.run(["routine", "create", "Standup", "--bot", "henry", "--daily", "9:05", "--weekdays", "mon-fri", "--prompt", "Collect yesterday's work.",
      "--timeout", "45m", "--overlap", "queue", "--continuity", "--json"]);
    expect(made.code, made.err).toBe(0);
    expect(w.writes).toEqual([{ method: "POST", path: "/api/routines", body: {
      name: "Standup", prompt: "Collect yesterday's work.", botId: "b-henry", schedule: { type: "daily", time: "09:05", weekdays: [1, 2, 3, 4, 5] },
      timeoutMinutes: 45, overlap: "queue", continuity: true,
    } }]);
    expect(made.json()).toMatchObject({ success: true, routine: { id: "r-new-1", name: "Standup", botId: "b-henry" } });
    const human = await w.run(["routine", "create", "--name", "Weekly", "--bot", "Ada", "--daily", "10:00", "--weekdays", "sat,sun", "--prompt", "-"], "Plan the week.");
    expect(human.out).toBe("Created routine Weekly: weekends at 10:00, next run 1970-01-01T00:00Z (id r-new-2).");
    expect(w.writes[1]!.body).toMatchObject({ prompt: "Plan the week.", schedule: { weekdays: [0, 6] } });
  });

  it("sends each kind of schedule as the server takes it", async () => {
    const w = workspace();
    const before = Date.now();
    for (const flags of [
      ["--at", "2099-11-02T09:00:00+01:00"],
      ["--cron", "0 9 1 * *", "--tz", "Europe/Prague"],
      ["--every", "90m", "--weekdays", "fri-mon", "--window", "9:00-17:30", "--ends-at", "2099-12-31T23:00:00Z"],
    ]) expect((await w.run(["routine", "create", "R", "--bot", "b-ada", "--prompt", "x", ...flags])).code).toBe(0);
    const schedules = w.writes.map((write) => write.body!.schedule);
    expect(schedules[0]).toEqual({ type: "once", at: Date.UTC(2099, 10, 2, 8) });
    expect(schedules[1]).toEqual({ type: "cron", expression: "0 9 1 * *", timeZone: "Europe/Prague" });
    expect(schedules[2]).toEqual({ type: "interval", everyMinutes: 90, anchorAt: expect.any(Number), weekdays: [0, 1, 5, 6],
      window: { start: "09:00", end: "17:30" }, endsAt: Date.UTC(2099, 11, 31, 23) });
    expect(schedules[2].anchorAt).toBeGreaterThanOrEqual(before);
  });

  it("refuses a wrong command line with exit 2 before anything is written", async () => {
    const w = workspace();
    const cases: Array<[string[], string]> = [
      [["routine", "create", "R", "--bot", "Henry", "--daily", "09:00"], "--prompt is required"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x"], "a schedule is required"],
      [["routine", "create", "R", "--prompt", "x", "--daily", "09:00"], "--bot is required"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--daily", "09:00", "--every", "1h"], "give one schedule, not --daily and --every"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--cron", "0 9 * * *"], "--cron needs --tz"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--daily", "09:00", "--window", "09:00-17:00"], "--window goes with --every"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--every", "2m"], "--every must be a duration from 5m to 24h"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--at", "2099-11-02T09:00"], "at must be a date and time with its offset"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--at", "2020-01-01T09:00:00Z"], "at must be in the future"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--daily", "24:00"], "time must be a 24-hour time"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--daily", "09:00", "--weekdays", "someday"], "\"someday\" is not a day"],
      [["routine", "create", "R", "--bot", "Nobody", "--prompt", "x", "--daily", "09:00"], "no bot has the name or id \"Nobody\""],
      [["routine", "create", "R", "--bot", "twin", "--prompt", "x", "--daily", "09:00"], "\"twin\" names 2 bots: Twin (id b-twin-1); twin (id b-twin-2)"],
      [["routine", "create", "R", "--bot", "Henry", "--prompt", "x", "--daily", "09:00", "--channel", "Nowhere"], "no room has the name or id \"Nowhere\""],
      [["routine", "update", "Morning brief"], "give at least one change"],
      [["routine", "update", "Morning brief", "--pause", "--resume"], "give --resume or --pause, not both"],
      [["routine", "run", "Nightly"], "no routine has the name or id \"Nightly\""],
    ];
    for (const [argv, message] of cases) {
      const ran = await w.run([...argv, "--json"]);
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(ran.json().error, argv.join(" ")).toContain(message);
    }
    expect(w.writes).toEqual([]);
  });

  it("makes a room goal only with a member of the room as its lead", async () => {
    const w = workspace();
    expect((await w.run(["routine", "create", "Goal", "--bot", "Ada", "--channel", "launch", "--daily", "09:00", "--prompt", "x"])).code).toBe(0);
    expect(w.writes[0]!.body).toMatchObject({ botId: "b-ada", target: "room-goal", groupId: "g-launch" });
    const outsider = await w.run(["routine", "create", "Goal", "--bot", "b-twin-1", "--channel", "Launch", "--daily", "09:00", "--prompt", "x", "--json"]);
    expect(outsider.code).toBe(2);
    expect(outsider.json().error).toContain("must be one of its members, Henry (b-henry), Ada (b-ada)");
    expect(w.writes).toHaveLength(1);
  });

  it("changes only what is given, and a new schedule replaces the old one whole", async () => {
    const w = workspace();
    expect((await w.run(["routine", "update", "morning brief", "--pause"])).out).toBe("Updated routine Morning brief: weekdays at 08:30, paused.");
    expect((await w.run(["routine", "update", "r-tidy", "--resume", "--every", "30m", "--no-timeout", "--results-thread", "main", "--no-continuity"])).code).toBe(0);
    expect((await w.run(["routine", "update", "Tidy", "--no-channel", "--name", "Tidy up", "--prompt-file", join(dir, "missing.md")])).code).toBe(2);
    expect(w.writes).toEqual([
      { method: "PATCH", path: "/api/routines/r-brief", body: { enabled: false } },
      { method: "PATCH", path: "/api/routines/r-tidy", body: {
        enabled: true, schedule: { type: "interval", everyMinutes: 30, anchorAt: expect.any(Number), weekdays: null, window: null, endsAt: null },
        timeoutMinutes: null, continuity: false, resultsThreadId: null,
      } },
    ]);
  });

  it("lists without prompts, shows one with its recent runs, runs it now and deletes it", async () => {
    const w = workspace();
    const listed = await w.run(["routine", "list", "--json"]);
    expect(listed.json().routines.map((routine: Rec) => routine.id)).toEqual(["r-brief", "r-tidy"]);
    expect(listed.out).not.toContain("Summarize the night.");
    expect((await w.run(["routine", "list", "--bot", "ada"])).out).toBe("Tidy · Ada · every 1 h · paused · id r-tidy");
    expect((await w.run(["routine", "list"])).out.split("\n")[0]).toBe("Morning brief · Henry · weekdays at 08:30 · on, next 2026-11-02T07:30Z · id r-brief");

    const shown = await w.run(["routine", "show", "Morning brief", "--runs", "1", "--json"]);
    expect(shown.json()).toMatchObject({ routine: { id: "r-brief", prompt: "Summarize the night." }, runs: [{ id: "run-2", output: "All quiet." }] });
    expect(shown.json().runs[0]).not.toHaveProperty("prompt");
    expect((await w.run(["routine", "show", "r-brief"])).out).toContain("Prompt:\n  Summarize the night.\nRecent runs:\n  1970-01-01T00:00Z · completed");

    for (const verb of ["run", "delete"]) {
      const preview = await w.run(["routine", verb, "Morning brief", "--dry-run", "--json"]);
      expect(preview.json()).toEqual({ ok: true, dryRun: true, command: `routine ${verb}`, tool: verb === "run" ? "run_routine" : "delete_routine", arguments: { routine_id: "r-brief" } });
    }
    expect(w.writes).toEqual([]);
    expect((await w.run(["routine", "run", "Morning brief", "--json"])).json()).toEqual({ success: true, run: { id: "run-now", routineId: "r-brief", status: "queued" } });
    expect((await w.run(["routine", "delete", "Morning brief"])).out).toBe("Deleted routine Morning brief (id r-brief).");
    expect(w.writes).toEqual([{ method: "POST", path: "/api/routines/r-brief/run" }, { method: "DELETE", path: "/api/routines/r-brief" }]);
    expect(w.routines.map((routine) => routine.id)).toEqual(["r-tidy"]);
  });

  it("passes the server's refusal on with exit 1", async () => {
    const w = workspace();
    const ran = await w.run(["routine", "create", "Refused", "--bot", "Henry", "--daily", "09:00", "--prompt", "x", "--json"]);
    expect(ran.code).toBe(1);
    expect(ran.json()).toMatchObject({ ok: false, error: "Time must use HH:MM", exitCode: 1 });
  });
});

describe("openmausbot webhook", () => {
  it("never makes a secret without saying where it goes, and checks the file before anything is written", async () => {
    const w = workspace();
    const nowhere = await w.run(["webhook", "create", "Hook", "--bot", "Henry", "--json"]);
    expect(nowhere.code).toBe(2);
    expect(nowhere.json().error).toContain("pass --secret-file FILE");
    const taken = join(dir, "taken.secret");
    writeFileSync(taken, "keep me\n");
    const exists = await w.run(["webhook", "create", "Hook", "--bot", "Henry", "--secret-file", taken, "--json"]);
    expect(exists.json()).toMatchObject({ error: `${taken} already exists`, hint: "pass --force to replace it", exitCode: 2 });
    expect((await w.run(["webhook", "create", "Hook", "--bot", "Henry", "--force", "--show-secret"])).code).toBe(2);
    expect(readFileSync(taken, "utf8")).toBe("keep me\n");
    expect(w.writes).toEqual([]);
  });

  it("saves the secret to a file only you can read and prints only its address", async () => {
    const w = workspace();
    const file = join(dir, "deploys.secret");
    const made = await w.run(["webhook", "create", "Releases", "--bot", "Henry", "--prompt", "Check the release.", "--event-types", "push, release",
      "--delivery", "post", "--secret-file", file, "--json"]);
    expect(made.code, made.err).toBe(0);
    expect(w.writes).toEqual([{ method: "POST", path: "/api/webhooks", body: {
      name: "Releases", prompt: "Check the release.", botId: "b-henry", eventTypes: ["push", "release"], delivery: "post",
    } }]);
    expect(readFileSync(file, "utf8")).toBe(`${SECRET}\n`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(made.json().credential).toEqual({ endpointUrl: "http://127.0.0.1:18800/hooks/wh_new1", secretFile: file });
    expect(made.out + made.err).not.toContain(SECRET);

    const human = await w.run(["webhook", "rotate", "Releases", "--secret-file", file, "--force"]);
    expect(human.out).toContain(`The secret is in ${file}, readable only by you.`);
    expect(human.out + human.err).not.toContain(SECRET);
    expect(w.writes.at(-1)).toEqual({ method: "POST", path: "/api/webhooks/w-new-1/rotate" });
  });

  it("prints the secret only with --show-secret", async () => {
    const w = workspace();
    for (const json of [true, false]) {
      const shown = await w.run(["webhook", "rotate", "Deploys", "--show-secret", ...(json ? ["--json"] : [])]);
      expect(shown.code).toBe(0);
      if (json) expect(shown.json().credential).toEqual({ endpointUrl: "http://127.0.0.1:18800/hooks/wh_deploy", secret: SECRET, url: `http://127.0.0.1:18800/hooks/wh_deploy/${SECRET}` });
      else expect(shown.out).toContain(`Its secret, shown only now: ${SECRET}`);
    }
  });

  it("lists webhooks with their addresses, never their secrets, and deletes one", async () => {
    const w = workspace();
    const listed = await w.run(["webhook", "list", "--bot", "Henry"]);
    expect(listed.out).toBe("Deploys · Henry · on · 3 calls · only push · id w-deploy · POST http://127.0.0.1:18800/hooks/wh_deploy");
    expect((await w.run(["webhook", "list", "--json"])).json()).toEqual({ webhooks: [expect.objectContaining({ id: "w-deploy", endpointUrl: "http://127.0.0.1:18800/hooks/wh_deploy" })],
      ingress: { available: true, baseUrl: "http://127.0.0.1:18800" } });
    expect((await w.run(["webhook", "delete", "deploys", "--dry-run"])).out).toBe("Would call delete_webhook with {\"webhook_id\":\"w-deploy\"}. Nothing was sent.");
    expect((await w.run(["webhook", "delete", "Deploys"])).code).toBe(0);
    expect(w.writes).toEqual([{ method: "DELETE", path: "/api/webhooks/w-deploy" }]);
    expect((await w.run(["webhook", "rotate", "Deploys", "--show-secret", "--json"])).json().error).toBe("no webhook has the name or id \"Deploys\"");
  });
});

describe("openmausbot bot", () => {
  it("lists bots as bots does, and shows one with its routines and webhooks", async () => {
    const w = workspace();
    expect((await w.run(["bot", "list"])).out).toBe((await w.run(["bots"])).out);
    const shown = await w.run(["bot", "show", "henry", "--json"]);
    expect(shown.json()).toMatchObject({ bot: { id: "b-henry", name: "Henry" }, routines: [{ id: "r-brief" }], webhooks: [{ id: "w-deploy" }] });
    expect((await w.run(["bot", "show", "Henry"])).out).toBe([
      "Henry — Chief of Staff · team Steward · Chief of Staff · idle · id b-henry",
      "Model: claude/claude-sonnet-5",
      "Conversations: 1",
      "Routines:",
      "  Morning brief · Henry · weekdays at 08:30 · on, next 2026-11-02T07:30Z · id r-brief",
      "Webhooks:",
      "  Deploys · Henry · on · 3 calls · only push · id w-deploy · POST http://127.0.0.1:18800/hooks/wh_deploy",
    ].join("\n"));
  });
});