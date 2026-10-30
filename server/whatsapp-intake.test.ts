// The behaviour contract of the Lazurio MausBot WhatsApp intake. WhatsApp is a
// fake wacli with an in-memory store; delivery goes through a real
// WebhookManager, so every run is the same queued, UNTRUSTED-wrapped webhook run
// an HTTP delivery would be, and the bot's turn is played as runtime events.
// Every chat id, number, name and login here is synthetic.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { WebhookManager } from "./webhooks.ts";
import { EDITS_KEPT, newEdit } from "./whatsapp-intake-commands.ts";
import { loadGroupMap, userOf, whatsappIntakeConfigFromEnv, type WhatsappIntakeConfig } from "./whatsapp-intake-config.ts";
import { INTAKE_EVENT_TYPE, TRIGGER_NAME_PREFIX, WhatsappIntake, type CatchUpSummary } from "./whatsapp-intake.ts";
import type { IntakeState, OperatorEdit } from "./whatsapp-intake-state.ts";
import type { EditTime } from "./whatsapp-intake-wacli-store.ts";
import { SIGNATURE_HEADER, wacliSignature, type FollowerEvent, type Wacli, type WaChange, type WaMessage } from "./whatsapp-intake-wacli.ts";

const SELF = "15550000001@s.whatsapp.net";
const OPERATOR = "15550000002@s.whatsapp.net";
const TEAM = "15550000003@s.whatsapp.net";
const CLIENT = "15550000101@s.whatsapp.net";
const OUTSIDER = "15550000199@s.whatsapp.net";
const A = "120363000000000001@g.us";
const B = "120363000000000002@g.us";
const C = "120363000000000003@g.us";
const D = "120363000000000004@g.us";
const UNMAPPED = "120363000000000009@g.us";
const MONDAY_9 = Date.parse("2026-11-02T08:00:00Z");
const MENTION = "@15550000001";

class FakeWacli implements Wacli {
  store: WaMessage[] = [];
  /** wacli's change journal: an entry for each message the store takes in or changes; a checkpoint is a count of them. */
  journal: WaChange[] = [];
  sent: Array<{ to: string; text: string; replyTo?: string }> = [];
  failSend = false;
  /** Why every journal read fails, as with a wacli that has no journal. */
  journalFailure?: string;
  /** Why taking a checkpoint fails, as with a store wacli cannot open. */
  checkpointFailure?: string;
  /** Checkpoints below this have expired. */
  expiredBefore = 0;
  /** Messages whose read fails, as when wacli times out. */
  failRead = new Set<string>();
  /** When the store says each edited message was last edited, in whole seconds as it keeps them: a later edit moves it
   * forward, never back, and a rewrite leaves it. */
  editTimes = new Map<WaMessage, number>();
  /** Why the store cannot tell an edit's time, as with one another wacli migrated. */
  editTimeProblem?: string;
  /** The harness's clock, for an edit's time. */
  now = () => MONDAY_9;
  checkpoints = 0;
  followers = { started: 0, stopped: 0 };
  webhook?: { url: string; secret: string };
  events?: (event: FollowerEvent) => void;
  private count = 0;

  async account() { return { authenticated: true, jid: SELF }; }

  async messages(chat: string, limit: number) {
    return this.store.filter((message) => message.chat === chat).sort((a, b) => a.at - b.at).slice(-limit);
  }

  async message(chat: string, id: string) {
    if (this.failRead.has(id)) throw new Error("wacli messages show: wacli command timed out");
    return this.store.find((message) => message.chat === chat && message.id === id) ?? null;
  }

  async editedAt(chat: string, id: string): Promise<EditTime> {
    if (this.editTimeProblem) return { unknown: this.editTimeProblem };
    const message = this.store.find((candidate) => candidate.chat === chat && candidate.id === id);
    return message ? { at: this.editTimes.get(message) ?? 0 } : { unknown: "wacli's store does not hold the message" };
  }

  async checkpoint() {
    this.checkpoints++;
    const failure = this.checkpointFailure ?? this.journalFailure;
    if (failure) throw new Error(failure);
    return String(this.journal.length);
  }

  async changes(since: string, limit: number) {
    if (this.journalFailure) throw new Error(this.journalFailure);
    if (Number(since) < this.expiredBefore) throw Object.assign(new Error("wacli messages changes: expired checkpoint"), { lost: true });
    const rest = this.journal.slice(Number(since));
    const changes = rest.slice(0, limit);
    return { changes, more: rest.length > limit, next: String(Number(since) + changes.length) };
  }

  changed(message: WaMessage) {
    this.journal.push({ sequence: this.journal.length + 1, operation: "upsert", chat: message.chat, id: message.id, at: message.at });
  }

  /** wacli files a stored message under another chat id, as when it learns the phone number behind a LID. */
  moved(message: WaMessage, chat: string) {
    this.journal.push({ sequence: this.journal.length + 1, operation: "identity_move", chat: message.chat, id: message.id, movedTo: { chat, id: message.id }, at: message.at });
    message.chat = chat;
  }

  /** wacli stores an edit over the message it edits, which keeps its id and time, and keeps the edit's own time apart:
   * the journal shows one more upsert. */
  edited(message: WaMessage, text: string) {
    Object.assign(message, { text, service: true, edited: true });
    this.editTimes.set(message, Math.max(this.editTimes.get(message) ?? 0, Math.floor(this.now() / 1_000) * 1_000));
    this.changed(message);
  }

  /** wacli rewrites a stored row with no new action of anyone's, as when it normalizes a sender's LID to the phone number:
   * the journal shows one more upsert, and an edit keeps its text and its edit time. */
  rewritten(message: WaMessage, fields: Partial<WaMessage>) {
    Object.assign(message, fields);
    this.changed(message);
  }

  async sendText(to: string, text: string, replyTo?: string) {
    if (this.failSend) throw new Error("wacli send text: not sent");
    this.sent.push({ to, text, ...(replyTo ? { replyTo } : {}) });
    return `3EB0SENT${String(++this.count).padStart(4, "0")}`;
  }

  follow(webhook: { url: string; secret: string }, onEvent: (event: FollowerEvent) => void) {
    this.webhook = webhook;
    this.events = onEvent;
    this.followers.started++;
    return { stop: async () => { this.followers.stopped++; } };
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MAP = {
  version: 1,
  team: [TEAM],
  allowedLinks: ["https://github.com/example-provider/handbook"],
  groups: {
    [A]: { key: "a", name: "Group A", mode: "auto", note: "notes/a.md", address: "vy", clientNames: ["Contoso"], owners: ["contoso-labs"] },
    [B]: { key: "b", name: "Group B", mode: "auto", note: "notes/b.md", address: "ty", clientNames: ["Fabrikam"], owners: ["fabrikam-ltd"] },
    [C]: { key: "c", name: "Group C", mode: "observe", note: "notes/c.md" },
    [D]: { key: "d", name: "Group D", mode: "draft", note: "notes/d.md" },
  },
};

interface FakeRun { webhookId: string; status: string; threadId?: string; output?: string }
let messageCount = 0;
type Tool = { name: string; summary?: string; input?: string };

function harness(options: { dir?: string; wacli?: FakeWacli; now?: number; botCwd?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "omb-whatsapp-intake-"));
  if (!options.dir) dirs.push(dir);
  const bundle = join(dir, "bundle");
  const groupsFile = join(dir, "groups.json");
  if (!options.dir) {
    mkdirSync(join(dir, "notes"), { recursive: true });
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "guide.md"), "# Integrace\nOtevřete Nastavení → Integrace.\n");
    for (const key of ["a", "b", "c", "d"]) writeFileSync(join(dir, "notes", `${key}.md`), `Note of group ${key.toUpperCase()}: a synthetic client fact.`);
    writeFileSync(groupsFile, JSON.stringify(MAP));
  }
  const clock = { now: options.now ?? MONDAY_9 };
  const wacli = options.wacli ?? new FakeWacli();
  wacli.now = () => clock.now;
  const bots = [{ id: "bot-support", name: "Support", cwd: options.botCwd ?? bundle }];
  const queued: Array<{ webhookId: string; prompt: string; deliveryId: string; runId: string }> = [];
  const runs = new Map<string, FakeRun>();
  const receipts = new Map<string, string>();
  const webhooks = new WebhookManager({
    file: join(dir, "webhooks.json"),
    now: () => clock.now,
    botState: (botId) => (bots.some((bot) => bot.id === botId) ? "ready" : "missing"),
    enqueue: (input) => {
      const runId = `run-${queued.length + 1}`;
      queued.push({ webhookId: input.webhookId, prompt: input.prompt, deliveryId: input.deliveryId, runId });
      receipts.set(`${input.webhookId}:${input.deliveryId}`, runId);
      runs.set(runId, { webhookId: input.webhookId, status: "queued" });
      return { id: runId };
    },
    findRun: (webhookId, deliveryId) => {
      const id = receipts.get(`${webhookId}:${deliveryId}`);
      return id ? { id } : null;
    },
    pendingRuns: (webhookId) => [...runs.values()].filter((run) => run.webhookId === webhookId && ["queued", "running"].includes(run.status)).length,
  });
  const logs: string[] = [];
  const config: WhatsappIntakeConfig = { bot: "Support", groupsFile, operator: OPERATOR, bundle, maxDbSize: "2GB", selfIds: ["15550000001"] };
  let held: { entered: () => void; released: Promise<void> } | null = null;
  const intake = new WhatsappIntake({
    config, map: loadGroupMap(groupsFile), wacli, file: join(dir, "whatsapp-intake.json"), webhooks, bots: () => bots,
    runState: (runId) => runs.get(runId) ?? null, now: () => clock.now, log: (line) => logs.push(line), random: () => 0,
    sleep: async (ms) => {
      const hold = held;
      held = null;
      if (hold) {
        hold.entered();
        await hold.released;
      }
      clock.now += ms;
    },
  });
  /** Keeps the next send waiting for its spacing until `release()`; `waiting` settles once a send waits there. */
  const holdSpacing = () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    held = { entered, released: new Promise<void>((resolve) => { release = resolve; }) };
    return { waiting, release };
  };
  /** A message wacli stored; without `incoming` its webhook never arrived. */
  const stored = (fields: Partial<WaMessage> & { chat: string }) => {
    const message: WaMessage = { id: `3EB0IN${String(++messageCount).padStart(6, "0")}`, sender: CLIENT, senderName: "Client One", at: clock.now, fromMe: false, text: "", ...fields };
    wacli.store.push(message);
    wacli.changed(message);
    return message;
  };
  const incoming = async (fields: Partial<WaMessage> & { chat: string }) => {
    const message = stored(fields);
    await intake.receive(livePayload(message));
    return message;
  };
  /** The bot's turn for a run, as the engine's runtime events report it, short of the turn's end. */
  const play = (runId: string, output: unknown, tools: Tool[] = [readIn(bundle)], provider = "claudeAgent") => {
    const run = runs.get(runId)!;
    const threadId = `thread-${runId}`;
    Object.assign(run, { status: "running", threadId });
    const event = (fields: Record<string, unknown>) => intake.observe({ eventId: `e-${runId}`, provider, threadId, createdAt: new Date(clock.now).toISOString(), ...fields } as RuntimeEvent);
    event({ type: "turn.started" });
    for (const tool of tools) event({ type: "item.started", itemType: "tool", title: tool.name, ...(tool.summary ? { summary: tool.summary } : {}), ...(tool.input ? { input: tool.input } : {}) });
    const text = typeof output === "string" ? output : JSON.stringify(output);
    event({ type: "item.completed", itemType: "assistant_text", text });
    Object.assign(run, { status: "completed", output: text.slice(0, 2_000) });
    return event;
  };
  const answer = async (runId: string, output: unknown, tools?: Tool[], provider?: string) => {
    play(runId, output, tools, provider)({ type: "turn.completed", ok: true });
    await intake.tick();
  };
  const saved = () => savedState(dir);
  /** The operator's text in the operator's chat: delivered, or with `dropped` only stored, as when the webhook lost it. */
  const command = async (text: string, options: { dropped?: boolean; at?: number } = {}) => {
    const fields = { chat: OPERATOR, sender: OPERATOR, text, ...(options.at === undefined ? {} : { at: options.at }) };
    return options.dropped ? stored(fields) : incoming(fields);
  };
  return {
    dir, bundle, groupsFile, clock, wacli, intake, queued, runs, webhooks, logs, stored, incoming, command, play, answer, holdSpacing,
    events: () => queued.map((entry) => eventOf(entry.prompt)),
    toGroups: () => wacli.sent.filter((entry) => entry.to !== OPERATOR),
    toOperator: () => wacli.sent.filter((entry) => entry.to === OPERATOR).map((entry) => entry.text),
    ledger: () => intake.status().recent,
    saved,
    /** The ids of every message the state file records as observed, in order. */
    observed: () => saved().ledger.filter((entry) => entry.action === "observed").flatMap((entry) => entry.ids ?? []),
  };
}

function savedState(dir: string): IntakeState {
  return JSON.parse(readFileSync(join(dir, "whatsapp-intake.json"), "utf8")) as IntakeState;
}

function livePayload(message: WaMessage): Record<string, unknown> {
  return {
    Chat: message.chat, ID: message.id, SenderJID: message.sender, Timestamp: new Date(message.at).toISOString(), FromMe: message.fromMe,
    Text: message.text, PushName: message.senderName, ReplyToID: message.replyToId ?? "", ReplyToSenderJID: message.replyToSender ?? "",
    Media: message.media ? { Type: message.media, Caption: "" } : null, IsForwarded: Boolean(message.forwarded),
    ReactionToID: message.service && !message.edited ? "3EB0X" : "", Revoked: false, Edited: Boolean(message.edited), PollVote: null, PollAdd: null, Call: null, ChatName: "",
  };
}

const readIn = (folder: string): Tool => ({ name: "Read", input: JSON.stringify({ file_path: join(folder, "guide.md") }) });

function eventOf(prompt: string): Record<string, any> {
  const block = prompt.split("[UNTRUSTED WEBHOOK EVENT DATA]\n")[1]?.split("\n[/UNTRUSTED WEBHOOK EVENT DATA]")[0] ?? "";
  return JSON.parse(block.slice(block.indexOf("{"))) as Record<string, any>;
}

const reply = (text: string, extra: Record<string, unknown> = {}) => ({ action: "reply", reply: text, reply_to: "", commitment: false, confidence: "high", sources: ["guide.md"], digest_line: "", ...extra });
const CLEAN = "Dobrý den, otevřete Nastavení → Integrace a klikněte na Připojit.";

/** wacli's store reads the edit time of `message` as `reads` say, one step per read, and then as it keeps it: `known` the
 * time it keeps, `unknown` none, and `stop` the time it keeps, after which wacli stores the operator's edit of that
 * message to STOP, a minute later. */
function editTimeReads(h: { wacli: FakeWacli; clock: { now: number } }, message: WaMessage, reads: Array<"known" | "unknown" | "stop">): void {
  const time = h.wacli.editedAt.bind(h.wacli);
  h.wacli.editedAt = async (chat, id) => {
    const step = id === message.id ? reads.shift() : undefined;
    const read: EditTime = step === "unknown" ? { unknown: "database is locked" } : await time(chat, id);
    if (step === "stop") {
      h.clock.now += 60_000;
      h.wacli.edited(message, "STOP");
    }
    return read;
  };
}

// ── configuration ─────────────────────────────────────────────────────────

describe("whatsappIntakeConfigFromEnv", () => {
  const env = { OMB_WHATSAPP_INTAKE: "1", OMB_WHATSAPP_INTAKE_BOT: "Support", OMB_WHATSAPP_INTAKE_GROUPS: "/srv/support/groups.json", OMB_WHATSAPP_INTAKE_OPERATOR: OPERATOR, OMB_WHATSAPP_INTAKE_BUNDLE: "/srv/support/bundle" };

  it("is off unless OMB_WHATSAPP_INTAKE is set, so upstream behaviour is unchanged", () => {
    expect(whatsappIntakeConfigFromEnv({})).toBeNull();
    expect(whatsappIntakeConfigFromEnv({ OMB_WHATSAPP_INTAKE: "0", OMB_WHATSAPP_INTAKE_BOT: "Support" })).toBeNull();
  });

  it("needs the bot, the map, the operator and the bundle, and refuses values it does not understand", () => {
    expect(whatsappIntakeConfigFromEnv(env)).toEqual({ bot: "Support", groupsFile: "/srv/support/groups.json", operator: OPERATOR, bundle: "/srv/support/bundle", maxDbSize: "2GB", selfIds: [] });
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE: "yes" })).toThrow(/OMB_WHATSAPP_INTAKE/);
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_BOT: "" })).toThrow(/OMB_WHATSAPP_INTAKE_BOT/);
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_GROUPS: "groups.json" })).toThrow(/absolute/);
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_OPERATOR: A })).toThrow(/OMB_WHATSAPP_INTAKE_OPERATOR/);
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_BUNDLE: "" })).toThrow(/OMB_WHATSAPP_INTAKE_BUNDLE/);
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_MAX_DB_SIZE: "lots" })).toThrow(/MAX_DB_SIZE/);
    expect(() => whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_SELF_IDS: "me" })).toThrow(/SELF_IDS/);
    expect(whatsappIntakeConfigFromEnv({ ...env, OMB_WHATSAPP_INTAKE_SELF_IDS: "123456789012345, 15550000001@s.whatsapp.net", OMB_WHATSAPP_INTAKE_MAX_DB_SIZE: "500MB", OMB_WHATSAPP_INTAKE_WACLI: "/opt/wacli" }))
      .toMatchObject({ selfIds: ["123456789012345", "15550000001@s.whatsapp.net"], maxDbSize: "500MB", wacliPath: "/opt/wacli" });
  });
});

describe("loadGroupMap", () => {
  const write = (map: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "omb-whatsapp-map-"));
    dirs.push(dir);
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "a.md"), "note");
    writeFileSync(join(dir, "groups.json"), JSON.stringify(map));
    return join(dir, "groups.json");
  };
  const group = { key: "a", name: "Group A", mode: "auto", note: "notes/a.md" };

  it("reads groups with defaults and their notes as absolute paths", () => {
    const file = write({ version: 1, groups: { [A]: group } });
    expect(loadGroupMap(file)).toEqual({
      groups: [{ chat: A, key: "a", name: "Group A", mode: "auto", note: join(file, "..", "notes", "a.md"), address: "vy", clientNames: [], owners: [] }],
      team: [], allowedLinks: [], environmentDomains: ["lazurio.io"],
    });
  });

  it("refuses what it cannot trust", () => {
    expect(() => loadGroupMap(write({ version: 1, groups: { [OPERATOR]: group } }))).toThrow(/@g\.us/);
    expect(() => loadGroupMap(write({ version: 1, groups: { [A]: group, [B]: group } }))).toThrow(/two groups have the key/);
    expect(() => loadGroupMap(write({ version: 1, groups: { [A]: { ...group, note: "../outside.md" } } }))).toThrow(/inside/);
    expect(() => loadGroupMap(write({ version: 1, groups: { [A]: { ...group, note: "notes/missing.md" } } }))).toThrow(/does not exist/);
    expect(() => loadGroupMap(write({ version: 1, groups: { [A]: { ...group, owners: ["Not A Login"] } } }))).toThrow(/GitHub login/);
    expect(() => loadGroupMap(write({ version: 1, groups: { [A]: { ...group, mode: "loud" } } }))).toThrow();
    expect(() => loadGroupMap(write({ version: 1, groups: { [A]: { ...group, sendTo: B } } }))).toThrow();
    expect(() => loadGroupMap(write({ version: 2, groups: {} }))).toThrow();
  });
});

// ── routing ───────────────────────────────────────────────────────────────

describe("routing", () => {
  it("hands a mention to the bot with one group's messages only and that group's note", async () => {
    const h = harness();
    await h.incoming({ chat: B, text: "Interní věc skupiny B, která nesmí do A." });
    await h.incoming({ chat: A, text: "Dobrý den, mám dotaz." });
    const mention = await h.incoming({ chat: A, text: `${MENTION} jak se připojím?` });
    expect(h.queued).toHaveLength(1);
    const event = h.events()[0];
    expect(event).toMatchObject({ source: "lazurio-whatsapp-intake", group: "Group A", trigger: "mention", trigger_message_ids: [mention.id] });
    expect(event.messages.map((message: { text: string }) => message.text)).toEqual(["Dobrý den, mám dotaz.", `${MENTION} jak se připojím?`]);
    expect(event.messages[0]).toMatchObject({ from: "client", name: "Client One", new: true });
    expect(JSON.stringify(event)).not.toContain("15550000101");
    const prompt = h.queued[0].prompt;
    expect(prompt).toContain("[UNTRUSTED WEBHOOK EVENT DATA]");
    expect(prompt).toContain("Note of group A");
    expect(prompt).not.toContain("Note of group B");
    expect(prompt).not.toContain("skupiny B");
    const hook = h.webhooks.list().find((candidate) => candidate.id === h.queued[0].webhookId)!;
    expect(hook).toMatchObject({ name: `${TRIGGER_NAME_PREFIX}a`, botId: "bot-support", eventTypes: [INTAKE_EVENT_TYPE], maxPendingRuns: 2 });
    expect(h.ledger()[0]).toMatchObject({ action: "run", group: "a", ids: [mention.id], runId: "run-1", reason: "mention" });
  });

  it("gives the bot no client name, owner login or chat id from the map: only the guards read them", async () => {
    const h = harness();
    const mention = await h.incoming({ chat: A, text: `${MENTION} jak se připojím?` });
    const hook = h.webhooks.list().find((candidate) => candidate.id === h.queued[0].webhookId)!;
    const seen = { prompt: h.queued[0].prompt, instructions: hook.prompt, payload: JSON.stringify(h.events()[0]) };
    expect(seen.prompt).toContain(mention.id);
    for (const [part, text] of Object.entries(seen)) {
      for (const hidden of ["contoso-labs", "fabrikam-ltd", "Contoso", "Fabrikam", userOf(A), userOf(B), userOf(OPERATOR), userOf(TEAM), userOf(CLIENT)]) {
        expect(text, `${part} holds ${hidden}`).not.toContain(hidden);
      }
    }
  });

  it("owns its webhooks' instructions: an edit in MausBot is replaced at the group's next run", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} první` });
    const id = h.queued[0].webhookId;
    const written = h.webhooks.list().find((candidate) => candidate.id === id)!.prompt;
    h.webhooks.update(id, { prompt: "Persona text pasted into the webhook." });
    await h.answer("run-1", reply(CLEAN));
    await h.incoming({ chat: A, text: `${MENTION} druhý` });
    expect(h.webhooks.list().find((candidate) => candidate.id === id)!.prompt).toBe(written);
    expect(h.queued[1].prompt).not.toContain("Persona text");
  });

  it("treats a reply to the account, or to a message it sent, as asking it", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: "Můžete mi pomoct?", replyToId: "3EB0OLD", replyToSender: SELF });
    expect(h.events()[0]).toMatchObject({ trigger: "reply" });
    await h.answer("run-1", reply(CLEAN));
    await h.incoming({ chat: A, text: "Děkuji, a dál?", replyToId: "3EB0SENT0001", replyToSender: "123456789012345@lid" });
    expect(h.events()[1]).toMatchObject({ trigger: "reply" });
  });

  it("ignores unmapped groups, its own messages and the team's, and reports a direct message to the operator once", async () => {
    const h = harness();
    await h.incoming({ chat: UNMAPPED, text: `${MENTION} ahoj` });
    await h.incoming({ chat: A, text: `${MENTION} vlastní zpráva`, fromMe: true, sender: SELF });
    await h.incoming({ chat: A, text: "Podívám se na to.", sender: TEAM });
    await h.incoming({ chat: OUTSIDER, sender: OUTSIDER, senderName: "Someone", text: "Soukromý dotaz" });
    await h.incoming({ chat: OUTSIDER, sender: OUTSIDER, senderName: "Someone", text: "Ještě jeden" });
    expect(h.queued).toEqual([]);
    expect(h.toGroups()).toEqual([]);
    expect(h.wacli.sent.some((entry) => entry.to === OUTSIDER)).toBe(false);
    expect(h.toOperator()).toEqual([expect.stringContaining("Soukromá zpráva pro tento účet od Someone")]);
    expect(h.intake.status().unmapped).toEqual([{ chat: UNMAPPED, lastAt: MONDAY_9 }]);
  });

  it("answers a team member who tags it, since a person asked", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: "Dotaz klienta." });
    const ask = await h.incoming({ chat: A, text: `${MENTION} odpověz prosím klientovi`, sender: TEAM, senderName: "Team Member" });
    expect(h.events()[0]).toMatchObject({ trigger: "mention", trigger_message_ids: [ask.id] });
    expect(h.events()[0].messages[1]).toMatchObject({ from: "team", name: "Team Member" });
  });

  it("only observes a group in observe mode: it classifies and wakes no model", async () => {
    const h = harness();
    await h.incoming({ chat: C, text: `${MENTION} test` });
    await h.incoming({ chat: C, text: "obyčejná zpráva" });
    expect(h.queued).toEqual([]);
    expect(h.ledger().map((entry) => entry.reason).sort()).toEqual(["batch", "mention"]);
    expect(h.ledger().every((entry) => entry.action === "observed")).toBe(true);
  });

  it("does not answer a mention older than an hour, and tells the operator", async () => {
    const h = harness();
    h.clock.now = MONDAY_9 + 90 * 60_000;
    await h.incoming({ chat: A, text: `${MENTION} pomoc`, at: MONDAY_9 + 10 * 60_000 });
    expect(h.queued).toEqual([]);
    expect(h.toOperator()).toEqual([expect.stringContaining("starší než hodina")]);
    expect(h.ledger()[0]).toMatchObject({ action: "missed", group: "a" });
  });

  it("receives the follower's signed webhook on its own loopback port", async () => {
    const h = harness();
    await h.intake.start();
    try {
      const webhook = h.wacli.webhook!;
      expect(webhook.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/events$/);
      const message: WaMessage = { chat: A, id: "3EB0LIVE01", sender: CLIENT, senderName: "Client One", at: h.clock.now, fromMe: false, text: `${MENTION} živě` };
      h.wacli.store.push(message);
      const body = JSON.stringify(livePayload(message));
      expect((await fetch(webhook.url, { method: "POST", body })).status).toBe(401);
      const signed = await fetch(webhook.url, { method: "POST", body, headers: { [SIGNATURE_HEADER]: wacliSignature(webhook.secret, body) } });
      expect(signed.status).toBe(204);
      await expect.poll(() => h.queued.length).toBe(1);
      h.wacli.events!({ kind: "connected" });
      expect(h.intake.status()).toMatchObject({ state: "ok", account: SELF, follower: { state: "connected" } });
    } finally {
      await h.intake.stop();
    }
  });
});

// ── batching and one run per group ────────────────────────────────────────

describe("batching", () => {
  it("waits 10 quiet minutes before an unasked run, or runs at 20 messages", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: "Nefunguje mi přihlášení." });
    h.clock.now += 9 * 60_000;
    await h.intake.tick();
    expect(h.queued).toEqual([]);
    await h.incoming({ chat: A, text: "Pořád to nejde." });
    h.clock.now += 9 * 60_000;
    await h.intake.tick();
    expect(h.queued).toEqual([]);
    h.clock.now += 60_000;
    await h.intake.tick();
    expect(h.events()[0]).toMatchObject({ trigger: "batch" });
    expect(h.events()[0].trigger_message_ids).toHaveLength(2);

    const busy = harness();
    for (let index = 0; index < 20; index++) await busy.incoming({ chat: B, text: `zpráva ${index}` });
    expect(busy.events()[0]).toMatchObject({ trigger: "batch", group: "Group B" });
  });

  it("skips a group while a team member is active in it", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: "Dotaz bez označení." });
    await h.incoming({ chat: A, text: "Kouknu na to.", sender: TEAM });
    h.clock.now += 11 * 60_000;
    await h.intake.tick();
    expect(h.queued).toEqual([]);
    await h.incoming({ chat: A, text: "Ještě něco." });
    h.clock.now += 3 * 60_000;
    await h.incoming({ chat: A, text: "A tohle." });
    h.clock.now += 1_000;
    await h.intake.tick();
    expect(h.queued).toEqual([]);
    h.clock.now += 10 * 60_000;
    await h.intake.tick();
    expect(h.queued).toHaveLength(1);
    const team = harness();
    await team.incoming({ chat: A, text: "Dotaz." });
    team.clock.now += 5 * 60_000;
    await team.incoming({ chat: A, text: "Odpovím za chvíli.", sender: TEAM });
    await team.incoming({ chat: A, text: "Díky." });
    team.clock.now += 10 * 60_000;
    await team.intake.tick();
    expect(team.queued).toEqual([]);
    expect(team.ledger()[0]).toMatchObject({ action: "skipped", reason: "team_active" });
    await team.incoming({ chat: A, text: `${MENTION} a teď?` });
    expect(team.events()[0]).toMatchObject({ trigger: "mention" });
  });

  it("runs one group at a time and keeps what asked meanwhile for the next run", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} první` });
    await h.incoming({ chat: A, text: `${MENTION} druhý` });
    await h.incoming({ chat: B, text: `${MENTION} jiná skupina` });
    expect(h.queued.map((entry) => eventOf(entry.prompt).group)).toEqual(["Group A", "Group B"]);
    await h.answer("run-1", reply(CLEAN));
    expect(h.events()[2]).toMatchObject({ group: "Group A", trigger: "mention" });
    expect(h.events()[2].messages.filter((message: { new?: boolean }) => message.new).map((message: { text: string }) => message.text)).toEqual([`${MENTION} druhý`]);
  });
});

// ── what the intake does with the answer ──────────────────────────────────

describe("sending and drafting", () => {
  it("sends a clean answer to the group that asked, quoting the message it answers", async () => {
    const h = harness();
    const first = await h.incoming({ chat: A, text: "Ahoj" });
    const mention = await h.incoming({ chat: A, text: `${MENTION} jak se připojím?` });
    await h.answer("run-1", reply(CLEAN, { reply_to: first.id }));
    expect(h.toGroups()).toEqual([{ to: A, text: CLEAN, replyTo: first.id }]);
    expect(h.ledger()[0]).toMatchObject({ action: "sent", group: "a", ids: ["3EB0SENT0001", first.id] });
    const second = await h.incoming({ chat: A, text: `${MENTION} a ještě?` });
    await h.answer("run-2", reply(CLEAN, { reply_to: "3EB0FROMANOTHERGROUP" }));
    expect(h.toGroups()[1]).toEqual({ to: A, text: CLEAN, replyTo: second.id });
    expect(mention.id).not.toBe(second.id);
  });

  it("sends only to the group whose messages the run judged", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: "Dotaz ve skupině A." });
    const mention = await h.incoming({ chat: B, text: `${MENTION} pomoc ve skupině B` });
    await h.answer("run-1", reply(CLEAN));
    expect(h.toGroups()).toEqual([{ to: B, text: CLEAN, replyTo: mention.id }]);
  });

  it("turns a commercial, committed or unsure reply into a draft for the operator", async () => {
    for (const [answer, reason] of [
      [reply("Cena je 4 900 Kč měsíčně."), "obchodní téma (cena)"],
      [reply("Dáme vám slevu."), "obchodní téma (sleva)"],
      [reply("Hotové to bude do pátku."), "obchodní téma (termín)"],
      [reply("Fakturu pošleme zítra."), "obchodní téma (faktura)"],
      [reply("Je to ve smlouvě."), "obchodní téma (smlouva)"],
      [reply("Garantujeme SLA."), "obchodní téma (SLA)"],
      [reply(CLEAN, { commitment: true }), "bot hlásí závazek"],
      [reply(CLEAN, { confidence: "low" }), "bot si není jistý"],
      [reply(CLEAN, { confidence: undefined }), "bot si není jistý"],
    ] as const) {
      const h = harness();
      await h.incoming({ chat: A, text: `${MENTION} kolik to stojí?` });
      await h.answer("run-1", answer);
      expect(h.toGroups()).toEqual([]);
      expect(h.toOperator()).toEqual([expect.stringContaining(reason)]);
      expect(h.toOperator()[0]).toContain(answer.reply);
      expect(h.ledger()[0]).toMatchObject({ action: "draft", group: "a" });
    }
  });

  it("drafts a reply that names another group, its client or owner, or links outside the allowlist", async () => {
    for (const text of ["U Fabrikam to fungovalo.", "Viz github.com/fabrikam-ltd/app", "Stejně jako Group B.", "Repo: https://github.com/someone/app", "https://launchpad.vm1.someorg.lazurio.io/"]) {
      const h = harness();
      await h.incoming({ chat: A, text: `${MENTION} jak to mají jinde?` });
      await h.answer("run-1", reply(text));
      expect(h.toGroups()).toEqual([]);
      expect(h.toOperator()[0]).toMatch(/zmiňuje jinou skupinu nebo klienta|odkaz na repozitář nebo Prostředí mimo povolené/);
    }
    const own = harness();
    await own.incoming({ chat: A, text: `${MENTION} a u nás?` });
    await own.answer("run-1", reply("Pro Contoso je návod na https://github.com/example-provider/handbook/blob/main/start.md a https://lazurio.io/."));
    expect(own.toGroups()).toHaveLength(1);
  });

  it("drafts the reply of a run that used a shell, gh, wacli, another tool or read outside the bundle", async () => {
    for (const [tools, words] of [
      [[{ name: "Bash", summary: "gh repo list some-client" }], "běh použil gh"],
      [[{ name: "Bash", summary: "wacli messages list --chat 120363000000000002@g.us" }], "běh použil wacli"],
      [[{ name: "Bash", summary: "ls" }], "běh použil shell"],
      [[{ name: "Read", input: JSON.stringify({ file_path: "/etc/hosts" }) }], "běh četl mimo podklady"],
      [[{ name: "mcp__agents__post_to_room", input: "{}" }], "běh použil mcp__agents__post_to_room"],
    ] as const) {
      const h = harness();
      await h.incoming({ chat: A, text: `${MENTION} pomoc` });
      await h.answer("run-1", reply(CLEAN), [...tools]);
      expect(h.toGroups()).toEqual([]);
      expect(h.toOperator()[0]).toContain(words);
    }
  });

  it("cannot vouch for a run on an engine without a tool log, or one it did not see start", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN), [], "piAgent");
    expect(h.toOperator()[0]).toContain("engine nehlásí nástroje");

    const unseen = harness();
    await unseen.incoming({ chat: A, text: `${MENTION} pomoc` });
    Object.assign(unseen.runs.get("run-1")!, { status: "completed", threadId: "thread-x", output: JSON.stringify(reply(CLEAN)) });
    await unseen.intake.tick();
    expect(unseen.toGroups()).toEqual([]);
    expect(unseen.toOperator()[0]).toContain("engine nehlásí nástroje");
  });

  it("checks reads against the bot's own folder when a search names no path", async () => {
    const inside = harness();
    await inside.incoming({ chat: A, text: `${MENTION} hledej` });
    await inside.answer("run-1", reply(CLEAN), [{ name: "Grep", input: JSON.stringify({ pattern: "Prostředí" }) }]);
    expect(inside.toGroups()).toHaveLength(1);
    const outside = harness({ botCwd: tmpdir() });
    await outside.incoming({ chat: A, text: `${MENTION} hledej` });
    await outside.answer("run-1", reply(CLEAN), [{ name: "Grep", input: JSON.stringify({ pattern: "Prostředí" }) }]);
    expect(outside.toGroups()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("follows a link in the bundle to the real file, so another group's note behind one is a draft", async () => {
    const file = harness();
    symlinkSync(join(file.dir, "notes", "b.md"), join(file.bundle, "faq.md"));
    await file.incoming({ chat: A, text: `${MENTION} pomoc` });
    await file.answer("run-1", reply(CLEAN), [{ name: "Read", input: JSON.stringify({ file_path: join(file.bundle, "faq.md") }) }]);
    expect(file.toGroups()).toEqual([]);
    expect(file.toOperator()[0]).toContain("běh četl mimo podklady");

    const folder = harness();
    symlinkSync(join(folder.dir, "notes"), join(folder.bundle, "shared"));
    await folder.incoming({ chat: A, text: `${MENTION} hledej` });
    await folder.answer("run-1", reply(CLEAN), [{ name: "Grep", input: JSON.stringify({ pattern: "Note of group" }) }]);
    expect(folder.toGroups()).toEqual([]);
    expect(folder.toOperator()[0]).toContain("běh četl, kde nejde ověřit");
  });

  it("keeps to 6 messages an hour per group, then drafts", async () => {
    const h = harness();
    for (let index = 1; index <= 7; index++) {
      await h.incoming({ chat: A, text: `${MENTION} dotaz ${index}` });
      await h.answer(`run-${index}`, reply(`${CLEAN} (${index})`));
      h.clock.now += 60_000;
    }
    expect(h.toGroups()).toHaveLength(6);
    expect(h.toOperator()).toEqual([expect.stringContaining("limit zpráv za hodinu")]);
    h.clock.now += 60 * 60_000;
    await h.incoming({ chat: A, text: `${MENTION} po hodině` });
    await h.answer("run-8", reply(CLEAN));
    expect(h.toGroups()).toHaveLength(7);
  });

  it("spaces its sends 3 to 8 seconds apart", async () => {
    const h = harness();
    const times: number[] = [];
    const send = h.wacli.sendText.bind(h.wacli);
    h.wacli.sendText = async (to, text, replyTo) => { times.push(h.clock.now); return send(to, text, replyTo); };
    await h.incoming({ chat: A, text: `${MENTION} jedna` });
    await h.answer("run-1", { ...reply(CLEAN), action: "reply_and_escalate", escalation: { urgency: "high", summary: "Klient čeká na přístup.", next_step: "Ozvěte se mu." } });
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(3_000);
    expect(times[1] - times[0]).toBeLessThanOrEqual(8_000);
  });

  it("drafts in a draft-mode group and for an unasked batch, even when every guard passes", async () => {
    const h = harness();
    await h.incoming({ chat: D, text: `${MENTION} dotaz` });
    await h.answer("run-1", reply(CLEAN));
    expect(h.toOperator()[0]).toContain("skupina je v režimu návrhů");
    await h.incoming({ chat: A, text: "Nefunguje mi to." });
    h.clock.now += 11 * 60_000;
    await h.intake.tick();
    await h.answer("run-2", reply(CLEAN));
    expect(h.toGroups()).toEqual([]);
    expect(h.toOperator()[1]).toContain("nikdo se bota neptal");
  });

  it("escalates to the operator, and reports an invalid answer or a failed run without writing to the group", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} smažte mi data` });
    await h.answer("run-1", { action: "escalate", escalation: { urgency: "high", summary: "Klient chce smazat data.", next_step: "Zavolejte mu." }, commitment: false, confidence: "high" });
    expect(h.toOperator()[0]).toMatch(/Eskalace, naléhavost vysoká: Klient chce smazat data\.\nNávrh: Zavolejte mu\./);
    await h.incoming({ chat: A, text: `${MENTION} a teď` });
    await h.answer("run-2", "I will just answer them myself.");
    expect(h.toOperator()[1]).toContain("Výstup bota je neplatný");
    await h.incoming({ chat: A, text: `${MENTION} haló` });
    h.runs.get("run-3")!.status = "failed";
    await h.intake.tick();
    expect(h.toOperator()[2]).toContain("Bot nedokončil odpověď");
    expect(h.toGroups()).toEqual([]);
  });

  it("drafts what it could not send", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    h.wacli.failSend = true;
    await h.answer("run-1", reply(CLEAN));
    expect(h.ledger().map((entry) => entry.action)).toContain("send_failed");
    expect(h.toGroups()).toEqual([]);
  });

  it("records a draft the operator's chat did not take as failed, also after a reply went out", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} první` });
    await h.answer("run-1", reply(CLEAN));
    h.wacli.failSend = true;
    await h.incoming({ chat: A, text: `${MENTION} druhý` });
    await h.answer("run-2", reply(CLEAN, { confidence: "low" }));
    expect(h.ledger()[0]).toMatchObject({ action: "send_failed", group: "a", runId: "run-2", reason: "operator" });
  });
});

// ── the operator ──────────────────────────────────────────────────────────

describe("STOP and START", () => {
  it("pauses sending everywhere or in one group, survives a restart, and listens only to the operator's own chat", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: "STOP" });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    await h.incoming({ chat: OPERATOR, sender: OPERATOR, text: "STOP" });
    expect(h.toOperator()[0]).toContain("Odesílání do všech skupin je pozastavené");
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN));
    expect(h.toGroups()).toEqual([]);
    expect(h.toOperator()[1]).toContain("odesílání je pozastavené (STOP)");

    const again = harness({ dir: h.dir, wacli: h.wacli, now: h.clock.now + 1_000 });
    expect(again.intake.status().stopped).toEqual({ all: true, groups: [] });
    await again.incoming({ chat: OPERATOR, sender: OPERATOR, text: " start " });
    expect(again.intake.status().stopped).toEqual({ all: false, groups: [] });
    await again.incoming({ chat: OPERATOR, sender: OPERATOR, text: "STOP b" });
    await again.incoming({ chat: OPERATOR, sender: OPERATOR, text: "STOP z" });
    expect(h.wacli.sent.at(-1)!.text).toContain("Skupinu „z“ neznám");
    await again.incoming({ chat: A, text: `${MENTION} pomoc` });
    await again.answer("run-1", reply(CLEAN));
    await again.incoming({ chat: B, text: `${MENTION} pomoc` });
    await again.answer("run-2", reply(CLEAN));
    expect(again.toGroups().map((entry) => entry.to)).toEqual([A]);
    await again.incoming({ chat: OPERATOR, sender: OPERATOR, text: "START b" });
    expect(again.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(again.ledger().filter((entry) => entry.action === "command").map((entry) => [entry.reason, entry.group])).toEqual([
      ["start", "b"], ["stop", "b"], ["start", undefined], ["stop", undefined],
    ]);
  });

  it("stops a reply that waits for its spacing when STOP comes meanwhile", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} první` });
    await h.answer("run-1", reply(CLEAN));
    await h.incoming({ chat: A, text: `${MENTION} druhý` });
    const spacing = h.holdSpacing();
    const answered = h.answer("run-2", reply(CLEAN));
    await spacing.waiting;
    const stopped = h.incoming({ chat: OPERATOR, sender: OPERATOR, text: "STOP" });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    spacing.release();
    await Promise.all([answered, stopped]);
    expect(h.toGroups()).toHaveLength(1);
    expect(h.toOperator()).toEqual([
      expect.stringContaining("Odesílání do všech skupin je pozastavené"), expect.stringContaining("odesílání je pozastavené (STOP)"),
    ]);
    expect(h.ledger()[0]).toMatchObject({ action: "draft", group: "a", runId: "run-2", reason: "paused" });
  });

  /** Run 2's reply in group A waits for its send spacing while `meanwhile` runs, as wacli stores what comes then. */
  const spaced = async (meanwhile: (h: ReturnType<typeof harness>) => unknown) => {
    const h = harness();
    await h.intake.catchUp();
    await h.incoming({ chat: A, text: `${MENTION} první` });
    await h.answer("run-1", reply(CLEAN));
    await h.incoming({ chat: A, text: `${MENTION} druhý` });
    const spacing = h.holdSpacing();
    const answered = h.answer("run-2", reply(CLEAN));
    await spacing.waiting;
    await meanwhile(h);
    spacing.release();
    await answered;
    return h;
  };

  it("stops a reply that waits for its spacing when wacli stores a STOP meanwhile and the webhook drops it", async () => {
    const h = await spaced((h) => h.command("STOP", { dropped: true }));
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.toGroups()).toHaveLength(1);
    expect(h.toOperator()).toEqual([
      expect.stringContaining("Odesílání do všech skupin je pozastavené"), expect.stringContaining("odesílání je pozastavené (STOP)"),
    ]);
    expect(h.ledger()[0]).toMatchObject({ action: "draft", group: "a", runId: "run-2", reason: "paused" });
  });

  it("holds a spaced reply while its last look finds more of the journal than one catch-up reads, and drafts it when the journal cannot be read or no longer reaches the checkpoint", async () => {
    for (const stop of [true, false]) {
      const h = await spaced(async (h) => {
        for (let index = 0; index < 1_200; index++) h.stored({ chat: C, text: `zpráva ${index}` });
        if (stop) await h.command("STOP", { dropped: true });
      });
      expect(h.toGroups()).toHaveLength(1);
      expect(h.toOperator()).toEqual([]);
      expect(h.intake.status().groups.find((group) => group.key === "a")!.runId).toBe("run-2");
      await h.intake.tick();
      expect(h.intake.status().stopped).toEqual({ all: stop, groups: [] });
      expect(h.toGroups()).toHaveLength(stop ? 1 : 2);
      expect(h.ledger()[0]).toMatchObject(stop ? { action: "draft", group: "a", runId: "run-2", reason: "paused" } : { action: "sent", group: "a", runId: "run-2" });
    }
    const failed = await spaced((h) => { h.wacli.journalFailure = "wacli messages changes: database disk image is malformed"; });
    expect(failed.toGroups()).toHaveLength(1);
    expect(failed.toOperator()).toEqual([
      expect.stringContaining("Dohledávání zpráv, které webhook ztratil, nefunguje"), expect.stringContaining("dohledávání ztracených zpráv nefunguje"),
    ]);
    expect(failed.ledger()[0]).toMatchObject({ action: "draft", group: "a", runId: "run-2", reason: "catch_up" });
    const lost = await spaced((h) => {
      h.stored({ chat: A, text: "Zpráva, kterou už nikdo nedohledá." });
      h.wacli.expiredBefore = h.wacli.journal.length;
    });
    expect(lost.toGroups()).toHaveLength(1);
    expect(lost.toOperator()).toEqual([expect.stringContaining("Dohledávání zpráv nemůže navázat"), expect.stringContaining("odesílání je pozastavené (STOP)")]);
    expect(lost.ledger()[0]).toMatchObject({ action: "draft", group: "a", runId: "run-2", reason: "paused" });
  });

  it("keeps a newer STOP when the catch-up finds an older START the webhook dropped, for all groups or one", async () => {
    for (const key of ["", " b"]) {
      const h = harness();
      await h.intake.catchUp();
      await h.command(`STOP${key}`);
      h.clock.now += 60_000;
      await h.command(`START${key}`, { dropped: true });
      h.clock.now += 60_000;
      await h.command(`STOP${key}`);
      expect(await h.intake.catchUp()).toMatchObject({ messages: 1, errors: 0 });
      expect(h.intake.status().stopped).toEqual(key ? { all: false, groups: ["b"] } : { all: true, groups: [] });
      expect(h.toOperator().at(-1)).toBe(`Příkaz START${key} z 09:01 nic nemění, platí STOP${key} z 09:02.`);
      await h.incoming({ chat: B, text: `${MENTION} pomoc` });
      await h.answer("run-1", reply(CLEAN));
      expect(h.toGroups()).toEqual([]);
      expect(h.ledger().filter((entry) => entry.action === "command").map((entry) => entry.reason)).toEqual(["start:superseded", "stop", "stop"]);
    }
  });

  it("lets the later command decide between one for all groups and one for a single group", async () => {
    const h = harness();
    await h.intake.catchUp();
    const paused = () => Object.fromEntries(h.intake.status().groups.map((group) => [group.key, group.paused]));
    const at = (minutes: number) => { h.clock.now = MONDAY_9 + minutes * 60_000; };
    await h.command("STOP b");
    at(1);
    await h.command("START");
    expect(paused()).toEqual({ a: false, b: false, c: false, d: false });
    at(2);
    await h.command("STOP");
    at(3);
    await h.command("START b");
    expect(h.toOperator().at(-1)).toBe("Odesílání do skupiny Group B je obnovené.");
    expect(paused()).toEqual({ a: true, b: false, c: true, d: true });
    await h.incoming({ chat: B, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN));
    expect(h.toGroups().map((entry) => entry.to)).toEqual([B]);

    at(4);
    await h.command("STOP b", { dropped: true });
    at(5);
    await h.command("START");
    expect(paused()).toEqual({ a: false, b: false, c: false, d: false });
    at(6);
    await h.command("STOP", { dropped: true });
    at(7);
    await h.command("START a");
    await h.intake.catchUp();
    expect(paused()).toEqual({ a: false, b: true, c: true, d: true });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.toOperator().slice(-2)).toEqual([
      "Příkaz STOP b z 09:04 nic nemění, platí START z 09:05.",
      "Odesílání do všech skupin kromě Group A (platí START a z 09:07) je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.",
    ]);
  });

  it("counts a STOP and a START of the same second as a STOP, in whatever order they came or wacli stored them", async () => {
    const live = harness();
    await live.command("STOP");
    await live.command("START");
    expect(live.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(live.toOperator().at(-1)).toBe("Příkaz START z 09:00 nic nemění, platí STOP z 09:00.");
    const reverse = harness();
    await reverse.command("START");
    await reverse.command("STOP");
    expect(reverse.intake.status().stopped).toEqual({ all: true, groups: [] });

    const mixed = harness();
    await mixed.intake.catchUp();
    await mixed.command("START", { dropped: true });
    await mixed.command("STOP");
    await mixed.intake.catchUp();
    expect(mixed.intake.status().stopped).toEqual({ all: true, groups: [] });

    for (const [first, second] of [["STOP", "START"], ["START", "STOP"]] as const) {
      const found = harness();
      await found.intake.catchUp();
      await found.command(first, { dropped: true });
      await found.command(second, { dropped: true });
      await found.intake.catchUp();
      expect(found.intake.status().stopped).toEqual({ all: true, groups: [] });
    }
  });

  it("never resumes sending for a START in an edit, a deleted message or a reaction, and keeps a STOP in one", async () => {
    const h = harness();
    await h.intake.catchUp();
    await h.command("STOP");
    h.clock.now += 60_000;
    const typo = await h.command("Strat", { dropped: true });
    h.wacli.edited(typo, "START");
    expect(await h.intake.catchUp()).toMatchObject({ changes: 3, messages: 1, errors: 0 });
    await h.incoming({ chat: OPERATOR, sender: OPERATOR, text: "START", service: true });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.toOperator()).toHaveLength(1);
    h.clock.now += 60_000;
    await h.command("START");
    h.clock.now += 60_000;
    const stop = await h.command("Stoop", { dropped: true });
    h.wacli.edited(stop, "STOP");
    await h.intake.catchUp();
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
  });

  it("takes a STOP in an edit of a message it keeps or forgot, the edit's webhook dropped, from when it reads the edit, so an older START never overrides it", async () => {
    for (const forgotten of [false, true]) {
      const h = harness();
      await h.intake.catchUp();
      const typo = await h.command("Stoop");
      if (forgotten) for (let index = 0; index < 600; index++) await h.command(`poznámka ${index}`);
      h.clock.now += 60_000;
      await h.command("START");
      expect(await h.intake.catchUp()).toMatchObject({ errors: 0, more: false });
      expect(h.saved().chats[OPERATOR]!.seen.some((entry) => entry.id === typo.id)).toBe(!forgotten);
      h.clock.now += 60_000;
      h.wacli.edited(typo, "STOP");
      expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: forgotten ? 1 : 0, errors: 0, more: false });
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
      expect(h.toOperator().at(-1)).toBe("Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.");
      await h.incoming({ chat: A, text: `${MENTION} pomoc` });
      await h.answer("run-1", reply(CLEAN));
      expect(h.toGroups()).toEqual([]);
    }
  });

  it("pauses when the operator edits the START in force into a STOP", async () => {
    const h = harness();
    await h.intake.catchUp();
    await h.command("STOP b");
    h.clock.now += 60_000;
    const start = await h.command("START b");
    await h.intake.catchUp();
    h.clock.now += 60_000;
    h.wacli.edited(start, "STOP b");
    await h.intake.catchUp();
    expect(h.intake.status().stopped).toEqual({ all: false, groups: ["b"] });
  });

  it("reads an edit the webhook delivers from wacli's journal, once, so a START sent after it stands", async () => {
    const h = harness();
    await h.intake.catchUp();
    const typo = await h.command("Stoop");
    await h.intake.catchUp();
    h.clock.now += 60_000;
    h.wacli.edited(typo, "STOP");
    await h.intake.receive(livePayload({ ...typo, at: h.clock.now }));
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    h.clock.now += 60_000;
    await h.command("START");
    expect(await h.intake.catchUp()).toMatchObject({ errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(h.toOperator()).toEqual([
      "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.", "Odesílání do všech skupin je obnovené.",
    ]);
  });

  it("never resumes sending for an edit to START of a message it keeps or forgot, delivered or dropped", async () => {
    for (const forgotten of [false, true]) {
      const h = harness();
      await h.intake.catchUp();
      await h.command("STOP");
      h.clock.now += 60_000;
      const typo = await h.command("Strat");
      if (forgotten) for (let index = 0; index < 600; index++) await h.command(`poznámka ${index}`);
      await h.intake.catchUp();
      h.clock.now += 60_000;
      h.wacli.edited(typo, "START");
      await h.intake.catchUp();
      h.wacli.edited(typo, "START");
      await h.intake.receive(livePayload({ ...typo, at: h.clock.now }));
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
      expect(h.toOperator()).toHaveLength(1);
    }
  });

  it("takes a STOP in an edit of a message from before its first start, delivered or dropped, but neither a command from then nor the account's own edit, and an edit to START still resumes nothing", async () => {
    for (const delivered of [false, true]) {
      const h = harness();
      const shown: string[] = [];
      const show = h.wacli.message.bind(h.wacli);
      h.wacli.message = async (chat, id) => { shown.push(id); return show(chat, id); };
      // Stored before the first checkpoint, so history; WhatsApp offers an edit for 15 minutes after a message is sent.
      const early = MONDAY_9 - 10 * 60_000;
      const old = await h.command("STOP", { dropped: true, at: early });
      const own = h.stored({ chat: OPERATOR, sender: SELF, senderName: "", fromMe: true, text: "Napsáno z telefonu účtu.", at: early });
      const typo = await h.command("Stoop", { dropped: true, at: early });
      const strat = await h.command("Strat", { dropped: true, at: early });
      await h.intake.catchUp();
      // A command from then stays history when wacli rewrites it, or stores one from then only now.
      h.wacli.changed(old);
      const late = await h.command("STOP b", { dropped: true, at: early });
      await h.intake.catchUp();
      expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
      const edit = async (message: WaMessage, text: string) => {
        h.clock.now += 60_000;
        h.wacli.edited(message, text);
        if (delivered) await h.intake.receive(livePayload({ ...message, at: h.clock.now }));
        else await h.intake.catchUp();
      };
      await edit(own, "STOP");
      expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
      await edit(typo, "STOP");
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
      expect(h.toOperator()).toEqual(["Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START."]);
      await edit(strat, "START");
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
      expect(h.toOperator()).toHaveLength(1);
      // Each edit is judged from wacli's store by the catch-up, never from the webhook's copy.
      expect(shown).toEqual([old.id, late.id, own.id, typo.id, strat.id]);
      await h.incoming({ chat: A, text: `${MENTION} pomoc` });
      await h.answer("run-1", reply(CLEAN));
      expect(h.toGroups()).toEqual([]);
    }
  });

  it("judges an edit once, by wacli's edit time, so wacli rewriting an edited STOP never overrides a later START, kept or forgotten, also after a restart", async () => {
    for (const forgotten of [false, true]) {
      for (const restart of [false, true]) {
        const first = harness();
        await first.intake.catchUp();
        const typo = await first.incoming({ chat: OPERATOR, sender: "123456789012345@lid", text: "Stoop" });
        await first.intake.catchUp();
        first.clock.now += 60_000;
        first.wacli.edited(typo, "STOP");
        await first.intake.catchUp();
        expect(first.intake.status().stopped).toEqual({ all: true, groups: [] });
        first.clock.now += 60_000;
        await first.command("START");
        if (forgotten) for (let index = 0; index < 600; index++) await first.command(`poznámka ${index}`);
        expect(await first.intake.catchUp()).toMatchObject({ errors: 0, more: false });
        expect(first.saved().chats[OPERATOR]!.seen.some((entry) => entry.id === typo.id)).toBe(!forgotten);
        const h = restart ? harness({ dir: first.dir, wacli: first.wacli, now: first.clock.now + 1_000 }) : first;
        const told = h.toOperator().length;
        // wacli normalizes the sender's LID to the phone number: the same edit, one more upsert.
        h.wacli.rewritten(typo, { sender: OPERATOR });
        expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: forgotten ? 1 : 0, errors: 0, more: false });
        expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
        expect(h.toOperator().slice(told)).toEqual([]);
        await h.incoming({ chat: A, text: `${MENTION} pomoc` });
        await h.answer("run-1", reply(CLEAN));
        expect(h.toGroups()).toHaveLength(1);
      }
    }
  });

  it("takes an edit back to STOP after an edit to another text for a new edit, and keeps no text of an edit", async () => {
    const h = harness();
    await h.intake.catchUp();
    const typo = await h.command("Stoop");
    await h.intake.catchUp();
    const edit = async (text: string) => {
      h.clock.now += 60_000;
      h.wacli.edited(typo, text);
      await h.intake.catchUp();
    };
    await edit("STOP");
    h.clock.now += 60_000;
    await h.command("START");
    await edit("Díky, už je to vyřešené.");
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(readFileSync(join(h.dir, "whatsapp-intake.json"), "utf8")).not.toContain("vyřešené");
    await edit("STOP");
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    expect(h.toOperator()).toEqual([paused, "Odesílání do všech skupin je obnovené.", paused]);
  });

  it("pauses for an edit to another text and one back to STOP that one catch-up reads together, by wacli's edit time, kept, forgotten or after a restart", async () => {
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    for (const forgotten of [false, true]) {
      for (const restart of [false, true]) {
        const first = harness();
        await first.intake.catchUp();
        const typo = await first.command("Stoop");
        await first.intake.catchUp();
        first.clock.now += 60_000;
        first.wacli.edited(typo, "STOP");
        await first.intake.catchUp();
        first.clock.now += 60_000;
        await first.command("START");
        if (forgotten) for (let index = 0; index < 600; index++) await first.command(`poznámka ${index}`);
        expect(await first.intake.catchUp()).toMatchObject({ errors: 0, more: false });
        expect(first.intake.status().stopped).toEqual({ all: false, groups: [] });
        const h = restart ? harness({ dir: first.dir, wacli: first.wacli, now: first.clock.now + 1_000 }) : first;
        const told = h.toOperator().length;
        // Pablo's review of 4882f0da: both edits are stored before a catch-up reads either, so both entries read the final STOP.
        h.clock.now += 60_000;
        h.wacli.edited(typo, "Díky, už je to vyřešené.");
        h.clock.now += 60_000;
        h.wacli.edited(typo, "STOP");
        expect(await h.intake.catchUp()).toEqual({ changes: 2, messages: forgotten ? 1 : 0, errors: 0, more: false });
        expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
        expect(h.toOperator().slice(told)).toEqual([paused]);
        await h.incoming({ chat: A, text: `${MENTION} pomoc` });
        await h.answer("run-1", reply(CLEAN));
        expect(h.toGroups()).toEqual([]);
      }
    }
  });

  it("reads an edit's time before and after its text, so an edit wacli stores right after the text is read applies at once, and its own entry never undoes a later START", async () => {
    const h = harness();
    await h.intake.catchUp();
    const typo = await h.command("Stoop");
    await h.intake.catchUp();
    h.clock.now += 60_000;
    h.wacli.edited(typo, "Díky, už je to vyřešené.");
    const show = h.wacli.message.bind(h.wacli);
    let raced = false;
    h.wacli.message = async (chat, id) => {
      const row = await show(chat, id);
      const read = row && { ...row };
      // The operator edits the message once more right after the catch-up read its text.
      if (id === typo.id && !raced) {
        raced = true;
        h.clock.now += 60_000;
        h.wacli.edited(typo, "STOP");
      }
      return read;
    };
    expect(await h.intake.catchUp()).toMatchObject({ changes: 1, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    h.clock.now += 60_000;
    await h.command("START");
    expect(await h.intake.catchUp()).toMatchObject({ changes: 2, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(h.toOperator()).toEqual([
      "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.", "Odesílání do všech skupin je obnovené.",
    ]);
  });

  it("judges an edit by a time and a text of the same edit, so a STOP wacli stores between the reads of an earlier edit's time and its text pauses once and never undoes a later START, kept, forgotten or after a restart", async () => {
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    for (const forgotten of [false, true]) {
      for (const restart of [false, true]) {
        const first = harness();
        await first.intake.catchUp();
        const typo = await first.command("Stoop");
        if (forgotten) for (let index = 0; index < 600; index++) await first.command(`poznámka ${index}`);
        expect(await first.intake.catchUp()).toMatchObject({ errors: 0, more: false });
        expect(first.saved().chats[OPERATOR]!.seen.some((entry) => entry.id === typo.id)).toBe(!forgotten);
        first.clock.now += 60_000;
        first.wacli.edited(typo, "Díky, už je to vyřešené.");
        // Pablo's review of da07c4cd: the catch-up reads the time of that edit, then wacli stores an edit to STOP before
        // the catch-up reads the text.
        const time = first.wacli.editedAt.bind(first.wacli);
        let raced = false;
        first.wacli.editedAt = async (chat, id) => {
          const read = await time(chat, id);
          if (id === typo.id && !raced) {
            raced = true;
            first.clock.now += 60_000;
            first.wacli.edited(typo, "STOP");
          }
          return read;
        };
        expect(await first.intake.catchUp()).toEqual({ changes: 1, messages: forgotten ? 1 : 0, errors: 0, more: false });
        expect(first.intake.status().stopped).toEqual({ all: true, groups: [] });
        first.clock.now += 60_000;
        await first.command("START");
        const h = restart ? harness({ dir: first.dir, wacli: first.wacli, now: first.clock.now + 1_000 }) : first;
        // The next catch-up reads the STOP's own journal entry, then the START's.
        expect(await h.intake.catchUp()).toEqual({ changes: 2, messages: 0, errors: 0, more: false });
        expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
        expect(h.toOperator()).toEqual([paused, "Odesílání do všech skupin je obnovené."]);
        await h.incoming({ chat: A, text: `${MENTION} pomoc` });
        await h.answer("run-1", reply(CLEAN));
        expect(h.toGroups()).toHaveLength(1);
      }
    }
  });

  it("reads an edit's text again while its edit time moves, three times at most, and takes a change whose time moved at every read for a STOP for all groups: the operator hears why once until the store gives one time again, and those edits, read again, never undo a later START", async () => {
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    const resumed = "Odesílání do všech skupin je obnovené.";
    const moved = "Čas úpravy zprávy byl v úložišti wacli při každém čtení jiný nebo nešel přečíst, takže nejde poznat, ke které úpravě patří její text. Proto se taková změna bere jako STOP pro všechny skupiny. Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.";
    const h = harness();
    await h.intake.catchUp();
    const typo = await h.command("Stoop");
    await h.intake.catchUp();
    // The operator edits the message once more right after each of the next reads of its text, a second later each time.
    const queued: string[] = [];
    const show = h.wacli.message.bind(h.wacli);
    h.wacli.message = async (chat, id) => {
      const row = await show(chat, id);
      const read = row && { ...row };
      const text = id === typo.id ? queued.shift() : undefined;
      if (text !== undefined) {
        h.clock.now += 1_000;
        h.wacli.edited(typo, text);
      }
      return read;
    };
    const resume = async () => {
      h.clock.now += 60_000;
      await h.command("START");
    };
    // It moves twice: the third read settles, on the STOP, and the edits read again are that edit.
    h.clock.now += 60_000;
    h.wacli.edited(typo, "Díky.");
    queued.push("Díky!", "STOP");
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 0, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    await resume();
    expect(await h.intake.catchUp()).toEqual({ changes: 3, messages: 0, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(h.toOperator()).toEqual([paused, resumed]);
    // It moves at all three reads, and the text read last is no STOP: a STOP for all groups all the same.
    const burst = () => queued.push("Díky!", "Díky, už je to vyřešené.", "STOP");
    h.clock.now += 60_000;
    h.wacli.edited(typo, "Díky.");
    burst();
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 0, errors: 0, more: false });
    expect(h.intake.status()).toMatchObject({ stopped: { all: true, groups: [] }, lastError: "wacli's store gave another edit time, or none, at every read" });
    expect(h.toOperator().slice(2)).toEqual([moved, paused]);
    // After a START, those edits are read with the newest time read, so they change nothing.
    await resume();
    expect(await h.intake.catchUp()).toEqual({ changes: 4, messages: 0, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    // The store gave one time since, so when the time moves at every read again, the operator hears why again. A second
    // such change before the store gives one time pauses again, without a second notice.
    h.clock.now += 60_000;
    h.wacli.edited(typo, "Díky.");
    burst();
    await h.intake.catchUp();
    await resume();
    burst();
    expect(await h.intake.catchUp()).toEqual({ changes: 4, messages: 0, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.toOperator().slice(4)).toEqual([resumed, moved, paused, resumed, paused]);
  });

  it("takes every change to an edited message for a new edit while wacli's store cannot tell its edit time: a STOP in it pauses, and the operator hears that once", async () => {
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    const resumed = "Odesílání do všech skupin je obnovené.";
    for (const problem of ["no such column: edited_ts", "file is not a database"]) {
      const unknown = `Čas úpravy zprávy nejde v úložišti wacli přečíst (${problem}). Dokud nepůjde, každá změna upravené zprávy se bere jako nová úprava: STOP v ní pozastaví odesílání i po zprávě START. Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.`;
      const h = harness();
      await h.intake.catchUp();
      const typo = await h.command("Stoop");
      await h.intake.catchUp();
      h.clock.now += 60_000;
      h.wacli.edited(typo, "STOP");
      await h.intake.catchUp();
      h.clock.now += 60_000;
      await h.command("START");
      await h.intake.catchUp();
      h.wacli.editTimeProblem = problem;
      // Two rewrites, one catch-up: either may be an edit, and the STOP in force, read again, says nothing.
      h.wacli.rewritten(typo, { senderName: "Provoz" });
      h.wacli.rewritten(typo, { senderName: "Podpora" });
      expect(await h.intake.catchUp()).toEqual({ changes: 2, messages: 0, errors: 0, more: false });
      expect(h.intake.status()).toMatchObject({ stopped: { all: true, groups: [] }, lastError: problem });
      expect(h.toOperator()).toEqual([paused, resumed, unknown, paused]);
      h.clock.now += 60_000;
      await h.command("START");
      h.wacli.rewritten(typo, { senderName: "Provoz" });
      await h.intake.catchUp();
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
      expect(h.toOperator().slice(4)).toEqual([resumed, paused]);
      // Once the store tells again, a rewrite is a rewrite; when it cannot tell once more, the operator hears it again.
      delete h.wacli.editTimeProblem;
      h.clock.now += 60_000;
      await h.command("START");
      h.wacli.rewritten(typo, { senderName: "Podpora" });
      await h.intake.catchUp();
      expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
      h.wacli.editTimeProblem = problem;
      h.wacli.rewritten(typo, { senderName: "Provoz" });
      await h.intake.catchUp();
      expect(h.toOperator().slice(6)).toEqual([resumed, unknown, paused]);
    }
  });

  it("remembers the newest edit time the reads gave when they tie none to the text, so a STOP applied while the store's reads of the time failed by turns never undoes a later START once the store tells again, and a new edit to STOP after that START pauses, kept, forgotten or after a restart", async () => {
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    const resumed = "Odesílání do všech skupin je obnovené.";
    const moved = "Čas úpravy zprávy byl v úložišti wacli při každém čtení jiný nebo nešel přečíst, takže nejde poznat, ke které úpravě patří její text. Proto se taková změna bere jako STOP pro všechny skupiny. Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.";
    for (const again of [false, true]) {
      for (const forgotten of [false, true]) {
        for (const restart of [false, true]) {
          const first = harness();
          await first.intake.catchUp();
          const typo = await first.command("Stoop");
          if (forgotten) for (let index = 0; index < 600; index++) await first.command(`poznámka ${index}`);
          expect(await first.intake.catchUp()).toMatchObject({ errors: 0, more: false });
          first.clock.now += 60_000;
          first.wacli.edited(typo, "Díky, už je to vyřešené.");
          // Pablo's review of 1cbf1ccb: the catch-up reads the time of that edit, wacli stores an edit to STOP, and the
          // store's next reads of the time fail, give the STOP's, and fail again.
          editTimeReads(first, typo, ["stop", "unknown", "known", "unknown"]);
          expect(await first.intake.catchUp()).toEqual({ changes: 1, messages: forgotten ? 1 : 0, errors: 0, more: false });
          const { stopped, lastError } = first.intake.status();
          expect(stopped).toEqual({ all: true, groups: [] });
          first.clock.now += 60_000;
          await first.command("START");
          const h = restart ? harness({ dir: first.dir, wacli: first.wacli, now: first.clock.now + 1_000 }) : first;
          if (again) {
            // A new edit after the START: the operator edits the STOP to another text and back.
            h.clock.now += 60_000;
            h.wacli.edited(typo, "Díky.");
            h.clock.now += 1_000;
            h.wacli.edited(typo, "STOP");
          }
          // The store tells the time again. The next catch-up reads the STOP's own journal entry, the START's, and the new edits'.
          expect(await h.intake.catchUp()).toEqual({ changes: again ? 4 : 2, messages: 0, errors: 0, more: false });
          expect(h.intake.status().stopped).toEqual({ all: again, groups: [] });
          expect(lastError).toBe("wacli's store gave another edit time, or none, at every read");
          expect(h.toOperator()).toEqual([moved, paused, resumed, ...(again ? [paused] : [])]);
          await h.incoming({ chat: A, text: `${MENTION} pomoc` });
          await h.answer("run-1", reply(CLEAN));
          expect(h.toGroups()).toHaveLength(again ? 0 : 1);
        }
      }
    }
  });

  it("remembers the one edit time a read gave before the store failed, so that edit, read again once the store tells, never undoes a later START, while a STOP wacli stored after that read pauses again, since the store cannot show it was judged; the operator hears why once", async () => {
    const paused = "Odesílání do všech skupin je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START.";
    const resumed = "Odesílání do všech skupin je obnovené.";
    const unknown = "Čas úpravy zprávy nejde v úložišti wacli přečíst (database is locked). Dokud nepůjde, každá změna upravené zprávy se bere jako nová úprava: STOP v ní pozastaví odesílání i po zprávě START. Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.";
    for (const late of [false, true]) {
      const h = harness();
      await h.intake.catchUp();
      const typo = await h.command("Stoop");
      await h.intake.catchUp();
      h.clock.now += 60_000;
      h.wacli.edited(typo, "Díky, už je to vyřešené.");
      await h.intake.catchUp();
      // The store gives the time at the first read only. The STOP is stored before, and the catch-up reads its own entry,
      // or wacli stores it right after that read, while the catch-up reads a rewrite of the edit judged above.
      editTimeReads(h, typo, [late ? "stop" : "known", "unknown", "unknown"]);
      if (late) h.wacli.rewritten(typo, { senderName: "Provoz" });
      else {
        h.clock.now += 60_000;
        h.wacli.edited(typo, "STOP");
      }
      expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 0, errors: 0, more: false });
      expect(h.intake.status()).toMatchObject({ stopped: { all: true, groups: [] }, lastError: "database is locked" });
      h.clock.now += 60_000;
      await h.command("START");
      // The store tells the time again. The next catch-up reads the START's entry, and the late STOP's own entry or a rewrite.
      if (!late) h.wacli.rewritten(typo, { senderName: "Podpora" });
      expect(await h.intake.catchUp()).toEqual({ changes: 2, messages: 0, errors: 0, more: false });
      expect(h.intake.status().stopped).toEqual({ all: late, groups: [] });
      expect(h.toOperator()).toEqual([unknown, paused, resumed, ...(late ? [paused] : [])]);
    }
  });

  it("remembers wacli's edit time judged last, no text, for the newest 1,000 edited messages, and takes any other time, or none, for a new edit", () => {
    const edits: OperatorEdit[] = [];
    const at = Date.parse("2026-11-02T08:05:00Z");
    expect([newEdit(edits, "3EB0A", at), newEdit(edits, "3EB0A", at), newEdit(edits, "3EB0A", at + 1_000), newEdit(edits, "3EB0A", at)])
      .toEqual([true, false, true, true]);
    expect(edits).toEqual([{ id: "3EB0A", at }]);
    // A store that cannot tell: a new edit, and the time remembered stays.
    expect([newEdit(edits, "3EB0A", null), newEdit(edits, "3EB0A", at)]).toEqual([true, false]);
    // Reads that tie the text to no time: a new edit even at the time remembered, and the newest time they gave is
    // remembered instead.
    expect([newEdit(edits, "3EB0A", null, at), newEdit(edits, "3EB0A", null, at + 2_000), newEdit(edits, "3EB0A", at + 2_000)])
      .toEqual([true, true, false]);
    expect(edits).toEqual([{ id: "3EB0A", at: at + 2_000 }]);
    expect(EDITS_KEPT).toBe(1_000);
    for (let index = 0; index < EDITS_KEPT; index++) newEdit(edits, `3EB0B${index}`, at);
    expect(edits).toHaveLength(1_000);
    // A rewrite keeps a message from being forgotten next; one forgotten counts as a new edit.
    expect(newEdit(edits, "3EB0B0", at)).toBe(false);
    expect(newEdit(edits, "3EB0A", at)).toBe(true);
    expect([newEdit(edits, "3EB0B0", at), newEdit(edits, "3EB0B1", at)]).toEqual([false, true]);
  });

  it("lists a STOP the webhook dropped, or a journal that cannot be read, among a draft's reasons, since a finished run's reply waits for a catch-up first", async () => {
    const h = harness();
    await h.intake.catchUp();
    await h.incoming({ chat: D, text: `${MENTION} dotaz` });
    await h.command("STOP", { dropped: true });
    await h.answer("run-1", reply(CLEAN));
    expect(h.toOperator()).toEqual([
      expect.stringContaining("Odesílání do všech skupin je pozastavené"), expect.stringContaining("skupina je v režimu návrhů; odesílání je pozastavené (STOP)"),
    ]);
    const failing = harness();
    await failing.intake.catchUp();
    await failing.incoming({ chat: D, text: `${MENTION} dotaz` });
    failing.wacli.journalFailure = "wacli messages changes: database disk image is malformed";
    await failing.answer("run-1", reply(CLEAN));
    expect(failing.toOperator().at(-1)).toContain("skupina je v režimu návrhů; dohledávání ztracených zpráv nefunguje");
  });
});

// ── the digest ────────────────────────────────────────────────────────────

describe("the digest", () => {
  it("goes to the operator at 17:00 Prague time on workdays, once, from the ledger", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} jak se připojím?` });
    await h.answer("run-1", reply(CLEAN, { digest_line: "Návod k připojení Integrace." }));
    await h.incoming({ chat: B, text: "Tajný text, který do přehledu nepatří." });
    h.clock.now = Date.parse("2026-11-02T15:59:00Z");
    await h.intake.tick();
    expect(h.toOperator()).toEqual([]);
    h.clock.now = Date.parse("2026-11-02T16:00:00Z");
    await h.intake.tick();
    const digest = h.toOperator()[0];
    expect(digest).toContain("Group A: odpovědi 1 · návrhy 0 · eskalace 0, otevřené 0 · bez reakce přes 2 h 0");
    expect(digest).toContain("– Návod k připojení Integrace.");
    expect(digest).toMatch(/Group B: odpovědi 0 · návrhy 0 · eskalace 0, otevřené 0 · bez reakce přes 2 h 1 \(09:0\d\)/);
    expect(digest).toContain("Stav: wacli se spouští");
    expect(digest).not.toContain("Tajný text");
    await h.intake.tick();
    h.clock.now += 30 * 60_000;
    await h.intake.tick();
    expect(h.toOperator()).toHaveLength(1);
    expect(h.intake.digestText()).not.toContain("Návod k připojení");

    const saturday = harness({ now: Date.parse("2026-11-07T16:30:00Z") });
    await saturday.intake.tick();
    expect(saturday.toOperator()).toEqual([]);
  });
});

// ── the ledger, catch-up and restart ──────────────────────────────────────

describe("the ledger", () => {
  it("never holds message text, in the state file or the log", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} Heslo k serveru je hunter2-synthetic` });
    await h.answer("run-1", { ...reply("Heslo prosím změňte, předávám to dál."), action: "reply_and_escalate", escalation: { urgency: "high", summary: "Klient poslal heslo.", next_step: "" } });
    const state = readFileSync(join(h.dir, "whatsapp-intake.json"), "utf8");
    expect(state).not.toContain("hunter2");
    expect(state).not.toContain("Heslo");
    expect(h.logs.join("\n")).not.toContain("hunter2");
    expect(h.logs.join("\n")).not.toContain("Heslo");
  });

  it("keeps 30 days", async () => {
    const h = harness();
    await h.incoming({ chat: C, text: "stará zpráva" });
    h.clock.now += 31 * 24 * 60 * 60_000;
    await h.incoming({ chat: C, text: "nová zpráva" });
    expect(h.ledger()).toHaveLength(1);
  });
});

describe("catch-up", () => {
  const nothing = { changes: 0, messages: 0, errors: 0, more: false };

  it("finds what the webhook dropped, once, and ignores history from before the intake started", async () => {
    const h = harness();
    await h.intake.catchUp();
    h.stored({ chat: A, id: "3EB0OLDHISTORY", text: `${MENTION} staré`, at: MONDAY_9 - 60_000 });
    h.clock.now += 60_000;
    const dropped = h.stored({ chat: A, text: `${MENTION} ztracená` });
    expect(await h.intake.catchUp()).toEqual({ changes: 2, messages: 1, errors: 0, more: false });
    expect(h.events()).toHaveLength(1);
    expect(h.events()[0].trigger_message_ids).toEqual([dropped.id]);
    expect(await h.intake.catchUp()).toEqual(nothing);
    expect(h.queued).toHaveLength(1);
  });

  it("finds a dropped message and a dropped STOP after later ones arrived live", async () => {
    const h = harness();
    await h.intake.catchUp();
    h.clock.now += 60_000;
    await h.command("STOP", { dropped: true });
    const lost = h.stored({ chat: A, text: `${MENTION} ztracená otázka` });
    h.clock.now += 60_000;
    await h.command("Díky.");
    await h.incoming({ chat: A, text: "Ještě jedna věc." });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(await h.intake.catchUp()).toEqual({ changes: 4, messages: 2, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.events()[0].trigger_message_ids).toEqual([lost.id]);
    await h.answer("run-1", reply(CLEAN));
    expect(h.toGroups()).toEqual([]);
    expect(h.toOperator()).toEqual([
      expect.stringContaining("Odesílání do všech skupin je pozastavené"), expect.stringContaining("odesílání je pozastavené (STOP)"),
    ]);
    expect(await h.intake.catchUp()).toEqual(nothing);
    expect(h.queued).toHaveLength(1);
  });

  it("finds a message stored late with an earlier time, once", async () => {
    const h = harness();
    h.clock.now += 20 * 60_000;
    await h.incoming({ chat: A, text: "Dobrý den." });
    await h.intake.catchUp();
    const late = h.stored({ chat: A, text: `${MENTION} uložená pozdě`, at: h.clock.now - 2 * 60_000 });
    h.clock.now += 60_000;
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 1, errors: 0, more: false });
    expect(h.events()[0].trigger_message_ids).toEqual([late.id]);
    expect(await h.intake.catchUp()).toEqual(nothing);
  });

  it("finds a STOP the webhook dropped after 260 messages of the same second", async () => {
    const h = harness();
    await h.intake.catchUp();
    for (let index = 0; index < 260; index++) await h.command(`poznámka ${index}`);
    await h.command("STOP", { dropped: true });
    const summary = await h.intake.catchUp();
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(summary).toEqual({ changes: 261, messages: 1, errors: 0, more: false });
  });

  it("finds a dropped STOP of the second of messages whose ids it no longer keeps, across several catch-ups", async () => {
    const h = harness();
    await h.intake.catchUp();
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 300; index++) await h.command(`poznámka ${round}.${index}`);
      expect(await h.intake.catchUp()).toEqual({ changes: 300, messages: 0, errors: 0, more: false });
    }
    expect(h.saved().chats[OPERATOR]!.seen).toHaveLength(500);
    await h.command("STOP", { dropped: true });
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 1, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
  });

  it("keeps every id of the operator's chat until a complete catch-up, so a STOP dropped after more than 5,000 messages of its second is found", async () => {
    const h = harness();
    await h.intake.catchUp();
    for (let index = 0; index < 5_001; index++) await h.command(`poznámka ${index}`);
    await h.command("STOP", { dropped: true });
    expect(h.saved().chats[OPERATOR]!.seen).toHaveLength(5_001);
    const summaries: CatchUpSummary[] = [];
    for (let read = 0; read < 6; read++) summaries.push(await h.intake.catchUp());
    expect(summaries.map((summary) => [summary.messages, summary.more])).toEqual([[0, true], [0, true], [0, true], [0, true], [0, true], [1, false]]);
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.saved().chats[OPERATOR]!.seen).toHaveLength(500);
  }, 60_000);

  it("reads a command again once it forgot the id, and takes it for what it is: the one in force says nothing, an older one changes nothing", async () => {
    const h = harness();
    await h.intake.catchUp();
    const stop = await h.command("STOP");
    h.clock.now += 60_000;
    const start = await h.command("START");
    for (let index = 0; index < 600; index++) await h.command(`poznámka ${index}`);
    await h.intake.catchUp();
    expect(h.saved().chats[OPERATOR]!.seen.map((entry) => entry.id)).not.toContain(start.id);
    const told = h.toOperator().length;
    h.wacli.changed(start);
    h.wacli.changed(stop);
    expect(await h.intake.catchUp()).toEqual({ changes: 2, messages: 2, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
    expect(h.toOperator().slice(told)).toEqual(["Příkaz STOP z 09:00 nic nemění, platí START z 09:01."]);
  });

  it("holds a finished run's reply, neither sent nor drafted, until a catch-up reads the journal to its end, so a STOP past the page limit applies first", async () => {
    for (const stop of [true, false]) {
      const h = harness();
      await h.intake.catchUp();
      await h.incoming({ chat: A, text: `${MENTION} pomoc` });
      for (let index = 0; index < 1_200; index++) h.stored({ chat: C, text: `zpráva ${index}` });
      if (stop) await h.command("STOP", { dropped: true });
      h.play("run-1", reply(CLEAN));
      await h.intake.tick();
      expect(h.wacli.sent).toEqual([]);
      expect(h.intake.status().groups.find((group) => group.key === "a")!.runId).toBe("run-1");
      await h.intake.tick();
      expect(h.intake.status().stopped).toEqual({ all: stop, groups: [] });
      expect(h.toGroups()).toEqual(stop ? [] : [{ to: A, text: CLEAN, replyTo: h.events()[0].trigger_message_ids[0] }]);
      expect(h.ledger()[0]).toMatchObject(stop ? { action: "draft", group: "a", runId: "run-1", reason: "paused" } : { action: "sent", group: "a", runId: "run-1" });
    }
  });

  it("handles a backlog larger than the 500 ids it keeps once each, and takes a later change to one for no new message", async () => {
    const h = harness();
    await h.intake.catchUp();
    const dropped = Array.from({ length: 600 }, (_, index) => h.stored({ chat: C, text: `zpráva ${index}`, at: MONDAY_9 + index * 1_000 }).id);
    h.clock.now += 20 * 60_000;
    const summaries = [await h.intake.catchUp()];
    const lost = h.stored({ chat: C, text: "ztracená před 600 dalšími" }).id;
    const live: string[] = [];
    for (let index = 0; index < 600; index++) live.push((await h.incoming({ chat: C, text: `živě ${index}` })).id);
    summaries.push(await h.intake.catchUp());
    for (const id of [dropped[0], live[0]]) h.wacli.changed(h.wacli.store.find((message) => message.id === id)!);
    summaries.push(await h.intake.catchUp());
    expect(h.observed()).toEqual([...dropped, ...live, lost]);
    expect(summaries).toEqual([
      { changes: 600, messages: 600, errors: 0, more: false }, { changes: 601, messages: 1, errors: 0, more: false }, { changes: 2, messages: 0, errors: 0, more: false },
    ]);
    expect(h.saved().chats[C]!.seen).toHaveLength(500);
  });

  it("goes on at the next tick while the journal holds more than one catch-up reads", async () => {
    const h = harness();
    await h.intake.catchUp();
    const dropped = Array.from({ length: 1_001 }, (_, index) => h.stored({ chat: C, text: `zpráva ${index}`, at: MONDAY_9 + index }).id);
    h.clock.now += 5 * 60_000;
    await h.intake.tick();
    expect(h.observed()).toHaveLength(1_000);
    await h.intake.tick();
    expect(h.observed()).toEqual(dropped);
  });

  it("applies a dropped STOP before it sends the reply of a run that finished meanwhile", async () => {
    const h = harness();
    await h.intake.catchUp();
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.command("STOP", { dropped: true });
    h.clock.now += 5 * 60_000;
    await h.answer("run-1", reply(CLEAN));
    expect(h.toGroups()).toEqual([]);
    expect(h.toOperator()).toEqual([
      expect.stringContaining("Odesílání do všech skupin je pozastavené"), expect.stringContaining("odesílání je pozastavené (STOP)"),
    ]);
  });

  it("follows a message wacli files under another chat id, such as a STOP it first stored under the operator's LID", async () => {
    const h = harness();
    await h.intake.catchUp();
    const stop = h.stored({ chat: "123456789012345@lid", sender: OPERATOR, text: "STOP" });
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 0, errors: 0, more: false });
    h.wacli.moved(stop, OPERATOR);
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 1, errors: 0, more: false });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
  });

  it("reads back what it has not handled and the operator's messages, which an edit may change, but never a group message it handled or its own sends", async () => {
    const h = harness();
    await h.intake.catchUp();
    // wacli stores what it sends and records it in the journal.
    const send = h.wacli.sendText.bind(h.wacli);
    h.wacli.sendText = async (to, text, replyTo) => {
      const id = await send(to, text, replyTo);
      h.stored({ chat: to, id, sender: SELF, senderName: "", fromMe: true, text });
      return id;
    };
    const shown: string[] = [];
    const show = h.wacli.message.bind(h.wacli);
    h.wacli.message = async (chat, id) => { shown.push(id); return show(chat, id); };
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN));
    const stop = await h.command("STOP");
    await h.incoming({ chat: OPERATOR, sender: SELF, fromMe: true, text: "Napsáno z telefonu účtu." });
    const dropped = h.stored({ chat: B, text: "Ztracená zpráva." });
    expect(await h.intake.catchUp()).toMatchObject({ messages: 1, errors: 0 });
    expect(h.wacli.sent).toHaveLength(2);
    expect(shown).toEqual([stop.id, dropped.id]);
  });

  it("never answers a group message again when the client edits it, delivered or dropped", async () => {
    const h = harness();
    await h.intake.catchUp();
    const asked = await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN));
    h.wacli.edited(asked, `${MENTION} pomoc, prosím`);
    await h.intake.catchUp();
    h.wacli.edited(asked, `${MENTION} pomoc, prosím!`);
    await h.intake.receive(livePayload({ ...asked, at: h.clock.now }));
    await h.intake.tick();
    expect(h.queued).toHaveLength(1);
    expect(h.toGroups()).toHaveLength(1);
  });

  it("keeps its place in the journal across a failure and a restart in the middle of a backlog", async () => {
    const h = harness();
    await h.intake.catchUp();
    const dropped = Array.from({ length: 1_200 }, (_, index) => h.stored({ chat: C, text: `zpráva ${index}`, at: MONDAY_9 + index }).id);
    h.wacli.failRead.add(dropped[1_100]);
    const summaries = [await h.intake.catchUp(), await h.intake.catchUp()];
    const problem = h.intake.status().catchUpProblem;
    h.wacli.failRead.clear();
    const again = harness({ dir: h.dir, wacli: h.wacli, now: h.clock.now });
    summaries.push(await again.intake.catchUp());
    expect(again.observed()).toEqual(dropped);
    expect(summaries).toEqual([
      { changes: 1_000, messages: 1_000, errors: 0, more: true }, { changes: 101, messages: 100, errors: 1, more: false }, { changes: 200, messages: 100, errors: 0, more: false },
    ]);
    expect(problem).toContain("timed out");
  });

  it("fails closed while wacli's journal cannot be read: replies are drafts, and the operator hears it once", async () => {
    const h = harness();
    await h.intake.catchUp();
    h.wacli.journalFailure = "wacli messages changes: unknown command \"changes\" for \"wacli messages\"";
    expect(await h.intake.catchUp()).toMatchObject({ errors: 1 });
    expect(await h.intake.catchUp()).toMatchObject({ errors: 1 });
    expect(h.toOperator()).toEqual([expect.stringContaining("Dohledávání zpráv, které webhook ztratil, nefunguje")]);
    expect(h.intake.status().catchUpProblem).toContain("unknown command");
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN));
    expect(h.toGroups()).toEqual([]);
    expect(h.toOperator().at(-1)).toContain("dohledávání ztracených zpráv nefunguje");
    delete h.wacli.journalFailure;
    expect(await h.intake.catchUp()).toMatchObject({ errors: 0 });
    expect(h.toOperator().at(-1)).toBe("Dohledávání zpráv znovu funguje.");
    expect(h.intake.status().catchUpProblem).toBeUndefined();
    await h.incoming({ chat: A, text: `${MENTION} a teď?` });
    await h.answer("run-2", reply(CLEAN));
    expect(h.toGroups()).toHaveLength(1);
  });

  it("pauses sending when wacli's journal no longer reaches its checkpoint, until the operator's START", async () => {
    const h = harness();
    await h.intake.catchUp();
    h.stored({ chat: A, text: "Zpráva, kterou už nikdo nedohledá." });
    h.wacli.expiredBefore = h.wacli.journal.length;
    h.clock.now += 60_000;
    expect(await h.intake.catchUp()).toMatchObject({ errors: 1 });
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.toOperator()).toEqual([expect.stringContaining("Dohledávání zpráv nemůže navázat")]);
    const asked = h.stored({ chat: A, text: `${MENTION} po výpadku` });
    expect(await h.intake.catchUp()).toEqual({ changes: 1, messages: 1, errors: 0, more: false });
    expect(h.events()[0].trigger_message_ids).toEqual([asked.id]);
    h.clock.now += 60_000;
    await h.command("START");
    expect(h.intake.status().stopped).toEqual({ all: false, groups: [] });
  });

  it("starts the follower only from a checkpoint: until one is taken, with backoff, it collects and sends nothing, and the operator hears it once", async () => {
    const h = harness();
    h.wacli.checkpointFailure = "wacli messages changes: changes requires a writable store migration before read-only use";
    await h.intake.start();
    try {
      expect(h.wacli.followers.started).toBe(0);
      expect(h.intake.status()).toMatchObject({ state: "checkpoint_failed", catchUpProblem: expect.stringContaining("migration") });
      expect(h.toOperator()).toEqual([expect.stringContaining("Příjem zpráv ze skupin nemůže začít")]);
      for (const wait of [999, 1, 4_999, 1]) {
        h.clock.now += wait;
        await h.intake.tick();
      }
      expect(h.wacli.checkpoints).toBe(3);
      expect(h.wacli.followers.started).toBe(0);
      expect(h.toOperator()).toHaveLength(1);
      delete h.wacli.checkpointFailure;
      h.clock.now += 30_000;
      await h.intake.tick();
      expect(h.wacli.followers.started).toBe(1);
      expect(h.intake.status().state).not.toBe("checkpoint_failed");
      expect(h.toOperator().at(-1)).toBe("Dohledávání zpráv znovu funguje.");
      // What WhatsApp kept back meanwhile reaches the follower now: a mention, and a STOP whose webhook is dropped.
      await h.incoming({ chat: A, text: `${MENTION} pomoc` });
      await h.command("STOP", { dropped: true });
      await h.answer("run-1", reply(CLEAN));
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
      expect(h.toGroups()).toEqual([]);
    } finally {
      await h.intake.stop();
    }
  });

  it("stops the follower when wacli's journal no longer reaches its checkpoint, until a new checkpoint is taken", async () => {
    const h = harness();
    await h.intake.start();
    try {
      expect(h.wacli.followers).toEqual({ started: 1, stopped: 0 });
      h.stored({ chat: A, text: "Zpráva, kterou už nikdo nedohledá." });
      h.wacli.expiredBefore = h.wacli.journal.length;
      h.wacli.checkpointFailure = "wacli messages changes: database is locked";
      expect(await h.intake.catchUp()).toMatchObject({ errors: 1 });
      expect(h.wacli.followers).toEqual({ started: 1, stopped: 1 });
      expect(h.intake.status()).toMatchObject({ state: "checkpoint_failed", stopped: { all: true, groups: [] } });
      h.wacli.events!({ kind: "exit", code: 0 });
      expect(h.intake.status().follower.restarts).toBe(0);
      delete h.wacli.checkpointFailure;
      h.clock.now += 1_000;
      await h.intake.tick();
      expect(h.wacli.followers).toEqual({ started: 2, stopped: 1 });
      expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    } finally {
      await h.intake.stop();
    }
  });

  it("reads the group map again when it changes", async () => {
    const h = harness();
    writeFileSync(h.groupsFile, JSON.stringify({ ...MAP, groups: { [A]: { ...MAP.groups[A], mode: "observe" } } }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(h.groupsFile, later, later);
    await h.intake.catchUp();
    expect(h.intake.status().groups.map((group) => [group.key, group.mode])).toEqual([["a", "observe"]]);
  });
});

describe("the operator's STOP", () => {
  it("is never lost and applies before any later group send, whatever the webhook dropped, the intake forgot or the journal pages", async () => {
    const h = harness();
    h.wacli.checkpointFailure = "wacli messages changes: database is locked";
    await h.intake.start();
    try {
      expect(h.wacli.followers.started).toBe(0);
      delete h.wacli.checkpointFailure;
      h.clock.now += 1_000;
      await h.intake.tick();
      expect(h.wacli.followers.started).toBe(1);
    } finally {
      await h.intake.stop();
    }
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    for (let round = 0; round < 2; round++) {
      for (let index = 0; index < 300; index++) await h.command(`poznámka ${round}.${index}`);
      await h.intake.catchUp();
    }
    for (let index = 0; index < 1_200; index++) h.stored({ chat: C, text: `zpráva ${index}` });
    await h.command("STOP", { dropped: true });
    h.play("run-1", reply(CLEAN));
    await h.intake.tick();
    expect(h.toGroups()).toEqual([]);
    await h.intake.tick();
    expect(h.intake.status().stopped).toEqual({ all: true, groups: [] });
    expect(h.toGroups()).toEqual([]);
    expect(h.ledger()[0]).toMatchObject({ action: "draft", group: "a", runId: "run-1", reason: "paused" });
  });
});

describe("a restart", () => {
  it("never finishes a run again once its reply went out", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    await h.answer("run-1", reply(CLEAN));
    expect(h.saved().runs).toEqual([]);
    const again = harness({ dir: h.dir, wacli: h.wacli, now: h.clock.now });
    again.runs.set("run-1", { webhookId: h.queued[0].webhookId, status: "completed", threadId: "thread-1", output: JSON.stringify(reply(CLEAN)) });
    await again.intake.tick();
    expect(h.wacli.sent).toHaveLength(1);
  });

  it("finishes a run it handed over before the restart, as a draft, since its tool log is gone", async () => {
    const h = harness();
    await h.incoming({ chat: A, text: `${MENTION} pomoc` });
    const again = harness({ dir: h.dir, wacli: h.wacli, now: h.clock.now });
    again.runs.set("run-1", { webhookId: h.queued[0].webhookId, status: "completed", threadId: "thread-1", output: JSON.stringify(reply(CLEAN)) });
    await again.intake.tick();
    expect(again.toGroups()).toEqual([]);
    expect(again.toOperator()[0]).toContain("engine nehlásí nástroje");
  });
});
