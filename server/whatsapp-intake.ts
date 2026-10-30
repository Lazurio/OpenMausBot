// Lazurio MausBot WhatsApp intake: model-free handling of the WhatsApp groups a
// support bot answers in. Plain code receives the account's messages from wacli,
// keeps only the groups in the operator's map, and wakes the bot through one
// managed webhook per group (the same queue, receipts and UNTRUSTED wrapping as
// an HTTP delivery) only for a mention of the account, a reply to it, or a batch
// of unasked messages after the group went quiet. The bot answers with JSON; the
// intake alone decides where its words go. Off unless OMB_WHATSAPP_INTAKE=1.
//
// Security invariants: a run gets one group's messages and that group's note,
// never another group's; the intake sends only to the group whose messages the
// run judged, quoting one of them, or to the operator's direct chat; the state
// file and the server log hold ids, times and actions, never message text.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { WebhookManager, WebhookReceiveResult, WebhookTrigger } from "./webhooks.ts";
import { applyCommand, commandReply, isPaused, newEdit, parseCommand, stoppedSummary } from "./whatsapp-intake-commands.ts";
import {
  isGroupChat, isUserChat, loadGroupMap, readNote, userOf,
  type GroupMap, type WhatsappGroup, type WhatsappIntakeConfig,
} from "./whatsapp-intake-config.ts";
import { clock, composeDigest, pragueParts } from "./whatsapp-intake-digest.ts";
import {
  LIMITS, parseRunOutput, reasonText, sendGuards, wantsEscalation, wantsReply,
  type RunCapture, type RunOutput, type SentCounts,
} from "./whatsapp-intake-guards.ts";
import { runEvent, triggerPrompt } from "./whatsapp-intake-prompt.ts";
import {
  stateSchema, type ActiveRun, type ChatState, type Command, type IntakeState, type LedgerEntry, type TriggerKind,
} from "./whatsapp-intake-state.ts";
import {
  FOLLOWER_WORDS, intakeHealth, type CatchUpSummary, type FollowerState, type WhatsappIntakeStatus,
} from "./whatsapp-intake-status.ts";
import {
  FOLLOW_SEND_SPACING, liveMessage, listenForWacli, lostCheckpoint, readEdit,
  type EditRead, type FollowerEvent, type Wacli, type WacliFollower, type WaChange, type WaMessage,
} from "./whatsapp-intake-wacli.ts";

export type { CatchUpSummary, WhatsappIntakeStatus } from "./whatsapp-intake-status.ts";

export const INTAKE_EVENT_TYPE = "whatsapp.messages";
export const TRIGGER_NAME_PREFIX = "WhatsApp · ";
const TRIGGER_MAX_PENDING_RUNS = 2;
const USER_AGENT = "Lazurio MausBot WhatsApp intake";
const RUN_MESSAGES = 40;
const BATCH_QUIET_MS = 10 * 60_000;
const BATCH_MAX = 20;
const TEAM_ACTIVE_MS = 15 * 60_000;
const MENTION_MAX_AGE_MS = 60 * 60_000;
const CATCH_UP_EVERY_MS = 5 * 60_000;
const CATCH_UP_LIMIT = 200;
const CATCH_UP_PAGES = 5;
const TICK_MS = 5_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const SPACING_MS = [3_000, 8_000] as const;
const DAY_MS = 24 * 60 * 60_000;
const LEDGER_TTL_MS = 30 * DAY_MS;
const MAX_LEDGER = 20_000;
const SEEN_PER_CHAT = 500;
const SEEN_MAX_PER_CHAT = 5_000;
const OPEN_PER_CHAT = 200;
const DM_REPORT_EVERY_MS = 30 * 60_000;
const DIGEST_HOUR = 17;
const DIGEST_RETRY_MS = 15 * 60_000;
const RECENT = 50;
const MAX_OPERATOR_TEXT = 4_000;
const FOLLOWER_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 300_000];
const FOLLOWER_HEALTHY_MS = 10 * 60_000;

type Webhooks = Pick<WebhookManager, "list" | "create" | "update" | "deliverTrusted">;

export interface WhatsappIntakeOptions {
  config: WhatsappIntakeConfig;
  /** The group map at start; it is read again from `config.groupsFile` when that file changes. */
  map: GroupMap;
  wacli: Wacli;
  /** Durable state, `<data>/whatsapp-intake.json`. */
  file: string;
  webhooks: Webhooks;
  bots: () => ReadonlyArray<{ id: string; name: string; cwd?: string }>;
  runState: (runId: string) => { status: string; threadId?: string; output?: string } | null;
  now?: () => number;
  log?: (line: string) => void;
  /** Wraps each delivery and state write (the server's maintenance claim). */
  guard?: <T>(work: () => T) => T;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readNote?: (path: string) => string;
}

const ASKED: ReadonlySet<TriggerKind> = new Set(["mention", "reply"]);
const URGENCY: Record<string, string> = { low: "nízká", normal: "běžná", high: "vysoká" };

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export class WhatsappIntake {
  private readonly options: WhatsappIntakeOptions;
  private readonly config: WhatsappIntakeConfig;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly guard: <T>(work: () => T) => T;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readNote: (path: string) => string;
  private readonly secret = randomBytes(32).toString("hex");
  private map: GroupMap;
  private mapChangedAt = 0;
  private state: IntakeState;
  private self = new Set<string>();
  private account?: string;
  private bot?: { id: string; name: string };
  private targetProblem?: string;
  private receiver: { url: string; close(): Promise<void> } | null = null;
  private follower: WacliFollower | null = null;
  private followerInfo: WhatsappIntakeStatus["follower"] = { state: "starting", restarts: 0, webhookFailures: 0 };
  private followerFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private work: Promise<unknown> = Promise.resolve();
  private sending: Promise<unknown> = Promise.resolve();
  /** A send is asking its `ready` (`send`). */
  private asking = false;
  private lastSendAt = 0;
  private readonly batches = new Map<string, { ids: string[]; lastAt: number }>();
  private readonly pending = new Map<string, { kind: TriggerKind; ids: string[] }>();
  private readonly captures = new Map<string, RunCapture>();
  private readonly threadRuns = new Map<string, string>();
  private readonly unmapped = new Map<string, number>();
  private readonly dmReported = new Map<string, number>();
  private lastCatchUpAt?: number;
  private catchUpMore = false;
  private catchUpProblem?: string;
  private editTimeProblem?: string;
  private checkpointFailures = 0;
  private checkpointRetryAt = 0;
  private digestTriedAt = 0;
  private lastError?: string;

  constructor(options: WhatsappIntakeOptions) {
    this.options = options;
    this.config = options.config;
    this.map = options.map;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.guard = options.guard ?? ((work) => work());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.readNote = options.readNote ?? readNote;
    this.mapChangedAt = this.mapMtime();
    this.state = this.load();
    for (const id of this.config.selfIds) this.self.add(userOf(id));
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.log(`[whatsapp-intake] on: ${this.map.groups.length} groups for bot "${this.config.bot}"`);
    try {
      this.receiver = await listenForWacli(this.secret, (payload) => { void this.receive(payload); });
    } catch (error) {
      this.lastError = `the webhook receiver did not start: ${errorText(error)}`;
      this.log(`[whatsapp-intake] ${this.lastError}`);
      return;
    }
    if (this.stopped) return void this.receiver.close();
    await this.refreshAccount();
    await this.enqueue(() => this.collect());
    this.tickTimer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.tickTimer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.tickTimer = this.restartTimer = null;
    await this.stopFollower();
    await this.receiver?.close();
    this.receiver = null;
  }

  /** Everything that is due: a checkpoint while there is none (and then nothing else), the catch-up read, so a STOP it
   * finds applies first, quiet batches, finished runs and the digest. */
  tick(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.journal && (this.now() < this.checkpointRetryAt || !await this.collect())) return;
      if (this.catchUpMore || this.now() - (this.lastCatchUpAt ?? 0) >= CATCH_UP_EVERY_MS) await this.runCatchUp();
      for (const [chat, batch] of this.batches) {
        if (this.now() - batch.lastAt < BATCH_QUIET_MS) continue;
        const group = this.group(chat);
        if (group) await this.flushBatch(group);
        else this.batches.delete(chat);
      }
      await this.checkRuns();
      await this.maybeDigest();
    }).then(() => undefined);
  }

  /** Reads wacli's change journal from where the previous catch-up stopped, for anything the webhook dropped. */
  async catchUp(): Promise<CatchUpSummary> {
    return (await this.enqueue(() => this.runCatchUp())) ?? { changes: 0, messages: 0, errors: 1, more: false };
  }

  /** A signed payload from the follower's webhook. The operator's chat skips the queue, so a STOP takes effect at once,
   * even while a send waits for its turn; only the confirmation waits. An edit there starts a catch-up instead, which
   * judges it from wacli's journal: every edit is judged there, once, by wacli's edit time, whether its webhook arrived. */
  receive(payload: unknown): Promise<void> {
    const message = liveMessage(payload);
    if (!message) return Promise.resolve();
    if (message.chat === this.config.operator && message.edited) return this.catchUp().then(() => undefined);
    if (message.chat === this.config.operator) return this.fromOperator(message).catch((error: unknown) => { this.failed(error); });
    return this.enqueue(() => this.ingest(message)).then(() => undefined);
  }

  /** Every runtime event of the server: the tool calls and the final text of this intake's runs. */
  observe(event: RuntimeEvent): void {
    if (!this.state.runs.length) return;
    let runId = this.threadRuns.get(event.threadId);
    if (!runId) {
      // Bound only where a turn starts, so a run's tool log is complete or absent (and then its reply is a draft).
      if (event.type !== "session.started" && event.type !== "turn.started") return;
      runId = this.state.runs.find((run) => !this.captures.get(run.runId)?.provider && this.options.runState(run.runId)?.threadId === event.threadId)?.runId;
      if (!runId) return;
      this.threadRuns.set(event.threadId, runId);
    }
    const capture = this.captures.get(runId) ?? { tools: [] };
    this.captures.set(runId, capture);
    if (!capture.provider) capture.provider = event.provider;
    else if (capture.provider !== event.provider) capture.provider = "mixed";
    if (event.type === "item.started" && event.itemType === "tool") {
      capture.tools.push({ name: event.title ?? "unknown", ...(event.summary ? { summary: event.summary } : {}), ...(event.input ? { input: event.input } : {}) });
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      capture.text = event.text;
    } else if (event.type === "turn.completed") {
      queueMicrotask(() => { void this.enqueue(() => this.checkRuns()); });
    }
  }

  status(): WhatsappIntakeStatus {
    return {
      enabled: true,
      state: intakeHealth({
        receiver: Boolean(this.receiver), lastError: this.lastError, journal: Boolean(this.state.journal), catchUpProblem: this.catchUpProblem,
        follower: this.followerInfo.state, targetProblem: this.targetProblem,
      }),
      ...(this.account ? { account: this.account } : {}),
      ...(this.bot ? { bot: { ...this.bot } } : {}),
      follower: { ...this.followerInfo },
      operator: this.config.operator,
      bundle: this.config.bundle,
      groups: this.map.groups.map((group) => {
        const chat = this.state.chats[group.chat];
        const run = this.state.runs.find((candidate) => candidate.chat === group.chat);
        return {
          key: group.key, name: group.name, chat: group.chat, mode: group.mode, paused: this.paused(group),
          ...(this.state.triggers[group.chat] ? { webhookId: this.state.triggers[group.chat] } : {}),
          ...(run ? { runId: run.runId } : {}),
          batch: this.batches.get(group.chat)?.ids.length ?? 0,
          waiting: chat?.open.length ?? 0,
          ...(chat?.lastSeenAt ? { lastMessageAt: chat.lastSeenAt } : {}),
          ...(chat?.lastTeamAt ? { lastTeamAt: chat.lastTeamAt } : {}),
        };
      }),
      stopped: stoppedSummary(this.state.commands, this.map.groups),
      limits: { ...LIMITS, spacing: FOLLOW_SEND_SPACING },
      activatedAt: this.state.activatedAt,
      ...(this.lastCatchUpAt ? { lastCatchUpAt: this.lastCatchUpAt } : {}),
      ...(this.catchUpProblem !== undefined ? { catchUpProblem: this.catchUpProblem } : {}),
      ...(this.state.digest.lastDay ? { lastDigestDay: this.state.digest.lastDay } : {}),
      unmapped: [...this.unmapped].map(([chat, lastAt]) => ({ chat, lastAt })),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      recent: this.state.ledger.slice(-RECENT).reverse(),
    };
  }

  // ── the follower ───────────────────────────────────────────────────────

  /** Only from a checkpoint in wacli's journal, so the catch-up can find whatever the follower stores. A follower that was
   * stopped is no longer heard. */
  private startFollower(): void {
    if (this.stopped || !this.receiver || this.follower || !this.state.journal) return;
    const started = this.now();
    const follower: WacliFollower = this.options.wacli.follow({ url: this.receiver.url, secret: this.secret }, (event) => {
      if (this.follower === follower) this.onFollower(event, started);
    });
    this.follower = follower;
  }

  private async stopFollower(): Promise<void> {
    const follower = this.follower;
    this.follower = null;
    await follower?.stop();
  }

  private onFollower(event: FollowerEvent, startedAt: number): void {
    this.followerInfo.lastEventAt = this.now();
    if (event.kind === "connected") {
      this.setFollower("connected");
      void this.refreshAccount();
    } else if (event.kind === "reconnecting") {
      this.setFollower("reconnecting");
    } else if (event.kind === "logged_out") {
      this.setFollower("logged_out");
    } else if (event.kind === "warning") {
      if (event.code.startsWith("sync_webhook")) this.followerInfo.webhookFailures++;
    } else if (event.kind === "error") {
      const message = event.message.toLowerCase();
      if (message.includes("storage limit")) this.setFollower("store_full", event.message);
      else if (message.includes("not authenticated")) this.setFollower("logged_out", event.message);
      else if (message.includes("store locked")) this.setFollower("store_locked", event.message);
      else this.followerInfo.detail = event.message;
    } else {
      this.follower = null;
      if (this.stopped) return;
      this.followerInfo.restarts++;
      if (event.missing) this.setFollower("wacli_missing", "wacli is not installed or not on PATH");
      else if (!["logged_out", "store_full", "store_locked"].includes(this.followerInfo.state)) this.setFollower("down", this.followerInfo.detail ?? `exit ${event.code}`);
      if (this.now() - startedAt > FOLLOWER_HEALTHY_MS) this.followerFailures = 0;
      const delay = FOLLOWER_BACKOFF_MS[Math.min(this.followerFailures++, FOLLOWER_BACKOFF_MS.length - 1)];
      this.restartTimer = setTimeout(() => { this.restartTimer = null; this.startFollower(); }, delay);
      this.restartTimer.unref?.();
    }
  }

  private setFollower(state: FollowerState, detail?: string): void {
    const changed = state !== this.followerInfo.state;
    this.followerInfo.state = state;
    if (changed) this.followerInfo.since = this.now();
    if (detail) this.followerInfo.detail = detail;
    else if (state === "connected") delete this.followerInfo.detail;
    if (changed) this.log(`[whatsapp-intake] wacli follower ${state}${detail ? `: ${detail}` : ""}`);
  }

  private async refreshAccount(): Promise<void> {
    try {
      const account = await this.options.wacli.account();
      if (!account.authenticated || !account.jid) return;
      this.account = account.jid;
      this.self.add(userOf(account.jid));
    } catch (error) {
      this.lastError = errorText(error);
    }
  }

  // ── incoming messages ──────────────────────────────────────────────────

  private async ingest(message: WaMessage): Promise<void> {
    if (message.chat === this.config.operator) return this.fromOperator(message);
    const group = this.group(message.chat);
    if (!group) {
      if (isUserChat(message.chat) && !message.fromMe) await this.reportDirect(message);
      else if (isGroupChat(message.chat)) this.noteUnmapped(message.chat, message.at);
      return;
    }
    if (!this.markSeen(message)) return;
    const chat = this.chat(group.chat);
    const team = message.fromMe || this.isTeam(message.sender);
    if (team) {
      chat.lastTeamAt = Math.max(chat.lastTeamAt ?? 0, message.at);
      chat.open = chat.open.filter((entry) => entry.at > message.at);
      this.batches.delete(group.chat);
    } else if (!message.service) {
      chat.open = [...chat.open, { id: message.id, at: message.at }].slice(-OPEN_PER_CHAT);
    }
    if (message.fromMe || message.service) return this.persist();
    const trigger = this.triggerOf(message);
    if (group.mode === "observe") return this.record({ action: "observed", group: group.key, ids: [message.id], reason: trigger ?? (team ? "team" : "batch") });
    if (trigger) {
      this.batches.delete(group.chat);
      if (this.now() - message.at > MENTION_MAX_AGE_MS) {
        this.record({ action: "missed", group: group.key, ids: [message.id], reason: trigger });
        await this.toOperator(`[${group.name} · ${clock(message.at)}] Zpráva pro bota je starší než hodina, bot na ni neodpoví. Podívejte se do skupiny.`);
        return;
      }
      return this.request(group, { kind: trigger, ids: [message.id] });
    }
    if (team) return this.persist();
    const batch = this.batches.get(group.chat) ?? { ids: [], lastAt: 0 };
    batch.ids.push(message.id);
    batch.lastAt = this.now();
    this.batches.set(group.chat, batch);
    this.persist();
    if (batch.ids.length >= BATCH_MAX) await this.flushBatch(group);
  }

  private markSeen(message: WaMessage): boolean {
    const chat = this.chat(message.chat);
    if (!this.remember(message.chat, message.id, message.at, message.fromMe)) return false;
    if (message.at < this.state.activatedAt) return false;
    chat.lastSeenAt = Math.max(chat.lastSeenAt ?? 0, message.at);
    return true;
  }

  /** False for a message already handled. `seen` is trimmed to the newest 500 only after a complete catch-up, so a message
   * the webhook delivered is still known when the journal shows it, however many arrived since. Past 5,000 a mapped group
   * forgets its oldest, which its forgotten time covers; the operator's chat, which has none, keeps them all until then.
   * `own` is the account's own message, which the catch-up never reads again. */
  private remember(chatId: string, id: string, at: number, own: boolean): boolean {
    const chat = this.chat(chatId);
    if (chat.seen.some((entry) => entry.id === id)) return false;
    chat.seen.push({ id, at, ...(own ? { own } : {}) });
    if (chat.seen.length > SEEN_MAX_PER_CHAT && chatId !== this.config.operator) this.forget(chat, SEEN_MAX_PER_CHAT);
    return true;
  }

  private forget(chat: ChatState, keep: number): void {
    for (const entry of chat.seen.splice(0, Math.max(0, chat.seen.length - keep))) {
      chat.forgottenUpTo = Math.max(chat.forgottenUpTo ?? entry.at, entry.at);
    }
  }

  private triggerOf(message: WaMessage): TriggerKind | null {
    if (message.replyToId && this.state.sent.some((sent) => sent.id === message.replyToId)) return "reply";
    if (message.replyToSender && this.self.has(userOf(message.replyToSender))) return "reply";
    // WhatsApp writes a mention into the text as "@" and the account's number; wacli v0.25.1's webhook carries no mention list.
    for (const match of message.text.matchAll(/@(\d{5,20})/g)) if (this.self.has(match[1])) return "mention";
    return null;
  }

  /** A command takes its place by when the operator sent it, so one the catch-up finds late, or reads again after the
   * intake forgot its id, never undoes a newer one; the command in force, read again, says nothing. A START counts only in
   * a message as the operator sent it, never in an edit, a deleted message or a reaction; a STOP counts in any. */
  private async fromOperator(message: WaMessage): Promise<void> {
    if (!this.markSeen(message) || message.fromMe) return this.persist();
    await this.command(message, message.at);
  }

  /** An edit in the operator's chat, which the catch-up reads from wacli's journal whether the intake still keeps the
   * edited message's id or not, and whatever that message's time. wacli's copy carries only the edited message's own
   * time, so a STOP in it counts from now, when the intake learns of it, and a START older than the edit never overrides
   * it. A change whose edit time in wacli's store is the one judged last is a rewrite wacli made, not a new edit
   * (`newEdit`); while the store cannot tell, every change is a new edit. When the time moved at every read (`readEdit`),
   * the text may be another edit's, so the change counts as a STOP for all groups whatever its text. A text the reads tie
   * to no time remembers the newest time they gave: these edits, read again with it, never undo a later START. */
  private async fromOperatorEdit(message: WaMessage, read: EditRead): Promise<void> {
    this.markSeen(message);
    if (message.fromMe) return this.persist();
    if ("unknown" in read.edited || !read.settled) await this.editTimeUnknown(read);
    else delete this.editTimeProblem;
    const at = read.settled && "at" in read.edited ? read.edited.at : null;
    if (!newEdit(this.chat(message.chat).edits ??= [], message.id, at, read.newest)) return this.persist();
    await this.command(read.settled ? message : { ...message, text: "STOP" }, this.now());
  }

  /** The operator hears once, until the store gives one edit time again, that it cannot tell or that the time moved, and
   * that a STOP read meanwhile may pause once more when the store tells again, as it may not show that STOP was judged. */
  private async editTimeUnknown(read: EditRead): Promise<void> {
    const reported = this.editTimeProblem !== undefined;
    const problem = read.settled && "unknown" in read.edited ? read.edited.unknown : "wacli's store gave another edit time, or none, at every read";
    this.editTimeProblem = this.lastError = problem;
    this.log(`[whatsapp-intake] wacli's store does not tell when the operator's message was edited, so it counts as ${read.settled ? "a new edit" : "a STOP"}: ${problem}`);
    if (reported) return;
    await this.toOperator(`${read.settled
      ? `Čas úpravy zprávy nejde v úložišti wacli přečíst (${problem}). Dokud nepůjde, každá změna upravené zprávy se bere jako nová úprava: STOP v ní pozastaví odesílání i po zprávě START.`
      : "Čas úpravy zprávy byl v úložišti wacli při každém čtení jiný nebo nešel přečíst, takže nejde poznat, ke které úpravě patří její text. Proto se taková změna bere jako STOP pro všechny skupiny."} Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.`);
  }

  private async command(message: WaMessage, at: number): Promise<void> {
    const parsed = parseCommand(message.text);
    if (!parsed || (parsed.verb === "start" && message.service)) return this.persist();
    const group = parsed.key ? this.map.groups.find((candidate) => candidate.key === parsed.key) : undefined;
    if (parsed.key && !group) {
      this.persist();
      await this.toOperator(`Skupinu „${parsed.key}“ neznám. Skupiny: ${this.map.groups.map((candidate) => candidate.key).join(", ") || "žádné"}.`);
      return;
    }
    const current = group ? this.state.commands.groups[group.key] : this.state.commands.all;
    if (current?.id === message.id && current.verb === parsed.verb) return this.persist();
    const command: Command = { verb: parsed.verb, at, id: message.id };
    const outcome = applyCommand(this.state.commands, command, group?.key, this.map.groups);
    this.record({ action: "command", ...(group ? { group: group.key } : {}), reason: outcome.applied ? parsed.verb : `${parsed.verb}:superseded` });
    this.log(`[whatsapp-intake] operator ${parsed.verb.toUpperCase()}${group ? ` ${group.key}` : ""}${outcome.applied ? "" : ", superseded by a later command"}`);
    await this.toOperator(commandReply(command, group, outcome, clock));
  }

  private async reportDirect(message: WaMessage): Promise<void> {
    if (message.at < this.state.activatedAt) return;
    if (this.now() - (this.dmReported.get(message.chat) ?? 0) < DM_REPORT_EVERY_MS) return;
    this.dmReported.set(message.chat, this.now());
    this.record({ action: "dm_reported" });
    await this.toOperator(`Soukromá zpráva pro tento účet od ${message.senderName || "neznámého odesílatele"} (${clock(message.at)}). Bot na soukromé zprávy neodpovídá.\n\n${message.text.slice(0, 300)}`);
  }

  private noteUnmapped(chat: string, at: number): void {
    this.unmapped.set(chat, at);
    if (this.unmapped.size > 20) this.unmapped.delete(this.unmapped.keys().next().value!);
  }

  // ── runs ───────────────────────────────────────────────────────────────

  private async flushBatch(group: WhatsappGroup): Promise<void> {
    const batch = this.batches.get(group.chat);
    if (!batch) return;
    this.batches.delete(group.chat);
    const chat = this.chat(group.chat);
    if (chat.lastTeamAt !== undefined && this.now() - chat.lastTeamAt < TEAM_ACTIVE_MS) {
      return this.record({ action: "skipped", group: group.key, ids: batch.ids, reason: "team_active" });
    }
    await this.request(group, { kind: "batch", ids: batch.ids });
  }

  /** One run per group at a time; what asks meanwhile waits and runs after it with the newer messages. */
  private async request(group: WhatsappGroup, trigger: { kind: TriggerKind; ids: string[] }): Promise<void> {
    if (this.state.runs.some((run) => run.chat === group.chat)) {
      const waiting = this.pending.get(group.chat);
      const kind = waiting && ASKED.has(waiting.kind) ? waiting.kind : trigger.kind;
      this.pending.set(group.chat, { kind, ids: [...new Set([...(waiting?.ids ?? []), ...trigger.ids])] });
      return;
    }
    await this.startRun(group, trigger);
  }

  private async startRun(group: WhatsappGroup, trigger: { kind: TriggerKind; ids: string[] }): Promise<void> {
    const fail = async (reason: string) => {
      this.record({ action: "run_failed", group: group.key, ids: trigger.ids, reason });
      if (ASKED.has(trigger.kind)) await this.toOperator(`[${group.name}] Bot nemohl odpovědět na zprávu, která ho oslovila (${reason}). Podívejte se do skupiny.`);
    };
    const bot = this.target();
    if (!bot) return fail("no_target");
    let messages: WaMessage[];
    try {
      messages = (await this.options.wacli.messages(group.chat, RUN_MESSAGES)).filter((message) => message.chat === group.chat && !message.service);
    } catch (error) {
      this.lastError = errorText(error);
      return fail("wacli");
    }
    const chat = this.chat(group.chat);
    const payload = runEvent(group, trigger, messages, new Set(chat.lastInput ?? []), (sender) => this.isTeam(sender));
    let result: WebhookReceiveResult | null;
    try {
      result = this.guard(() => {
        const hook = this.trigger(group, bot.id);
        if (!hook.enabled) throw Object.assign(new Error(`the "${hook.name}" webhook is paused`), { status: 409 });
        return this.options.webhooks.deliverTrusted(hook.id, {
          payload, contentType: "application/json", eventName: INTAKE_EVENT_TYPE, userAgent: USER_AGENT,
          deliveryId: `wa:${group.key}:${trigger.ids.at(-1)}`,
        });
      });
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      this.lastError = errorText(error);
      return fail(status === 409 ? "webhook_paused" : status === 429 ? "queue_full" : "delivery");
    }
    if (!result?.runId) return fail("delivery");
    if (result.duplicate) return this.record({ action: "duplicate", group: group.key, ids: trigger.ids, runId: result.runId });
    chat.lastInput = messages.map((message) => message.id);
    this.state.runs.push({ runId: result.runId, chat: group.chat, trigger: trigger.kind, ids: trigger.ids, inputIds: messages.map((message) => message.id), startedAt: this.now() });
    this.captures.set(result.runId, { tools: [] });
    this.record({ action: "run", group: group.key, ids: trigger.ids, runId: result.runId, reason: trigger.kind });
    this.log(`[whatsapp-intake] ${group.key}: ${trigger.kind} handed to the bot (run ${result.runId})`);
  }

  /** The group's managed webhook: found by its record, or by name and event type when the record was lost; created on
   * first use; its bot and instructions follow the configuration and the group map. */
  private trigger(group: WhatsappGroup, botId: string): WebhookTrigger {
    const name = `${TRIGGER_NAME_PREFIX}${group.key}`;
    let note = "";
    try {
      note = this.readNote(group.note);
    } catch (error) {
      this.lastError = `${group.key}: the client note cannot be read: ${errorText(error)}`;
    }
    const prompt = triggerPrompt(group, note);
    const hooks = this.options.webhooks.list();
    let hook = hooks.find((candidate) => candidate.id === this.state.triggers[group.chat])
      ?? hooks.find((candidate) => candidate.name === name && candidate.eventTypes?.includes(INTAKE_EVENT_TYPE));
    if (!hook) {
      hook = this.options.webhooks.create({ name, prompt, botId, eventTypes: [INTAKE_EVENT_TYPE], maxPendingRuns: TRIGGER_MAX_PENDING_RUNS }).webhook;
      this.log(`[whatsapp-intake] created the "${name}" webhook for bot ${botId}`);
    } else if (hook.botId !== botId || hook.prompt !== prompt) {
      // A webhook left with an earlier bot moves to the new one, switched on again.
      hook = this.options.webhooks.update(hook.id, { prompt, ...(hook.botId !== botId ? { botId, enabled: true } : {}) }) ?? hook;
    }
    if (this.state.triggers[group.chat] !== hook.id) {
      this.state.triggers[group.chat] = hook.id;
      this.persist();
    }
    return hook;
  }

  /** A finished run's reply waits, neither sent nor drafted, while the catch-up run right before it finds more of wacli's
   * journal to read, so every STOP stored by then applies first; a journal that cannot be read makes it a draft. A reply
   * to be sent reads the journal once more right before it goes to wacli (`sendToGroup`). */
  private async checkRuns(): Promise<void> {
    for (const run of this.state.runs) {
      const receipt = this.options.runState(run.runId);
      const status = receipt?.status;
      if (status === "queued" || status === "running" || status === "waiting") {
        if (this.now() - run.startedAt > RUN_TIMEOUT_MS) await this.endRun(run, "timeout");
        continue;
      }
      if (status !== "completed") await this.endRun(run, status ?? "missing");
      else if (!(await this.runCatchUp()).more) await this.finishRun(run, receipt?.output);
    }
  }

  /** Written at once: a run the state file still shows in flight would be finished again after a restart. */
  private release(run: ActiveRun): void {
    this.state.runs = this.state.runs.filter((candidate) => candidate.runId !== run.runId);
    this.captures.delete(run.runId);
    for (const [thread, runId] of this.threadRuns) if (runId === run.runId) this.threadRuns.delete(thread);
    this.persist();
  }

  private async endRun(run: ActiveRun, reason: string): Promise<void> {
    this.release(run);
    const group = this.group(run.chat);
    this.record({ action: "run_failed", ...(group ? { group: group.key } : {}), ids: run.ids, runId: run.runId, reason: `run_${reason}` });
    this.log(`[whatsapp-intake] run ${run.runId} ended without an answer: ${reason}`);
    if (group && ASKED.has(run.trigger)) await this.toOperator(`[${group.name}] Bot nedokončil odpověď na zprávu, která ho oslovila (${reason}). Podívejte se do skupiny.`);
    await this.startPending(run.chat);
  }

  /** A reply the journal holds back right before it goes out leaves the run in flight, with nothing of it recorded. */
  private async finishRun(run: ActiveRun, storedOutput: string | undefined): Promise<void> {
    const group = this.group(run.chat);
    const capture = this.captures.get(run.runId) ?? { tools: [] };
    const output = group ? parseRunOutput(capture.text ?? storedOutput) : null;
    if (group && output && wantsReply(output)) {
      const reasons = this.replyGuards(group, run, output, capture);
      if (reasons.length) await this.draft(group, run, output.reply, reasons);
      else if (!await this.sendToGroup(group, run, output)) return;
    }
    this.release(run);
    if (!group) {
      this.pending.delete(run.chat);
      return this.record({ action: "no_action", ids: run.ids, runId: run.runId, reason: "group_unmapped" });
    }
    if (!output) {
      this.record({ action: "invalid_output", group: group.key, ids: run.ids, runId: run.runId });
      await this.toOperator(`[${group.name}] Výstup bota je neplatný, do skupiny nic neodešlo (běh ${run.runId}).`);
      return this.startPending(run.chat);
    }
    if (output.digest_line) {
      this.state.digest.lines = [...this.state.digest.lines, { group: group.key, at: this.now(), line: output.digest_line.slice(0, 200) }].slice(-200);
    }
    if (wantsEscalation(output)) await this.escalate(group, run, output);
    if (!wantsReply(output) && !wantsEscalation(output)) this.record({ action: "no_action", group: group.key, ids: run.ids, runId: run.runId });
    await this.startPending(run.chat);
  }

  private replyGuards(group: WhatsappGroup, run: ActiveRun, output: RunOutput, capture: RunCapture): string[] {
    const botCwd = this.bot ? this.options.bots().find((bot) => bot.id === this.bot!.id)?.cwd : undefined;
    const reasons = sendGuards({
      group, map: this.map, reply: output.reply, output, capture, bundle: this.config.bundle,
      ...(botCwd ? { botCwd } : {}), sent: this.sentCounts(group), paused: this.paused(group),
    });
    if (this.catchUpProblem !== undefined) reasons.unshift("catch_up");
    if (group.mode === "draft") reasons.unshift("draft_mode");
    else if (!ASKED.has(run.trigger)) reasons.unshift("unasked");
    return reasons;
  }

  private async startPending(chat: string): Promise<void> {
    const trigger = this.pending.get(chat);
    if (!trigger) return;
    this.pending.delete(chat);
    const group = this.group(chat);
    if (group && group.mode !== "observe") await this.startRun(group, trigger);
  }

  // ── what goes out ──────────────────────────────────────────────────────

  /** The reply's last look, after its spacing wait and right before it goes to wacli: a catch-up, so a STOP wacli stored
   * meanwhile applies even when its webhook was dropped, then the pause. False while that catch-up finds more of the
   * journal than it reads: the reply waits, neither sent nor drafted, for the next tick. A journal that cannot be read,
   * or no longer reaches the checkpoint, makes it a draft. */
  private async sendToGroup(group: WhatsappGroup, run: ActiveRun, output: RunOutput): Promise<boolean> {
    const quote = run.inputIds.includes(output.reply_to) ? output.reply_to : run.ids.at(-1);
    const look = { more: false, reasons: [] as string[] };
    let id: string | null;
    try {
      id = await this.send(group.chat, output.reply, quote, async () => {
        look.more = (await this.runCatchUp()).more;
        look.reasons = [...(this.catchUpProblem !== undefined ? ["catch_up"] : []), ...(this.paused(group) ? ["paused"] : [])];
        return !look.more && !look.reasons.length;
      });
    } catch (error) {
      this.lastError = errorText(error);
      this.record({ action: "send_failed", group: group.key, ids: run.ids, runId: run.runId });
      await this.draft(group, run, output.reply, ["send_failed"]);
      return true;
    }
    if (id === null && look.more) return false;
    if (id === null) {
      await this.draft(group, run, output.reply, look.reasons);
      return true;
    }
    const at = this.now();
    this.state.sent = [...this.state.sent, { id, chat: group.chat, at }];
    const chat = this.chat(group.chat);
    chat.open = chat.open.filter((entry) => entry.at > at);
    this.record({ action: "sent", group: group.key, ids: [id, ...(quote ? [quote] : [])], runId: run.runId });
    this.log(`[whatsapp-intake] ${group.key}: reply sent (run ${run.runId})`);
    return true;
  }

  private async draft(group: WhatsappGroup, run: ActiveRun, reply: string, reasons: string[]): Promise<void> {
    const delivered = await this.toOperator(`[${group.name} · ${clock(this.now())}] Návrh odpovědi, neodesláno: ${reasons.map(reasonText).join("; ")}.\n\n${reply}`);
    this.record({ action: delivered ? "draft" : "send_failed", group: group.key, ids: run.ids, runId: run.runId, reason: delivered ? reasons.join(",") : "operator" });
    this.log(`[whatsapp-intake] ${group.key}: reply drafted for the operator (${reasons.join(",")})${delivered ? "" : ", but the operator's chat failed"}`);
  }

  private async escalate(group: WhatsappGroup, run: ActiveRun, output: RunOutput): Promise<void> {
    const escalation = output.escalation;
    const urgency = escalation?.urgency ?? "normal";
    await this.toOperator(`[${group.name} · ${clock(this.now())}] Eskalace, naléhavost ${URGENCY[urgency] ?? urgency}: ${escalation?.summary.trim() || "bot žádá, abyste se podívali do skupiny."}${escalation?.next_step?.trim() ? `\nNávrh: ${escalation.next_step.trim()}` : ""}`);
    this.record({ action: "escalated", group: group.key, ids: run.ids, runId: run.runId, reason: urgency });
  }

  /** True once the line is sent; while a send asks `ready`, true at once, and the line goes out after that send. */
  private async toOperator(text: string): Promise<boolean> {
    const sent = this.send(this.config.operator, text.slice(0, MAX_OPERATOR_TEXT)).then(() => true, (error: unknown) => {
      this.lastError = `the operator's chat: ${errorText(error)}`;
      this.log(`[whatsapp-intake] could not write to the operator: ${errorText(error)}`);
      return false;
    });
    return this.asking ? true : sent;
  }

  /** One send at a time, a random 3–8 s after the previous one, as the follower's own spacing. `ready` is asked after that
   * wait, right before the text goes to wacli; when it says no (a STOP during the wait), nothing is sent and the result
   * is null. A line for the operator written while `ready` runs is not awaited (`toOperator`): it would wait for the very
   * send that waits for `ready`. The catch-up knows a sent message as already handled.
   * Known open risk: a text already handed to wacli, which paces it again, is not recalled. */
  private send(to: string, text: string, replyTo?: string, ready?: () => Promise<boolean>): Promise<string | null> {
    const job = this.sending.then(async () => {
      const gap = SPACING_MS[0] + Math.floor(this.random() * (SPACING_MS[1] - SPACING_MS[0]));
      const wait = this.lastSendAt + gap - this.now();
      if (this.lastSendAt && wait > 0) await this.sleep(wait);
      if (ready) {
        this.asking = true;
        const go = await ready().finally(() => { this.asking = false; });
        if (!go) return null;
      }
      try {
        const id = await this.options.wacli.sendText(to, text, replyTo);
        this.remember(to, id, this.now(), true);
        return id;
      } finally {
        this.lastSendAt = this.now();
      }
    });
    this.sending = job.catch(() => undefined);
    return job;
  }

  private sentCounts(group: WhatsappGroup): SentCounts {
    const now = this.now();
    const sends = this.state.ledger.filter((entry) => entry.action === "sent" && now - entry.at < DAY_MS);
    const own = sends.filter((entry) => entry.group === group.key);
    return { groupLastHour: own.filter((entry) => now - entry.at < 60 * 60_000).length, groupLastDay: own.length, allLastDay: sends.length };
  }

  // ── the digest ─────────────────────────────────────────────────────────

  private async maybeDigest(): Promise<void> {
    const local = pragueParts(this.now());
    if (local.weekday > 5 || local.hour < DIGEST_HOUR || this.state.digest.lastDay === local.day) return;
    if (this.now() - this.digestTriedAt < DIGEST_RETRY_MS) return;
    this.digestTriedAt = this.now();
    if (!await this.toOperator(this.digestText())) return;
    this.state.digest = { lastDay: local.day, lastAt: this.now(), lines: [] };
    this.record({ action: "digest" });
  }

  digestText(): string {
    return composeDigest({ state: this.state, map: this.map, now: this.now(), follower: FOLLOWER_WORDS[this.followerInfo.state], unmapped: this.unmapped.size });
  }

  // ── catch-up and the map ───────────────────────────────────────────────

  /** Reads wacli's change journal from the checkpoint, in store order, so messages of the same second and a backlog of any
   * size are read once each. The checkpoint moves past a page only once it is handled; a page read again after a failure
   * or a restart finds its messages already seen. A journal that cannot be read fails closed. */
  private async runCatchUp(): Promise<CatchUpSummary> {
    this.lastCatchUpAt = this.now();
    this.reloadMap();
    const summary: CatchUpSummary = { changes: 0, messages: 0, errors: 0, more: false };
    try {
      if (this.state.journal) {
        await this.readJournal(this.state.journal, summary);
        await this.catchUpWorks();
      } else if (!await this.collect()) summary.errors++;
    } catch (error) {
      summary.errors++;
      summary.more = false;
      await (lostCheckpoint(error) ? this.journalLost(error) : this.catchUpFails(error));
    }
    this.catchUpMore = summary.more;
    this.persist();
    return summary;
  }

  private async readJournal(journal: { checkpoint: string }, summary: CatchUpSummary): Promise<void> {
    for (let page = 0; page < CATCH_UP_PAGES; page++) {
      const read = await this.options.wacli.changes(journal.checkpoint, CATCH_UP_LIMIT);
      for (const change of read.changes) {
        summary.changes++;
        summary.messages += await this.replay(change);
      }
      journal.checkpoint = read.next;
      this.persist();
      summary.more = read.more;
      if (!read.more) break;
    }
    if (!summary.more) for (const chat of Object.values(this.state.chats)) this.forget(chat, SEEN_PER_CHAT);
  }

  /** One journal entry. A message of the operator's chat or a mapped group that was not handled yet is read from the store
   * and handled as if it had arrived live; returns 1 for it. In the operator's chat that is every id the intake no longer
   * keeps: the journal cannot tell a new message from a changed one, and a command there is never skipped. For the same
   * reason every change to one of the operator's messages is read there, with an edit time of the same edit as its text
   * (`readEdit`), also the ones it keeps and the ones from before its first start: it may be an edit (`fromOperatorEdit`). */
  private async replay(change: WaChange): Promise<number> {
    const { chat: chatId, id } = change.movedTo ?? change;
    const operator = chatId === this.config.operator;
    if (!operator && !this.group(chatId)) return 0;
    const chat = this.chat(chatId);
    if (!operator && (change.at < this.state.activatedAt || change.at <= (chat.forgottenUpTo ?? -Infinity))) return 0;
    const known = chat.seen.find((entry) => entry.id === id);
    if (known && (!operator || known.own)) return 0;
    const read = operator ? await readEdit(this.options.wacli, chatId, id) : null;
    const message = read ? read.message : await this.options.wacli.message(chatId, id);
    if (!message) return 0;
    if (read && message.edited) await this.fromOperatorEdit({ ...message, chat: chatId }, read);
    else if (!known) await this.ingest({ ...message, chat: chatId });
    return known ? 0 : 1;
  }

  /** The follower and the catch-up start from a checkpoint in wacli's journal, taken before the follower stores anything,
   * at the first start and after the journal no longer reaches the old one; history stored before it is never handled.
   * Until one is taken nothing is collected or sent, and it is tried again with backoff. */
  private async collect(): Promise<boolean> {
    if (!this.state.journal) {
      try {
        this.state.journal = { checkpoint: await this.options.wacli.checkpoint() };
      } catch (error) {
        this.checkpointRetryAt = this.now() + FOLLOWER_BACKOFF_MS[Math.min(this.checkpointFailures++, FOLLOWER_BACKOFF_MS.length - 1)];
        await this.catchUpFails(error);
        return false;
      }
      this.checkpointFailures = 0;
      this.persist();
      await this.catchUpWorks();
    }
    if (!this.restartTimer) this.startFollower();
    return true;
  }

  /** Until the journal can be read again nothing vouches that the webhook dropped no STOP, so replies are drafts; without
   * a checkpoint nothing is collected at all. The operator hears it once. */
  private async catchUpFails(error: unknown): Promise<void> {
    const reported = this.catchUpProblem !== undefined;
    const anchored = this.state.journal !== undefined;
    this.catchUpProblem = this.lastError = errorText(error);
    this.log(`[whatsapp-intake] ${anchored ? "the catch-up cannot read wacli's journal" : "no checkpoint in wacli's journal, so nothing is collected"}: ${this.catchUpProblem}`);
    if (reported) return;
    await this.toOperator(anchored
      ? `Dohledávání zpráv, které webhook ztratil, nefunguje (${this.catchUpProblem}). Dokud nepůjde, odpovědi bota vám chodí sem jako návrhy.`
      : `Příjem zpráv ze skupin nemůže začít: wacli nevrací místo v záznamu změn, od kterého by šlo dohledat, co webhook ztratí (${this.catchUpProblem}). Dokud to nepůjde, nic se nepřijímá ani neodesílá.`);
  }

  private async catchUpWorks(): Promise<void> {
    if (this.catchUpProblem === undefined) return;
    delete this.catchUpProblem;
    this.log("[whatsapp-intake] the catch-up reads wacli's journal again");
    await this.toOperator("Dohledávání zpráv znovu funguje.");
  }

  /** wacli no longer holds the journal from the checkpoint on: it expired, or the store is another one. What the webhook
   * dropped meanwhile, a STOP included, cannot be found, so sending pauses as after a STOP until the operator's START,
   * and the follower stops until a new checkpoint is taken. */
  private async journalLost(error: unknown): Promise<void> {
    delete this.state.journal;
    applyCommand(this.state.commands, { verb: "stop", at: this.now(), id: "journal" }, undefined, this.map.groups);
    this.record({ action: "command", reason: "stop:journal_lost" });
    this.log(`[whatsapp-intake] wacli's journal no longer reaches the catch-up's checkpoint (${errorText(error)}); sending paused`);
    await this.toOperator("Dohledávání zpráv nemůže navázat: wacli už nemá záznam změn od místa, kde skončilo. Co webhook mezitím ztratil, i případný STOP, se nedá dohledat, proto je odesílání do všech skupin pozastavené. Obnovíte ho zprávou START.");
    await this.stopFollower();
    await this.collect();
  }

  private mapMtime(): number {
    return statSync(this.config.groupsFile, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  }

  private reloadMap(): void {
    const changedAt = this.mapMtime();
    if (!changedAt || changedAt === this.mapChangedAt) return;
    this.mapChangedAt = changedAt;
    try {
      this.map = loadGroupMap(this.config.groupsFile);
      this.log(`[whatsapp-intake] group map reloaded: ${this.map.groups.length} groups`);
    } catch (error) {
      this.lastError = `the group map was not reloaded: ${errorText(error)}`;
      this.log(`[whatsapp-intake] ${this.lastError}`);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private group(chat: string): WhatsappGroup | undefined {
    return this.map.groups.find((group) => group.chat === chat);
  }

  private isTeam(sender: string): boolean {
    const user = userOf(sender);
    return user === userOf(this.config.operator) || this.map.team.some((member) => userOf(member) === user);
  }

  private paused(group: WhatsappGroup): boolean {
    return isPaused(this.state.commands, group.key);
  }

  private chat(chat: string): ChatState {
    this.state.chats[chat] ??= { seen: [], open: [] };
    return this.state.chats[chat];
  }

  private target(): { id: string; name: string } | null {
    const wanted = this.config.bot;
    const bots = this.options.bots();
    const named = bots.filter((bot) => bot.name.trim().toLowerCase() === wanted.toLowerCase());
    const bot = bots.find((candidate) => candidate.id === wanted) ?? (named.length === 1 ? named[0] : undefined);
    if (!bot) {
      this.targetProblem = named.length
        ? `${named.length} bots are named "${wanted}"; set OMB_WHATSAPP_INTAKE_BOT to one bot's id`
        : `no bot has the id or name "${wanted}" (OMB_WHATSAPP_INTAKE_BOT)`;
      this.lastError = this.targetProblem;
      return null;
    }
    delete this.targetProblem;
    this.bot = { id: bot.id, name: bot.name };
    return this.bot;
  }

  /** Serialises everything the intake does; a failure is reported in the status, never thrown at the caller. */
  private enqueue<T>(job: () => Promise<T> | T): Promise<T | undefined> {
    const next = this.work.then(job).catch((error: unknown) => this.failed(error));
    this.work = next;
    return next;
  }

  private failed(error: unknown): undefined {
    this.lastError = errorText(error);
    this.log(`[whatsapp-intake] ${this.lastError}`);
    return undefined;
  }

  private record(entry: Omit<LedgerEntry, "at">): void {
    this.state.ledger.push({ ...entry, at: this.now() });
    this.persist();
  }

  private load(): IntakeState {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(readFileSync(this.options.file, "utf8")));
      if (parsed.success) return parsed.data;
      this.log(`[whatsapp-intake] ignoring an unreadable ${this.options.file}; webhook receipts still prevent duplicate runs`);
    } catch {
      // No file yet.
    }
    const fresh: IntakeState = {
      version: 1, activatedAt: this.now(), triggers: {}, commands: { groups: {} }, chats: {}, sent: [], runs: [], ledger: [], digest: { lines: [] },
    };
    this.state = fresh;
    this.persist();
    return fresh;
  }

  /** Writes the state under the guard. While a backup or restore owns the quiet workspace the guard refuses, the file
   * stays untouched and the state waits in memory for the next write; a failing write still throws. */
  private persist(): void {
    const cutoff = this.now() - LEDGER_TTL_MS;
    this.state.ledger = this.state.ledger.filter((entry) => entry.at >= cutoff).slice(-MAX_LEDGER);
    this.state.sent = this.state.sent.filter((entry) => entry.at >= cutoff);
    let writing = false;
    try {
      this.guard(() => {
        writing = true;
        mkdirSync(dirname(this.options.file), { recursive: true });
        writeFileAtomic(this.options.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      });
    } catch (error) {
      if (writing) throw error;
    }
  }
}
