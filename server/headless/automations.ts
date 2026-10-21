// Each verb turns its flags into an MCP tool's arguments and prints what the tool returns, so this command and MCP
// clients do the same; `--json` prints that result unchanged.
import { existsSync, readFileSync } from "node:fs";

import { EXIT, flag, oneOf, parseCount, parseDuration, usageError, type Flags } from "./args.ts";
import { dryRun, list } from "./commands.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import { shortId } from "./output.ts";

type Rec = Record<string, any>;

const SCHEDULE_HINT = "--at 2026-11-02T09:00:00+01:00 | --daily 09:00 [--weekdays mon-fri] | --cron \"0 9 * * 1-5\" --tz Europe/Prague"
  + " | --every 30m [--window 09:00-17:00] [--weekdays mon-fri] [--starts-at TIME] [--ends-at TIME]";

const when = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z") : "never");

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function days(weekdays: unknown): string {
  if (!Array.isArray(weekdays) || weekdays.length === 7) return "every day";
  const joined = weekdays.join(",");
  return joined === "1,2,3,4,5" ? "weekdays" : joined === "0,6" ? "weekends" : weekdays.map((day) => DAY[day] ?? day).join(", ");
}

const span = (minutes: number) => (minutes % 60 ? `${minutes} min` : `${minutes / 60} h`);

export function scheduleText(schedule: Rec | undefined): string {
  switch (schedule?.type) {
    case "once": return `once, ${when(schedule.at)}`;
    case "daily": return `${days(schedule.weekdays)} at ${schedule.time}`;
    case "cron": return `cron "${schedule.expression}" in ${schedule.timeZone}`;
    case "interval":
      return [`every ${span(schedule.everyMinutes)}`, schedule.weekdays ? `on ${days(schedule.weekdays)}` : "",
        schedule.window ? `${schedule.window.start}-${schedule.window.end}` : "", schedule.endsAt ? `until ${when(schedule.endsAt)}` : ""]
        .filter(Boolean).join(", ");
    default: return "an unknown schedule";
  }
}

interface Fleet { bots: Rec[]; rooms: Rec[] }

async function fleet(ctx: VerbContext): Promise<Fleet> {
  const state = await (await ctx.client()).json<Rec>("/api/bots?messages=0");
  return { bots: state.bots ?? [], rooms: (state.groups ?? []).filter((group: Rec) => !group.dm) };
}

/** By id, else by name in any case; two of one name are refused with their ids. */
function pick(records: readonly Rec[], wanted: string | undefined, noun: string, listed: string): Rec {
  const value = wanted?.trim();
  if (!value) throw usageError(`name the ${noun} by its name or id`, `${listed} shows them`);
  const byId = records.find((record) => record.id === value);
  if (byId) return byId;
  const named = records.filter((record) => String(record.name ?? "").trim().toLowerCase() === value.toLowerCase());
  if (named.length === 1) return named[0]!;
  throw usageError(named.length
    ? `"${value}" names ${named.length} ${noun}s: ${named.map((record) => `${record.name} (id ${record.id})`).join("; ")}`
    : `no ${noun} has the name or id "${value}"`, named.length ? "use the id" : `${listed} shows them`);
}

const pickBot = async (ctx: VerbContext, wanted: string | undefined) => pick((await fleet(ctx)).bots, wanted, "bot", "openmausbot bot list");

async function pickFrom(ctx: VerbContext, tool: "list_routines" | "list_webhooks", wanted: string | undefined): Promise<Rec> {
  const noun = tool === "list_routines" ? "routine" : "webhook";
  const found = await (await ctx.client()).tool(tool, {});
  return pick(found[`${noun}s`] ?? [], wanted, noun, `openmausbot ${noun} list`);
}

function both(flags: Flags, yes: string, no: string): boolean | undefined {
  if (flags[yes] === true && flags[no] === true) throw usageError(`give --${yes} or --${no}, not both`);
  return flags[yes] === true ? true : flags[no] === true ? false : undefined;
}

function minutes(flags: Flags, name: string, min: number, max: number): number | undefined {
  const raw = flag(flags, name);
  if (raw === undefined) return undefined;
  const ms = parseDuration(raw, `--${name}`, { min: min * 60_000, max: max * 60_000 });
  if (ms % 60_000) throw usageError(`--${name} must be whole minutes, such as ${min}m or 2h`);
  return ms / 60_000;
}

async function readPrompt(ctx: VerbContext): Promise<string | undefined> {
  const text = flag(ctx.flags, "prompt");
  const file = flag(ctx.flags, "prompt-file");
  if (text !== undefined && file !== undefined) throw usageError("give the prompt one way: --prompt TEXT, --prompt - (read from stdin) or --prompt-file FILE");
  if ((file ?? text) === "-") return ctx.io.readStdin();
  if (file === undefined) return text;
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw usageError(`--prompt-file ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

const SCHEDULE_FLAGS = ["at", "daily", "cron", "every"] as const;
const SCHEDULE_PARTS: Record<string, readonly string[]> = { tz: ["cron"], weekdays: ["daily", "every"], window: ["every"], "starts-at": ["every"], "ends-at": ["every"] };

/** The schedule flags as the routine tools' schedule fields; the tools check the values. */
function scheduleArgs(flags: Flags): Rec {
  const chosen = SCHEDULE_FLAGS.filter((name) => flag(flags, name) !== undefined);
  if (chosen.length > 1) throw usageError(`give one schedule, not ${chosen.map((name) => `--${name}`).join(" and ")}`, SCHEDULE_HINT);
  for (const [part, schedules] of Object.entries(SCHEDULE_PARTS)) {
    if (flag(flags, part) !== undefined && !schedules.includes(chosen[0] ?? "")) {
      throw usageError(`--${part} goes with ${schedules.map((name) => `--${name}`).join(" or ")}`, SCHEDULE_HINT);
    }
  }
  const weekdays = flag(flags, "weekdays") === undefined ? {} : { weekdays: [flag(flags, "weekdays")] };
  switch (chosen[0]) {
    case "at": return { schedule: "once", at: flag(flags, "at") };
    case "daily": return { schedule: "daily", time: flag(flags, "daily"), ...weekdays };
    case "cron": {
      if (!flag(flags, "tz")?.trim()) throw usageError("--cron needs --tz, an IANA time zone such as Europe/Prague or UTC", SCHEDULE_HINT);
      return { schedule: "cron", cron: flag(flags, "cron"), time_zone: flag(flags, "tz") };
    }
    case "every": {
      const window = flag(flags, "window");
      const hours = window === undefined ? undefined : /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(window);
      if (window !== undefined && !hours) throw usageError("--window must be two 24-hour times, such as 09:00-17:00");
      return {
        schedule: "interval", every_minutes: minutes(flags, "every", 5, 1_440), ...weekdays,
        ...(flag(flags, "starts-at") === undefined ? {} : { starts_at: flag(flags, "starts-at") }),
        ...(hours ? { window_start: hours[1], window_end: hours[2] } : {}),
        ...(flag(flags, "ends-at") === undefined ? {} : { ends_at: flag(flags, "ends-at") }),
      };
    }
    default: return {};
  }
}

/** The routine flags as create_routine or update_routine arguments: everything read from the command line first, then
 * the bot and the room looked up by name. */
async function routineArgs(ctx: VerbContext, creating: boolean): Promise<Rec> {
  const { flags } = ctx;
  if (creating && ctx.positionals[0] !== undefined && flag(flags, "name") !== undefined) throw usageError("give the name once: NAME or --name NAME");
  const name = flag(flags, "name") ?? (creating ? ctx.positionals[0] : undefined);
  const prompt = await readPrompt(ctx);
  const enabled = creating ? (flags.paused === true ? false : undefined) : both(flags, "resume", "pause");
  if (flag(flags, "timeout") !== undefined && flags["no-timeout"] === true) throw usageError("give --timeout or --no-timeout, not both");
  if (flag(flags, "channel") !== undefined && flags["no-channel"] === true) throw usageError("give --channel or --no-channel, not both");
  const timeout = flags["no-timeout"] === true ? null : minutes(flags, "timeout", 5, 240);
  const args: Rec = Object.fromEntries(Object.entries({
    name, prompt, ...scheduleArgs(flags), enabled,
    timeout_minutes: timeout,
    duration_minutes: minutes(flags, "duration", 5, 240),
    overlap: flag(flags, "overlap") === undefined ? undefined : oneOf(flag(flags, "overlap"), "--overlap", ["skip", "queue"] as const, "skip"),
    continuity: both(flags, "continuity", "no-continuity"),
    run_on_startup: both(flags, "run-on-startup", "no-run-on-startup"),
    results_thread_id: flag(flags, "results-thread"),
  }).filter(([, value]) => value !== undefined));
  if (creating) {
    if (!name?.trim()) throw usageError("a name is required", "openmausbot routine create NAME --bot BOT --prompt TEXT --daily 09:00");
    if (prompt === undefined) throw usageError("--prompt is required: what the bot does on each run (--prompt TEXT, --prompt - or --prompt-file FILE)");
    if (args.schedule === undefined) throw usageError("a schedule is required", SCHEDULE_HINT);
    if (flag(flags, "bot") === undefined) throw usageError("--bot is required: the bot that runs it, by name or id", "openmausbot bot list shows them");
  }
  if (flag(flags, "bot") !== undefined || flag(flags, "channel") !== undefined) {
    const { bots, rooms } = await fleet(ctx);
    if (flag(flags, "bot") !== undefined) args.bot_id = pick(bots, flag(flags, "bot"), "bot", "openmausbot bot list").id;
    if (flag(flags, "channel") !== undefined) args.channel_id = pick(rooms, flag(flags, "channel"), "room", "openmausbot channels").id;
  }
  if (flags["no-channel"] === true) args.channel_id = null;
  return args;
}

function routineLine(routine: Rec, names: Fleet): string {
  const bot = names.bots.find((candidate) => candidate.id === routine.botId)?.name ?? routine.botId;
  const room = routine.target === "room-goal" ? names.rooms.find((candidate) => candidate.id === routine.groupId)?.name ?? routine.groupId : undefined;
  return [routine.name, room ? `goal of room ${room}, led by ${bot}` : bot, scheduleText(routine.schedule),
    routine.enabled ? `on, next ${when(routine.nextRunAt)}` : "paused",
    ...(routine.failureStreak ? [`${routine.failureStreak} failed in a row`] : []), `id ${routine.id}`].join(" · ");
}

const ok = (result: unknown, human: string[]): VerbOutcome => ({ result, exitCode: EXIT.done, human });
const revealing = (ctx: VerbContext, outcome: VerbOutcome): VerbOutcome => ctx.flags["show-secret"] === true ? { ...outcome, revealed: true } : outcome;

export async function routineList(ctx: VerbContext): Promise<VerbOutcome> {
  const names = await fleet(ctx);
  const bot = flag(ctx.flags, "bot") === undefined ? undefined : pick(names.bots, flag(ctx.flags, "bot"), "bot", "openmausbot bot list");
  const result = await (await ctx.client()).tool("list_routines", bot ? { bot_id: bot.id } : {});
  const human = (result.routines as Rec[]).map((routine) => routineLine(routine, names));
  return ok(result, human.length ? human : [bot ? `${bot.name} has no routines.` : "No routines yet."]);
}

export async function routineShow(ctx: VerbContext): Promise<VerbOutcome> {
  const runs = parseCount(flag(ctx.flags, "runs"), "--runs", 10, 50, 0);
  const routine = await pickFrom(ctx, "list_routines", ctx.positionals[0]);
  const result = await (await ctx.client()).tool("get_routine", { routine_id: routine.id, runs });
  return ok(result, [
    routineLine(result.routine, await fleet(ctx)),
    "Prompt:",
    ...String(result.routine.prompt ?? "").split("\n").map((line) => `  ${line}`),
    ...((result.runs as Rec[]).length ? ["Recent runs:"] : ["No runs yet."]),
    ...(result.runs as Rec[]).map((run) => `  ${when(run.scheduledFor)} · ${run.status}${run.manual ? " · run by hand" : ""}`
      + `${run.threadId ? ` · thread ${run.threadId}` : ""}${run.error ? ` · ${run.error}` : run.attention ? ` · ${run.attention}` : ""}`),
  ]);
}

export async function routineCreate(ctx: VerbContext): Promise<VerbOutcome> {
  const args = await routineArgs(ctx, true);
  const preview = dryRun(ctx, "create_routine", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("create_routine", args);
  return ok(result, [`Created routine ${result.routine.name}: ${scheduleText(result.routine.schedule)}, `
    + `${result.routine.enabled ? `next run ${when(result.routine.nextRunAt)}` : "paused"} (id ${result.routine.id}).`]);
}

export async function routineUpdate(ctx: VerbContext): Promise<VerbOutcome> {
  const changes = await routineArgs(ctx, false);
  if (!Object.keys(changes).length) throw usageError("give at least one change, such as --pause, --resume, --daily 09:00 or --prompt TEXT", "openmausbot help routine update");
  const args = { routine_id: (await pickFrom(ctx, "list_routines", ctx.positionals[0])).id, ...changes };
  const preview = dryRun(ctx, "update_routine", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("update_routine", args);
  return ok(result, [`Updated routine ${result.routine.name}: ${scheduleText(result.routine.schedule)}, `
    + `${result.routine.enabled ? `next run ${when(result.routine.nextRunAt)}` : "paused"}.`]);
}

export async function routineDelete(ctx: VerbContext): Promise<VerbOutcome> {
  const routine = await pickFrom(ctx, "list_routines", ctx.positionals[0]);
  const preview = dryRun(ctx, "delete_routine", { routine_id: routine.id });
  if (preview) return preview;
  const result = await (await ctx.client()).tool("delete_routine", { routine_id: routine.id });
  return ok(result, [`Deleted routine ${routine.name} (id ${routine.id}).`]);
}

export async function routineRun(ctx: VerbContext): Promise<VerbOutcome> {
  const routine = await pickFrom(ctx, "list_routines", ctx.positionals[0]);
  const preview = dryRun(ctx, "run_routine", { routine_id: routine.id });
  if (preview) return preview;
  const result = await (await ctx.client()).tool("run_routine", { routine_id: routine.id });
  return ok(result, [`Started routine ${routine.name} now (run ${result.run.id}, ${result.run.status}).`,
    `Follow it with: openmausbot routine show ${routine.id}`]);
}

function webhookLine(webhook: Rec, names: Fleet): string {
  const bot = names.bots.find((candidate) => candidate.id === webhook.botId)?.name ?? webhook.botId;
  return [webhook.name, bot, webhook.enabled ? "on" : "paused",
    `${webhook.deliveryCount ?? 0} call${webhook.deliveryCount === 1 ? "" : "s"}${webhook.lastReceivedAt ? `, last ${when(webhook.lastReceivedAt)}` : ""}`,
    ...(webhook.eventTypes?.length ? [`only ${webhook.eventTypes.join(", ")}`] : []), `id ${webhook.id}`,
    ...(webhook.endpointUrl ? [`POST ${webhook.endpointUrl}`] : [])].join(" · ");
}

const receiverDown = (ingress: Rec | undefined): string[] => (ingress && ingress.available === false
  ? [`warning: the webhook receiver is not running${ingress.error ? ` (${ingress.error})` : ""}, so calls are not received`] : []);

export async function webhookList(ctx: VerbContext): Promise<VerbOutcome> {
  const names = await fleet(ctx);
  const bot = flag(ctx.flags, "bot") === undefined ? undefined : pick(names.bots, flag(ctx.flags, "bot"), "bot", "openmausbot bot list");
  const result = await (await ctx.client()).tool("list_webhooks", bot ? { bot_id: bot.id } : {});
  const human = (result.webhooks as Rec[]).map((webhook) => webhookLine(webhook, names));
  return ok(result, [...(human.length ? human : [bot ? `${bot.name} has no webhooks.` : "No webhooks yet."]), ...receiverDown(result.ingress)]);
}

/** Where the new secret goes; the tool refuses a secret that would go nowhere. */
function secretArgs(flags: Flags): Rec {
  const file = flag(flags, "secret-file");
  if (flags.force === true && file === undefined) throw usageError("--force goes with --secret-file: it replaces that file");
  if (file === undefined && flags["show-secret"] !== true) {
    throw usageError("the secret is shown only once: pass --secret-file FILE to save it where only you can read it, or --show-secret to print it");
  }
  if (file !== undefined && flags.force !== true && existsSync(file)) throw usageError(`${file} already exists`, "pass --force to replace it");
  return { ...(flags["show-secret"] === true ? { show_secret: true } : {}), ...(file === undefined ? {} : { secret_file: file }),
    ...(flags.force === true ? { replace_secret_file: true } : {}) };
}

function credentialLines(result: Rec): string[] {
  const credential = result.credential ?? {};
  return [
    `Callers POST to ${credential.endpointUrl} with the secret, either as the header "Authorization: Bearer <secret>" or appended to the address (/<secret>).`,
    ...(credential.secretFile ? [`The secret is in ${credential.secretFile}, readable only by you.`] : []),
    ...(credential.secret ? [`Its secret, shown only now: ${credential.secret}`, `The address that carries it: ${credential.url}`] : []),
    ...receiverDown(result.ingress),
  ];
}

export async function webhookCreate(ctx: VerbContext): Promise<VerbOutcome> {
  if (ctx.positionals[0] !== undefined && flag(ctx.flags, "name") !== undefined) throw usageError("give the name once: NAME or --name NAME");
  const name = flag(ctx.flags, "name") ?? ctx.positionals[0];
  if (!name?.trim()) throw usageError("a name is required", "openmausbot webhook create NAME --bot BOT --secret-file FILE");
  if (flag(ctx.flags, "bot") === undefined) throw usageError("--bot is required: the bot that handles each call, by name or id", "openmausbot bot list shows them");
  const secret = secretArgs(ctx.flags);
  const prompt = await readPrompt(ctx);
  const eventTypes = flag(ctx.flags, "event-types")?.split(",").map((type) => type.trim()).filter(Boolean);
  const args: Rec = {
    bot_id: (await pickBot(ctx, flag(ctx.flags, "bot"))).id, name,
    ...(prompt === undefined ? {} : { prompt }),
    ...(eventTypes?.length ? { event_types: eventTypes } : {}),
    ...(flag(ctx.flags, "delivery") === undefined ? {} : { delivery: oneOf(flag(ctx.flags, "delivery"), "--delivery", ["run", "post"] as const, "run") }),
    ...(ctx.flags.paused === true ? { enabled: false } : {}),
    ...secret,
  };
  const preview = dryRun(ctx, "create_webhook", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("create_webhook", args);
  return revealing(ctx, ok(result, [`Created webhook ${result.webhook.name} (id ${result.webhook.id}).`, ...credentialLines(result)]));
}

export async function webhookDelete(ctx: VerbContext): Promise<VerbOutcome> {
  const webhook = await pickFrom(ctx, "list_webhooks", ctx.positionals[0]);
  const preview = dryRun(ctx, "delete_webhook", { webhook_id: webhook.id });
  if (preview) return preview;
  const result = await (await ctx.client()).tool("delete_webhook", { webhook_id: webhook.id });
  return ok(result, [`Deleted webhook ${webhook.name} (id ${webhook.id}); its address no longer answers.`]);
}

export async function webhookRotate(ctx: VerbContext): Promise<VerbOutcome> {
  const secret = secretArgs(ctx.flags);
  const webhook = await pickFrom(ctx, "list_webhooks", ctx.positionals[0]);
  const args = { webhook_id: webhook.id, ...secret };
  const preview = dryRun(ctx, "rotate_webhook_secret", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("rotate_webhook_secret", args);
  return revealing(ctx, ok(result, [`Webhook ${webhook.name} has a new secret; the old one no longer works.`, ...credentialLines(result)]));
}

export const botList = (ctx: VerbContext): Promise<VerbOutcome> => list({ ...ctx, verb: "bots" });

const modelName = (selection: Rec) => `${selection.instanceId}/${selection.model}${selection.effort ? `, effort ${selection.effort}` : ""}`;

export async function botShow(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  const bot = pick((await client.tool("list_bots", {})).bots ?? [], ctx.positionals[0], "bot", "openmausbot bot list");
  const [routines, webhooks, names] = await Promise.all([client.tool("list_routines", { bot_id: bot.id }), client.tool("list_webhooks", { bot_id: bot.id }), fleet(ctx)]);
  const result = { bot, routines: routines.routines, webhooks: webhooks.webhooks, ingress: webhooks.ingress };
  const model = bot.modelSelection;
  return ok(result, [
    `${bot.name}${bot.title ? ` — ${bot.title}` : ""} · ${bot.section ? `team ${bot.section}` : "no team"}${bot.chiefOfStaff ? " · Chief of Staff" : ""} · `
      + `${bot.activity === "waiting-on-you" ? "waiting on you" : bot.busy ? "working" : bot.waitingForTeammates ? "waiting on teammates" : "idle"} · id ${bot.id}`,
    ...(model?.instanceId ? [`Model: ${modelName(model)}`] : []),
    ...(bot.description ? [`About: ${bot.description}`] : []),
    `Conversations: ${(bot.tasks ?? []).length}`,
    ...(result.routines.length ? ["Routines:", ...result.routines.map((routine: Rec) => `  ${routineLine(routine, names)}`)] : ["Routines: none"]),
    ...(result.webhooks.length ? ["Webhooks:", ...result.webhooks.map((webhook: Rec) => `  ${webhookLine(webhook, names)}`)] : ["Webhooks: none"]),
    ...receiverDown(result.ingress),
  ]);
}

/** INSTANCE/MODEL, as `openmausbot models` lists them; the model tools check that the engine offers it. */
function instanceModel(raw: string, name: string): Rec {
  const value = raw.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw usageError(`${name} must be INSTANCE/MODEL, such as claude/claude-sonnet-5-5`, "openmausbot models lists them");
  return { instance_id: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** The profile flags as create_bot or update_bot_profile arguments. The prompt is the bot's instructions, its SOUL.md. */
async function profileArgs(ctx: VerbContext): Promise<Rec> {
  const { flags } = ctx;
  if (flag(flags, "team") !== undefined && flags["no-team"] === true) throw usageError("give --team or --no-team, not both");
  const instructions = await readPrompt(ctx);
  return Object.fromEntries(Object.entries({
    title: flag(flags, "title"), description: flag(flags, "description"), section: flags["no-team"] === true ? null : flag(flags, "team"), instructions,
  }).filter(([, value]) => value !== undefined));
}

export async function botCreate(ctx: VerbContext): Promise<VerbOutcome> {
  const { flags } = ctx;
  if (ctx.positionals[0] !== undefined && flag(flags, "name") !== undefined) throw usageError("give the name once: NAME or --name NAME");
  const name = flag(flags, "name") ?? ctx.positionals[0];
  if (!name?.trim()) throw usageError("a name is required", "openmausbot bot create NAME [--title TEXT] [--model INSTANCE/MODEL] [--prompt-file FILE]");
  const model = flag(flags, "model");
  const effort = flag(flags, "effort");
  if (model === undefined && effort !== undefined) throw usageError("--effort goes with --model", "openmausbot models lists them");
  const args = { name, ...await profileArgs(ctx), ...(model === undefined ? {} : instanceModel(model, "--model")), ...(effort === undefined ? {} : { effort }) };
  const preview = dryRun(ctx, "create_bot", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("create_bot", args);
  const { bot } = result;
  return ok(result, [`Created bot ${bot.name} (id ${bot.id})${bot.section ? ` in team ${bot.section}` : ""}`
    + `${bot.modelSelection?.instanceId ? ` on ${modelName(bot.modelSelection)}` : ""}.`, `Give it work with: openmausbot run ${bot.id} "…"`]);
}

export async function botUpdate(ctx: VerbContext): Promise<VerbOutcome> {
  const name = flag(ctx.flags, "name");
  const changes = { ...(name === undefined ? {} : { name }), ...await profileArgs(ctx) };
  if (!Object.keys(changes).length) {
    throw usageError("give at least one change, such as --title TEXT, --team TEAM or --prompt-file FILE", "openmausbot help bot update");
  }
  const args = { bot_id: (await pickBot(ctx, ctx.positionals[0])).id, ...changes };
  const preview = dryRun(ctx, "update_bot_profile", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("update_bot_profile", args);
  return ok(result, [`Updated bot ${result.bot.name}: ${Object.keys(changes).map((key) => (key === "section" ? "team" : key)).join(", ")}.`]);
}

export async function botModel(ctx: VerbContext): Promise<VerbOutcome> {
  const [wanted, model] = ctx.positionals;
  if (model === undefined) throw usageError("MODEL is required: openmausbot bot model BOT INSTANCE/MODEL", "openmausbot models lists them");
  const selection = instanceModel(model, "MODEL");
  const bot = await pickBot(ctx, wanted);
  const task = flag(ctx.flags, "task");
  const effort = flag(ctx.flags, "effort");
  const args = { bot_id: bot.id, ...(task === undefined ? {} : { task_id: task }), ...selection, ...(effort === undefined ? {} : { effort }) };
  const preview = dryRun(ctx, "set_bot_model", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("set_bot_model", args);
  const now = (result.bot ?? result.task)?.modelSelection ?? { instanceId: selection.instance_id, model: selection.model, effort };
  return ok(result, [`${bot.name} now runs on ${modelName(now)}${task === undefined ? "" : ` in thread ${shortId(task)}`}.`]);
}
