// A webhook's secret leaves these tools only when asked: in the result with show_secret, or with secret_file in a file only
// its owner can read, which is checked before the server makes the secret.
import { statSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";

import { writeFileAtomic } from "../server/atomic.ts";
import type { McpToolDefinition } from "./mcp-server.ts";

type Fetcher = (path: string, options?: RequestInit) => Promise<any>;
type Rec = Record<string, any>;

class AutomationInputError extends Error {}
const invalid = (message: string) => new AutomationInputError(message);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const REPLACES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const AGENT_ACTION = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const SCHEDULE_FIELDS = {
  schedule: {
    type: "string",
    enum: ["once", "daily", "weekly", "cron", "interval"],
    description: "once: at. daily: time, every day or on weekdays. weekly: time and weekdays. cron: cron and time_zone. "
      + "interval: every_minutes, optionally starts_at, weekdays, window_start and window_end, ends_at. "
      + "May be left out when the other fields name one schedule.",
  },
  at: { type: "string", description: "once: a future date and time with its offset, e.g. 2026-11-02T09:00:00+01:00 or 2026-11-02T08:00:00Z." },
  time: { type: "string", description: "daily and weekly: 24-hour HH:MM in the server computer's local time, e.g. 09:00." },
  weekdays: {
    type: "array",
    items: { type: ["string", "integer"] },
    description: "weekly (required), daily or interval (optional): days such as [\"mon\", \"thu\"], [\"mon-fri\"] or [\"weekend\"]; 0 is Sunday. Left out, every day.",
  },
  cron: { type: "string", description: "cron: five fields, minute hour day-of-month month weekday, e.g. \"0 9 * * 1-5\" (09:00 on weekdays) or \"0 9 1 * *\"." },
  time_zone: { type: "string", description: "cron (required): an IANA time zone such as Europe/Prague, America/New_York or UTC." },
  every_minutes: { type: "integer", minimum: 5, maximum: 1440, description: "interval: whole minutes between runs, 5 to 1440." },
  starts_at: { type: "string", description: "interval: the date and time with offset the cadence counts from. Left out, now: the first run is one interval away." },
  window_start: { type: "string", description: "interval, with window_end: 24-hour HH:MM from which runs may start, local time." },
  window_end: { type: "string", description: "interval, with window_start: 24-hour HH:MM at which the window closes, later the same day." },
  ends_at: { type: "string", description: "interval: the date and time with offset after which it no longer runs." },
} as const;

const ROUTINE_FIELDS = {
  name: { type: "string", description: "A short name, at most 80 characters." },
  prompt: { type: "string", description: "What the bot does on every run, at most 20,000 characters. A run sees no conversation, so give the whole task." },
  bot_id: { type: "string", description: "The bot that runs it (list_bots). For a room goal, the room member that coordinates it." },
  ...SCHEDULE_FIELDS,
  enabled: { type: "boolean", description: "false keeps it paused: it never runs on its own until enabled again." },
  duration_minutes: { type: "integer", minimum: 5, maximum: 240, description: "How long it shows in the calendar (default 30). It does not stop a run." },
  timeout_minutes: { type: ["integer", "null"], minimum: 5, maximum: 240, description: "Stops a run that works longer than this. Null removes the limit." },
  overlap: { type: "string", enum: ["skip", "queue"], description: "When it is due while its last run still works: skip that time (default), or queue one run." },
  continuity: { type: "boolean", description: "true: each run also gets the last finished run's report. Bot routines only." },
  run_on_startup: { type: "boolean", description: "true: also run once each time OpenMausBot starts. Repeating schedules only." },
  results_thread_id: { type: "string", description: "Bot routines: the bot's conversation that gets each run's result, or \"main\" for its main conversation (the default)." },
} as const;

const SECRET_FIELDS = {
  show_secret: { type: "boolean", description: "true returns the secret and the full URL that carries it. It is shown only this once." },
  secret_file: { type: "string", description: "A file path on the computer running this MCP server where the secret is saved, readable only by you; the secret is not returned." },
  replace_secret_file: { type: "boolean", description: "true lets secret_file replace a file that exists, such as the file of the secret it rotates." },
} as const;

export const AUTOMATION_TOOLS: McpToolDefinition[] = [
  {
    name: "list_routines",
    description: "List routines (scheduled work for a bot or a room goal): id, bot, schedule, whether it is on, next run and recent health. Prompts are left out; get_routine has one in full.",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "string", description: "Optional: only the routines this bot runs or coordinates." } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_routine",
    description: "Read one routine in full, with its most recent runs (status, times, conversation, output or error).",
    inputSchema: {
      type: "object",
      properties: {
        routine_id: { type: "string", description: "The routine's id (list_routines)." },
        runs: { type: "integer", minimum: 0, maximum: 50, description: "How many recent runs to include (default 10)." },
      },
      required: ["routine_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "create_routine",
    description: "Schedule work for a bot, or a goal for a room. Example: {\"bot_id\":\"…\",\"name\":\"Morning brief\",\"prompt\":\"…\","
      + "\"schedule\":\"weekly\",\"time\":\"08:30\",\"weekdays\":[\"mon-fri\"]}. It runs unattended on the bot's approval level.",
    inputSchema: {
      type: "object",
      properties: {
        ...ROUTINE_FIELDS,
        channel_id: { type: "string", description: "Optional: makes it a goal for this room (list_channels); bot_id must be a member, and coordinates it." },
      },
      required: ["bot_id", "name", "prompt"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "update_routine",
    description: "Change a routine: only the fields given change. A schedule given replaces the whole schedule (give all its parts). "
      + "enabled false pauses it, true resumes it.",
    inputSchema: {
      type: "object",
      properties: {
        routine_id: { type: "string", description: "The routine's id (list_routines)." },
        ...ROUTINE_FIELDS,
        channel_id: { type: ["string", "null"], description: "A room (list_channels) makes it that room's goal; null makes it the bot's own routine again." },
      },
      required: ["routine_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "delete_routine",
    description: "Delete a routine. A run waiting to start is cancelled; finished runs keep their conversations.",
    inputSchema: {
      type: "object",
      properties: { routine_id: { type: "string", description: "The routine's id (list_routines)." } },
      required: ["routine_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
  },
  {
    name: "run_routine",
    description: "Run a routine once now, besides its schedule (also a paused one). The bot works unattended and may use external tools. Returns the queued run; get_routine follows it.",
    inputSchema: {
      type: "object",
      properties: { routine_id: { type: "string", description: "The routine's id (list_routines)." } },
      required: ["routine_id"],
      additionalProperties: false,
    },
    annotations: AGENT_ACTION,
  },
  {
    name: "list_webhooks",
    description: "List webhooks (addresses other apps call to start a bot's work): id, bot, instructions, whether it is on, how often it was called, and the address it listens on (without its secret).",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "string", description: "Optional: only this bot's webhooks." } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "create_webhook",
    description: "Create a webhook for a bot: each POST to its address with its secret starts the bot's work. The secret exists only now: "
      + "pass show_secret true to see it, or secret_file to save it to a file, or both.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The bot that handles each call (list_bots)." },
        name: { type: "string", description: "A short name, at most 80 characters." },
        prompt: { type: "string", description: "What the bot does with each call, at most 20,000 characters. Empty: each call's own task field (or a summary of the event) is used." },
        event_types: { type: "array", items: { type: "string" }, description: "Optional: only these event names (the caller's event header, e.g. GitHub's push); left out, every call." },
        delivery: { type: "string", enum: ["run", "post"], description: "run (default): each call starts a run. post: each call is posted into one conversation of the bot." },
        enabled: { type: "boolean", description: "false creates it paused: calls are refused until it is enabled in the app." },
        ...SECRET_FIELDS,
      },
      required: ["bot_id", "name"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "delete_webhook",
    description: "Delete a webhook. Its address stops answering at once and runs waiting to start are cancelled.",
    inputSchema: {
      type: "object",
      properties: { webhook_id: { type: "string", description: "The webhook's id (list_webhooks)." } },
      required: ["webhook_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
  },
  {
    name: "rotate_webhook_secret",
    description: "Give a webhook a new secret; the old one stops working at once. Pass show_secret true to see the new one, or secret_file to save it.",
    inputSchema: {
      type: "object",
      properties: {
        webhook_id: { type: "string", description: "The webhook's id (list_webhooks)." },
        ...SECRET_FIELDS,
      },
      required: ["webhook_id"],
      additionalProperties: false,
    },
    annotations: REPLACES,
  },
];

const AUTOMATION_TOOL_NAMES: ReadonlySet<string> = new Set(AUTOMATION_TOOLS.map((tool) => tool.name));

function text(args: Rec, key: string, max: number, options: { allowEmpty?: boolean } = {}): string {
  const raw = args[key];
  if (typeof raw !== "string") throw invalid(`${key} must be a string`);
  const value = raw.trim();
  if (!value && !options.allowEmpty) throw invalid(`${key} must not be empty`);
  if (value.length > max) throw invalid(`${key} must be at most ${max.toLocaleString("en-US")} characters`);
  return value;
}

function id(args: Rec, key: string): string {
  const value = text(args, key, 200);
  if (!/^[\w-]+$/.test(value)) throw invalid(`${key} is not a valid OpenMausBot ID: list_bots, list_channels, list_routines and list_webhooks give them`);
  return value;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_HELP = "use mon, tue, wed, thu, fri, sat or sun, a range such as mon-fri, weekdays, weekend, or 0-6 (0 is Sunday)";

function weekday(word: string): number {
  const lower = word.trim().toLowerCase();
  if (/^[0-6]$/.test(lower)) return Number(lower);
  const index = lower.length >= 3 ? WEEKDAYS.findIndex((name) => name.startsWith(lower)) : -1;
  if (index < 0) throw invalid(`"${word}" is not a day: ${WEEKDAY_HELP}`);
  return index;
}

/** Day names, ranges (which may wrap, fri-mon) and 0-6 to the server's sorted day numbers, 0 being Sunday. */
export function parseWeekdays(values: unknown): number[] {
  if (!Array.isArray(values)) throw invalid(`weekdays must be a list: ${WEEKDAY_HELP}`);
  const days = new Set<number>();
  for (const value of values) {
    for (const part of String(value).split(",").map((piece) => piece.trim()).filter(Boolean)) {
      const lower = part.toLowerCase();
      const range = /^([a-z0-9]+)\s*-\s*([a-z0-9]+)$/.exec(lower);
      const named = lower === "weekdays" ? [1, 2, 3, 4, 5] : lower === "weekend" || lower === "weekends" ? [0, 6] : undefined;
      if (named) named.forEach((day) => days.add(day));
      else if (range) {
        const last = weekday(range[2]!);
        for (let day = weekday(range[1]!); ; day = (day + 1) % 7) {
          days.add(day);
          if (day === last) break;
        }
      } else days.add(weekday(part));
    }
  }
  if (!days.size) throw invalid(`weekdays names no day: ${WEEKDAY_HELP}`);
  return [...days].sort((a, b) => a - b);
}

function clock(args: Rec, key: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text(args, key, 5));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw invalid(`${key} must be a 24-hour time such as 09:00`);
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

/** RFC 3339 with an explicit offset (seconds optional), or epoch milliseconds, to epoch milliseconds. */
export function parseInstant(raw: unknown, key: string): number {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (/^\d{12,16}$/.test(value)) return Number(value);
  const parts = DATE_TIME.exec(value);
  const [year, month, day, hour, minute, second] = (parts?.slice(1, 7) ?? []).map((part) => Number(part ?? 0));
  const daysInMonth = parts ? new Date(Date.UTC(year!, month!, 0)).getUTCDate() : 0;
  const at = parts ? Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6] ?? "00"}${parts[7] ?? ""}${parts[8]!.toUpperCase()}`) : NaN;
  if (!parts || month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth || hour! > 23 || minute! > 59 || second! > 59 || !Number.isFinite(at)) {
    throw invalid(`${key} must be a date and time with its offset, such as 2026-11-02T09:00:00+01:00 or 2026-11-02T08:00:00Z`);
  }
  return at;
}

const SCHEDULE_KEYS: Record<string, readonly string[]> = {
  once: ["at"],
  daily: ["time", "weekdays"],
  weekly: ["time", "weekdays"],
  cron: ["cron", "time_zone"],
  interval: ["every_minutes", "starts_at", "weekdays", "window_start", "window_end", "ends_at"],
};
const SCHEDULE_EXAMPLE = "for example {\"schedule\":\"daily\",\"time\":\"09:00\"}, {\"schedule\":\"cron\",\"cron\":\"0 9 * * 1-5\",\"time_zone\":\"Europe/Prague\"}, "
  + "{\"schedule\":\"interval\",\"every_minutes\":60} or {\"schedule\":\"once\",\"at\":\"2026-11-02T09:00:00+01:00\"}";

function scheduleType(args: Rec): string | undefined {
  if (args.schedule !== undefined) return text(args, "schedule", 20);
  const named = Object.entries({ once: ["at"], daily: ["time"], cron: ["cron", "time_zone"], interval: ["every_minutes", "starts_at", "window_start", "window_end", "ends_at"] })
    .filter(([, keys]) => keys.some((key) => args[key] !== undefined)).map(([type]) => type);
  if (named.length > 1) throw invalid(`these fields belong to different schedules (${named.join(", ")}): give one, ${SCHEDULE_EXAMPLE}`);
  if (!named.length && args.weekdays !== undefined) throw invalid(`weekdays needs a daily, weekly or interval schedule, ${SCHEDULE_EXAMPLE}`);
  return named[0];
}

/** Undefined when the arguments name no schedule. An update replaces the schedule whole: an interval's restrictions
 * left out are cleared (null), where the server would keep them. */
export function routineSchedule(args: Rec, now: number, replacing: boolean): Rec | undefined {
  const type = scheduleType(args);
  if (type === undefined) return undefined;
  const allowed = SCHEDULE_KEYS[type];
  if (!allowed) throw invalid(`schedule must be once, daily, weekly, cron or interval, ${SCHEDULE_EXAMPLE}`);
  const stray = Object.values(SCHEDULE_KEYS).flat().find((key) => args[key] !== undefined && !allowed.includes(key));
  if (stray) throw invalid(`${stray} does not belong to ${type} schedules, which take ${allowed.join(", ")}`);
  const required = type === "once" ? ["at"] : type === "cron" ? ["cron", "time_zone"] : type === "interval" ? ["every_minutes"]
    : type === "weekly" ? ["time", "weekdays"] : ["time"];
  if (required.some((key) => args[key] === undefined)) throw invalid(`${type} schedules need ${required.join(" and ")}, ${SCHEDULE_EXAMPLE}`);
  const weekdays = args.weekdays === undefined ? undefined : parseWeekdays(args.weekdays);
  if (type === "once") {
    const at = parseInstant(args.at, "at");
    if (at <= now) throw invalid("at must be in the future");
    return { type: "once", at };
  }
  if (type === "daily" || type === "weekly") return { type: "daily", time: clock(args, "time"), weekdays: weekdays ?? [0, 1, 2, 3, 4, 5, 6] };
  if (type === "cron") return { type: "cron", expression: text(args, "cron", 256), timeZone: text(args, "time_zone", 128) };
  if ((args.window_start === undefined) !== (args.window_end === undefined)) throw invalid("window_start and window_end go together, such as 09:00 and 17:00");
  const window = args.window_start === undefined ? undefined : { start: clock(args, "window_start"), end: clock(args, "window_end") };
  const endsAt = args.ends_at === undefined ? undefined : parseInstant(args.ends_at, "ends_at");
  const kept = <T>(value: T | undefined) => (value === undefined ? (replacing ? null : undefined) : value);
  return Object.fromEntries(Object.entries({
    type: "interval",
    everyMinutes: args.every_minutes,
    anchorAt: args.starts_at === undefined ? now : parseInstant(args.starts_at, "starts_at"),
    weekdays: kept(weekdays),
    window: kept(window),
    endsAt: kept(endsAt),
  }).filter(([, value]) => value !== undefined));
}

export function routineRequest(args: Rec, now: number, replacing: boolean): Rec {
  const body: Rec = {};
  if (args.name !== undefined) body.name = text(args, "name", 80);
  if (args.prompt !== undefined) body.prompt = text(args, "prompt", 20_000);
  if (args.bot_id !== undefined) body.botId = id(args, "bot_id");
  if (args.channel_id !== undefined) {
    Object.assign(body, args.channel_id === null ? { target: "bot", groupId: null } : { target: "room-goal", groupId: id(args, "channel_id") });
  }
  const schedule = routineSchedule(args, now, replacing);
  if (schedule) body.schedule = schedule;
  if (args.enabled !== undefined) body.enabled = args.enabled;
  if (args.duration_minutes !== undefined) body.durationMinutes = args.duration_minutes;
  if (args.timeout_minutes !== undefined) body.timeoutMinutes = args.timeout_minutes;
  if (args.overlap !== undefined) body.overlap = args.overlap;
  if (args.continuity !== undefined) body.continuity = args.continuity;
  if (args.run_on_startup !== undefined) body.runOnStartup = args.run_on_startup;
  if (args.results_thread_id !== undefined) {
    body.resultsThreadId = text(args, "results_thread_id", 200) === "main" ? null : id(args, "results_thread_id");
  }
  return body;
}

const records = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : []);

function routineSummary(routine: Rec): Rec {
  const { prompt: _prompt, attachments, ...summary } = routine;
  return { ...summary, ...(Array.isArray(attachments) && attachments.length ? { attachmentCount: attachments.length } : {}) };
}

function runSummary(run: Rec): Rec {
  const { prompt: _prompt, attachments: _attachments, ...summary } = run;
  return summary;
}

const endpointUrl = (baseUrl: unknown, endpointId: unknown) =>
  typeof baseUrl === "string" && typeof endpointId === "string" ? `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}` : undefined;

async function found<T>(request: Promise<T>, what: "Routine" | "Webhook", key: string): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404 && new RegExp(`no such ${what.toLowerCase()}`).test(String((error as Error).message))) {
      throw new Error(`${what} not found: ${key} (list_${what.toLowerCase()}s lists them)`);
    }
    throw error;
  }
}

async function routinesNow(fetcher: Fetcher): Promise<{ routines: Rec[]; runs: Rec[] }> {
  const state = await fetcher("/api/routines");
  return { routines: records(state?.routines), runs: records(state?.runs) };
}

/** The room goal's coordinator must be in the room; said here, where the server would only say the room is missing. */
async function checkRoomGoal(fetcher: Fetcher, botId: string, channelId: string): Promise<void> {
  const fleet = await fetcher("/api/bots?messages=0");
  const room = records(fleet?.groups).find((group) => group.id === channelId && !group.dm);
  if (!room) throw invalid(`channel_id ${channelId} is not a room: list_channels gives the rooms`);
  const members: string[] = Array.isArray(room.memberIds) ? room.memberIds : [];
  if (!members.includes(botId)) {
    const names = members.map((member) => `${records(fleet?.bots).find((bot) => bot.id === member)?.name ?? "a bot"} (${member})`);
    throw invalid(`bot ${botId} is not in the room "${room.name}": a room goal's bot_id must be one of its members, ${names.join(", ")}`);
  }
}

interface SecretTarget { show: boolean; file?: string }

/** Checked before the request, so a secret made by the server is never lost to a file that cannot be written. */
function secretTarget(args: Rec, tool: string): SecretTarget {
  const show = args.show_secret === true;
  if (args.secret_file === undefined) {
    if (args.replace_secret_file !== undefined) throw invalid("replace_secret_file goes with secret_file");
    if (!show) throw invalid(`${tool} makes a secret that is shown only once: pass show_secret true to see it, or secret_file "/path/to/file" to save it to a file only you can read`);
    return { show };
  }
  const path = text(args, "secret_file", 4_096);
  if (path === "-" || path.startsWith("/dev/")) throw invalid("secret_file must be a file, never a terminal or a device: use show_secret to see the secret");
  const file = resolve(path);
  const existing = statOrNothing(file, "secret_file");
  if (existing && !existing.isFile()) throw invalid(`secret_file ${file} is not a regular file`);
  if (existing && args.replace_secret_file !== true) throw invalid(`secret_file ${file} already exists: pass replace_secret_file true to replace it`);
  if (!statOrNothing(dirname(file), "secret_file")?.isDirectory()) throw invalid(`the folder of secret_file ${file} does not exist`);
  return { show, file };
}

function statOrNothing(path: string, key: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw invalid(`${key} ${path} cannot be used (${code ?? "error"})`);
  }
}

function credentialResult(response: Rec, target: SecretTarget, action: "created" | "rotated"): Rec {
  const webhook = response?.webhook;
  const credential = response?.credential;
  if (!webhook || typeof webhook.id !== "string" || typeof credential?.secret !== "string") throw new Error("OpenMausBot did not return the webhook and its secret");
  if (target.file) {
    try {
      writeFileAtomic(target.file, `${credential.secret}\n`, { mode: 0o600 });
    } catch (error) {
      throw new Error(`Webhook ${webhook.id} was ${action}, but its secret could not be saved to ${target.file} `
        + `(${(error as NodeJS.ErrnoException).code ?? "error"}): rotate it again (rotate_webhook_secret) to get a new one`);
    }
  }
  return {
    success: true,
    webhook,
    ingress: response.ingress,
    credential: {
      endpointUrl: credential.endpointUrl,
      ...(target.show ? { secret: credential.secret, url: credential.url } : {}),
      ...(target.file ? { secretFile: target.file } : {}),
    },
  };
}

async function dispatch(name: string, args: Rec, fetcher: Fetcher): Promise<unknown> {
  switch (name) {
    case "list_routines": {
      const botId = args.bot_id === undefined ? undefined : id(args, "bot_id");
      const { routines } = await routinesNow(fetcher);
      return { routines: routines.filter((routine) => !botId || routine.botId === botId).map(routineSummary) };
    }

    case "get_routine": {
      const routineId = id(args, "routine_id");
      const { routines, runs } = await routinesNow(fetcher);
      const routine = routines.find((candidate) => candidate.id === routineId);
      if (!routine) throw new Error(`Routine not found: ${routineId} (list_routines lists them)`);
      const limit = typeof args.runs === "number" ? args.runs : 10;
      return { routine, runs: runs.filter((run) => run.routineId === routineId).slice(0, limit).map(runSummary) };
    }

    case "create_routine": {
      const body = routineRequest(args, Date.now(), false);
      if (!body.schedule) throw invalid(`a routine needs a schedule, ${SCHEDULE_EXAMPLE}`);
      if (body.target === "room-goal") await checkRoomGoal(fetcher, body.botId, body.groupId);
      const created = await fetcher("/api/routines", { method: "POST", body: JSON.stringify(body) });
      if (!created?.routine?.id) throw new Error("OpenMausBot did not return the created routine");
      return { success: true, routine: created.routine };
    }

    case "update_routine": {
      const routineId = id(args, "routine_id");
      const { routine_id: _routineId, ...fields } = args;
      const body = routineRequest(fields, Date.now(), true);
      if (!Object.keys(body).length) throw invalid("give at least one field to change, such as enabled false to pause it");
      if (body.target === "room-goal") {
        const current = (await routinesNow(fetcher)).routines.find((routine) => routine.id === routineId);
        if (!current) throw new Error(`Routine not found: ${routineId} (list_routines lists them)`);
        await checkRoomGoal(fetcher, body.botId ?? current.botId, body.groupId);
      }
      const updated = await found(fetcher(`/api/routines/${encodeURIComponent(routineId)}`, { method: "PATCH", body: JSON.stringify(body) }), "Routine", routineId);
      if (!updated?.routine?.id) throw new Error("OpenMausBot did not return the updated routine");
      return { success: true, routine: updated.routine };
    }

    case "delete_routine": {
      const routineId = id(args, "routine_id");
      await found(fetcher(`/api/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" }), "Routine", routineId);
      return { success: true, routineId };
    }

    case "run_routine": {
      const routineId = id(args, "routine_id");
      const started = await found(fetcher(`/api/routines/${encodeURIComponent(routineId)}/run`, { method: "POST", body: "{}" }), "Routine", routineId);
      if (!started?.run?.id) throw new Error("OpenMausBot did not return the run");
      return { success: true, run: runSummary(started.run) };
    }

    case "list_webhooks": {
      const botId = args.bot_id === undefined ? undefined : id(args, "bot_id");
      const state = await fetcher("/api/webhooks");
      return {
        webhooks: records(state?.webhooks).filter((webhook) => !botId || webhook.botId === botId)
          .map((webhook) => ({ ...webhook, endpointUrl: endpointUrl(state?.ingress?.baseUrl, webhook.endpointId) })),
        ingress: state?.ingress,
      };
    }

    case "create_webhook": {
      const target = secretTarget(args, "create_webhook");
      const body: Rec = {
        name: text(args, "name", 80),
        prompt: args.prompt === undefined ? "" : text(args, "prompt", 20_000, { allowEmpty: true }),
        botId: id(args, "bot_id"),
        ...(args.event_types === undefined ? {} : { eventTypes: args.event_types }),
        ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
        ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      };
      return credentialResult(await fetcher("/api/webhooks", { method: "POST", body: JSON.stringify(body) }), target, "created");
    }

    case "delete_webhook": {
      const webhookId = id(args, "webhook_id");
      await found(fetcher(`/api/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" }), "Webhook", webhookId);
      return { success: true, webhookId };
    }

    case "rotate_webhook_secret": {
      const webhookId = id(args, "webhook_id");
      const target = secretTarget(args, "rotate_webhook_secret");
      const rotated = await found(fetcher(`/api/webhooks/${encodeURIComponent(webhookId)}/rotate`, { method: "POST", body: "{}" }), "Webhook", webhookId);
      return credentialResult(rotated, target, "rotated");
    }

    default:
      throw invalid(`Unknown tool: ${name}`);
  }
}

/** Input errors come out as the caller's `inputError` class. */
export async function handleAutomationTool(
  name: string,
  args: Record<string, unknown>,
  fetcher: Fetcher,
  inputError: new (message: string) => Error,
): Promise<unknown> {
  try {
    if (!AUTOMATION_TOOL_NAMES.has(name)) throw invalid(`Unknown tool: ${name}`);
    return await dispatch(name, args, fetcher);
  } catch (error) {
    throw error instanceof AutomationInputError ? new inputError(error.message) : error;
  }
}
