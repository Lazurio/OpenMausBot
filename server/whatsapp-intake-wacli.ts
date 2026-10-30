// Lazurio MausBot WhatsApp intake: the one place that talks to wacli, the
// Environment's WhatsApp tool (openclaw/wacli, formerly steipete/wacli), so
// the intake runs against a double in tests. Every command, flag, header and
// field name here was read in wacli v0.25.1 (commit b7603b69).
//
// Security invariants: message text, the webhook secret and wacli's output are
// never logged, and a recipient is always a full chat id, never a name wacli
// would resolve.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import { z } from "zod";

import { GROUP_JID, USER_JID } from "./whatsapp-intake-config.ts";
import { readEditTime, type EditTime } from "./whatsapp-intake-wacli-store.ts";

export interface WaMessage {
  chat: string;
  id: string;
  sender: string;
  senderName: string;
  at: number;
  fromMe: boolean;
  text: string;
  replyToId?: string;
  replyToSender?: string;
  media?: string;
  forwarded?: boolean;
  /** A reaction, a revoke, an edit, a poll vote or a call: stored, never a question. */
  service?: boolean;
  /** An edit, which wacli v0.25.1 stores over the message it edits, under that message's id. The webhook gives the edit's
   * own time; the stored row keeps the edited message's own time, and the edit's is only in wacli's store (`editedAt`). */
  edited?: boolean;
}

export interface WacliAccount {
  authenticated: boolean;
  jid?: string;
}

/** One entry of wacli's change journal: a message the store took in, changed, moved or removed. No text. */
export interface WaChange {
  sequence: number;
  /** wacli v0.25.1: "upsert", "delete" or "identity_move". A message the store takes in and one it changes (an edit is
   * stored over the message it edits) are both "upsert": the journal does not tell a new message from a changed one. */
  operation: string;
  chat: string;
  id: string;
  /** Where an "identity_move" took the message. */
  movedTo?: { chat: string; id: string };
  /** The message's own time. */
  at: number;
}

export interface WaChanges {
  changes: WaChange[];
  more: boolean;
  /** Where the next read starts; to be kept only once these changes are handled. */
  next: string;
}

export type FollowerEvent =
  | { kind: "connected" }
  | { kind: "reconnecting" }
  | { kind: "logged_out" }
  | { kind: "warning"; code: string }
  | { kind: "error"; message: string }
  | { kind: "exit"; code: number | null; missing?: boolean };

export interface WacliFollower {
  stop(): Promise<void>;
}

export interface Wacli {
  account(): Promise<WacliAccount>;
  /** One chat's newest `limit` stored messages, oldest first. */
  messages(chat: string, limit: number): Promise<WaMessage[]>;
  /** One stored message; null when the store no longer holds it. */
  message(chat: string, id: string): Promise<WaMessage | null>;
  /** When one stored message was last edited, which no wacli command prints: read from its store (`readEditTime`). */
  editedAt(chat: string, id: string): Promise<EditTime>;
  /** The change journal's present position, without what it holds. Taken only while the follower is stopped. */
  checkpoint(): Promise<string>;
  /** What the store recorded after `since`, in store order, at most `limit` entries. A position the journal no longer holds
   * fails with an error for which `lostCheckpoint` is true. */
  changes(since: string, limit: number): Promise<WaChanges>;
  /** Sends text only; resolves to the new message id. */
  sendText(to: string, text: string, replyTo?: string): Promise<string>;
  /** Starts `sync --follow`, which posts each stored live message to the webhook. */
  follow(webhook: { url: string; secret: string }, onEvent: (event: FollowerEvent) => void): WacliFollower;
}

/** How many times `readEdit` reads a message's text at most. */
export const EDIT_READS = 3;

/** A stored message with the time of its latest edit (`readEdit`). */
export interface EditRead {
  message: WaMessage | null;
  /** The edit time read after the text; when `settled`, the one read before it too. */
  edited: EditTime;
  /** Whether the time read before the text and the one read after it agree, so that both belong to the edit read. */
  settled: boolean;
  /** The newest edit time any of the reads gave, the one before the first text included; null when none gave one. */
  newest: number | null;
}

/** A stored message and the time of its latest edit, both of one edit. The time is read before and after the text, and
 * the two must agree: wacli moves it on only for an edit of a later second, so an equal time means the text read is of
 * an edit of that second. A time that moved means an edit was stored meanwhile: the text is read again, at most
 * `EDIT_READS` times, and past that the pair is not `settled`. A store that cannot tell the time at both reads settles
 * too: every change then counts as a new edit anyway. Whatever settles, every time a read gave counts for `newest`. */
export async function readEdit(wacli: Pick<Wacli, "message" | "editedAt">, chat: string, id: string): Promise<EditRead> {
  let before = await wacli.editedAt(chat, id);
  let newest = "at" in before ? before.at : null;
  for (let read = 1; ; read++) {
    const message = await wacli.message(chat, id);
    const edited = await wacli.editedAt(chat, id);
    if ("at" in edited) newest = Math.max(newest ?? edited.at, edited.at);
    const settled = "at" in before ? "at" in edited && edited.at === before.at : "unknown" in edited;
    if (settled || read === EDIT_READS) return { message, edited, settled, newest };
    before = edited;
  }
}

/** A send that waits behind wacli's spacing stays inside this, wacli's own deadline. */
export const SEND_TIMEOUT_S = 60;
export const FOLLOW_SEND_SPACING = "3s-8s";
const COMMAND_TIMEOUT_MS = 90_000;
const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_WEBHOOK_BODY = 256 * 1024;
const TERMINATE_GRACE_MS = 5_000;

// wacli v0.25.1: `messages list` gives a chat's newest `--limit` messages; `messages show` one stored message, a deleted
// one included; `messages changes` the store's change journal in store order, without text, after a checkpoint it
// printed (`--since`), or with `--checkpoint` the present position. None of them takes the store lock, so they read
// while the follower runs. A read-only open of a store no writable wacli has migrated for the journal yet refuses
// `messages changes`; the checkpoint, taken while the follower is stopped, is a writable open, which migrates it.
// `--read-only` and `--json` are global. `--to` with an "@" is parsed as a chat id, never looked up by name.
export function accountArgs(): string[] {
  return ["--read-only", "--json", "auth", "status"];
}

export function messagesArgs(chat: string, limit: number): string[] {
  return ["--read-only", "--json", "messages", "list", "--chat", checkedChat(chat), "--limit", String(limit)];
}

export function showArgs(chat: string, id: string): string[] {
  return ["--read-only", "--json", "messages", "show", "--chat", checkedChat(chat), "--id", id];
}

export function checkpointArgs(): string[] {
  return ["--json", "messages", "changes", "--checkpoint"];
}

export function changesArgs(since: string, limit: number): string[] {
  return ["--read-only", "--json", "messages", "changes", "--since", since, "--limit", String(limit)];
}

export function sendArgs(to: string, text: string, replyTo?: string): string[] {
  return ["--json", "--timeout", `${SEND_TIMEOUT_S}s`, "send", "text", "--to", checkedChat(to), "--message", text, "--no-preview",
    ...(replyTo ? ["--reply-to", replyTo] : [])];
}

// wacli v0.25.1: a webhook on 127.0.0.1 needs --webhook-allow-private; the secret exists only as a flag, so it is in
// this process's arguments, readable by the same OS user (the Environment's boundary anyway).
export function followArgs(webhook: { url: string; secret: string }, maxDbSize: string): string[] {
  return ["sync", "--follow", "--events", "--webhook", webhook.url, "--webhook-secret", webhook.secret, "--webhook-allow-private",
    "--send-spacing", FOLLOW_SEND_SPACING, "--max-db-size", maxDbSize];
}

function checkedChat(chat: string): string {
  if (!GROUP_JID.test(chat) && !USER_JID.test(chat)) throw new Error("wacli: refusing a recipient that is not a full chat id");
  return chat;
}

// ── wacli's JSON ─────────────────────────────────────────────────────────

const envelopeSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), error: z.string().nullable().optional() });
const accountSchema = z.object({ authenticated: z.boolean(), linked_jid: z.string().optional() });
const sentSchema = z.object({ sent: z.boolean(), id: z.string().min(1) });
const pageSchema = z.object({ messages: z.array(z.unknown()).nullable() });
// wacli v0.25.1: `messages changes --json`, with RFC 3339 times.
const changesSchema = z.object({
  changes: z.array(z.object({
    sequence: z.number().int(),
    operation: z.string(),
    chat_jid: z.string(),
    msg_id: z.string(),
    new_chat_jid: z.string().optional(),
    new_msg_id: z.string().optional(),
    message_time: z.string(),
  })),
  has_more: z.boolean(),
  next_checkpoint: z.string().min(1),
});

// wacli v0.25.1 refuses a checkpoint it can no longer serve with one of these (internal/store/changes.go and
// retrieval.go): the journal expired past it, it belongs to another store, or it does not parse.
const LOST_CHECKPOINT = /expired checkpoint|checkpoint belongs to another store|invalid checkpoint position|unsupported checkpoint|malformed cursor\/checkpoint/;
// wacli v0.25.1: `messages show` for a message the store does not hold fails with SQL's own error.
const NOT_STORED = "sql: no rows in result set";

/** True for the error of a journal read whose checkpoint wacli no longer holds: what it covered cannot be read again. */
export function lostCheckpoint(error: unknown): boolean {
  return error instanceof Error && (error as { lost?: unknown }).lost === true;
}

const text = z.string().nullable().optional().transform((value) => value ?? "");
const flag = z.boolean().nullable().optional().transform((value) => value === true);
// wacli v0.25.1: the live webhook carries `ParsedMessage` with Go field names; a payload with `EventType` is a receipt
// or a presence, not a message. Chat ids are the store's (a known LID becomes the phone number's id).
const liveSchema = z.object({
  EventType: z.string().optional(),
  Chat: z.string(),
  ID: z.string().min(1),
  SenderJID: text,
  Timestamp: z.string(),
  FromMe: flag,
  Text: text,
  PushName: text,
  ReplyToID: text,
  ReplyToSenderJID: text,
  Media: z.object({ Type: text, Caption: text }).nullable().optional(),
  IsForwarded: flag,
  ReactionToID: text,
  Revoked: flag,
  Edited: flag,
  PollVote: z.unknown().optional(),
  PollAdd: z.unknown().optional(),
  Call: z.unknown().optional(),
});
// wacli v0.25.1: `messages list` and `messages show` rows are the store's `Message`, Go field names except the quote's
// two and `deleted_at`, which only `show` returns, for a deleted message.
const storedSchema = z.object({
  ChatJID: z.string(),
  MsgID: z.string().min(1),
  SenderJID: text,
  SenderName: text,
  Timestamp: z.string(),
  FromMe: flag,
  Text: text,
  quoted_msg_id: text,
  quoted_sender_jid: text,
  MediaType: text,
  MediaCaption: text,
  IsForwarded: flag,
  ReactionToID: text,
  Revoked: flag,
  Edited: flag,
  DeletedForMe: flag,
  deleted_at: z.string().nullable().optional(),
});

/** A live webhook payload as a message; null for anything else. */
export function liveMessage(payload: unknown): WaMessage | null {
  const parsed = liveSchema.safeParse(payload);
  if (!parsed.success || parsed.data.EventType) return null;
  const row = parsed.data;
  const at = Date.parse(row.Timestamp);
  if (!Number.isFinite(at)) return null;
  return message({
    chat: row.Chat, id: row.ID, sender: row.SenderJID, senderName: row.PushName, at, fromMe: row.FromMe,
    text: row.Text.trim() || row.Media?.Caption.trim() || "", replyToId: row.ReplyToID, replyToSender: row.ReplyToSenderJID,
    media: row.Media?.Type ?? "", forwarded: row.IsForwarded, edited: row.Edited,
    service: Boolean(row.ReactionToID) || row.Revoked || row.Edited || row.PollVote != null || row.PollAdd != null || row.Call != null,
  });
}

export function storedMessage(value: unknown): WaMessage | null {
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  const at = Date.parse(row.Timestamp);
  if (!Number.isFinite(at)) return null;
  return message({
    chat: row.ChatJID, id: row.MsgID, sender: row.SenderJID, senderName: row.SenderName, at, fromMe: row.FromMe,
    text: row.Text.trim() || row.MediaCaption.trim(), replyToId: row.quoted_msg_id, replyToSender: row.quoted_sender_jid,
    media: row.MediaType, forwarded: row.IsForwarded, edited: row.Edited,
    service: Boolean(row.ReactionToID) || row.Revoked || row.Edited || row.DeletedForMe || Boolean(row.deleted_at),
  });
}

function message(fields: Omit<WaMessage, "replyToId" | "replyToSender" | "media" | "forwarded" | "service" | "edited"> & {
  replyToId: string; replyToSender: string; media: string; forwarded: boolean; service: boolean; edited: boolean;
}): WaMessage {
  const { replyToId, replyToSender, media, forwarded, service, edited, ...rest } = fields;
  return {
    ...rest,
    ...(replyToId ? { replyToId } : {}),
    ...(replyToSender ? { replyToSender } : {}),
    ...(media ? { media } : {}),
    ...(forwarded ? { forwarded } : {}),
    ...(service ? { service } : {}),
    ...(edited ? { edited } : {}),
  };
}

// ── the follower's stderr ─────────────────────────────────────────────────

const lineSchema = z.object({ event: z.string(), data: z.record(z.string(), z.unknown()).optional() });

// wacli v0.25.1 `--events`: one NDJSON object per stderr line, {"event", "data", "ts"}.
export function followerEvent(line: string): FollowerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = lineSchema.safeParse(value);
  if (!parsed.success) return null;
  const { event, data } = parsed.data;
  if (event === "connected") return { kind: "connected" };
  if (["disconnected", "reconnecting", "stale", "stream_replaced"].includes(event)) return { kind: "reconnecting" };
  if (event === "logged_out") return { kind: "logged_out" };
  if (event === "warning") return { kind: "warning", code: typeof data?.code === "string" ? data.code.slice(0, 80) : "warning" };
  if (event === "error") return { kind: "error", message: typeof data?.message === "string" ? data.message.slice(0, 300) : "" };
  return null;
}

// ── the webhook receiver ──────────────────────────────────────────────────

// wacli v0.25.1: `X-Wacli-Signature: sha256=<hex HMAC-SHA256 of the body>` with --webhook-secret.
export const SIGNATURE_HEADER = "x-wacli-signature";

export function wacliSignature(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function signatureMatches(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(wacliSignature(secret, body));
  const actual = Buffer.from(header.trim());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > MAX_WEBHOOK_BODY) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

/** A loopback-only receiver for the follower's webhook on a port the OS picks. Only a body signed with `secret`
 * reaches `onPayload`; everything else is refused before it is parsed. */
export async function listenForWacli(secret: string, onPayload: (payload: unknown) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const reply = (status: number) => { res.writeHead(status, { "cache-control": "no-store" }); res.end(); };
    if (req.method !== "POST" || req.url !== "/events") return reply(404);
    readBody(req).then((body) => {
      if (!body) return reply(413);
      const header = req.headers[SIGNATURE_HEADER];
      if (!signatureMatches(secret, body, Array.isArray(header) ? header[0] : header)) return reply(401);
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(400);
      }
      reply(204);
      onPayload(payload);
    }, () => reply(400));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the WhatsApp intake receiver got no TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/events`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── the real wacli ────────────────────────────────────────────────────────

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
    child.once("close", () => { clearTimeout(force); resolve(); });
    child.kill("SIGTERM");
  });
}

function run(bin: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string; missing?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, windowsHide: true });
    const timer = setTimeout(() => {
      void terminate(child);
      finish({ code: null, stdout: "", stderr: `wacli ${args.includes("send") ? "send" : "command"} timed out` });
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < MAX_STDOUT) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout: "", stderr: "", missing: error.code === "ENOENT" }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

/** The data of wacli's JSON envelope, or an Error with wacli's own reason (it prints the envelope on stderr when it fails). */
async function runJson<T>(bin: string, command: string, args: string[], schema: z.ZodType<T>): Promise<T> {
  const result = await run(bin, args);
  if (result.missing) throw Object.assign(new Error("wacli is not installed or not on PATH"), { missing: true });
  const envelope = [result.stdout, result.stderr].map((stream) => {
    const last = stream.trim().split("\n").at(-1) ?? "";
    try { return envelopeSchema.parse(JSON.parse(last)); } catch { return null; }
  }).find(Boolean);
  if (!envelope?.success) throw new Error(`wacli ${command}: ${(envelope?.error ?? result.stderr.trim().split("\n")[0] ?? "").slice(0, 200) || `exit ${result.code}`}`);
  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) throw new Error(`wacli ${command}: unexpected output`);
  return parsed.data;
}

export function spawnWacli(options: { bin?: string; store?: string; maxDbSize: string }): Wacli {
  const bin = options.bin ?? "wacli";
  const store = options.store ? ["--store", options.store] : [];
  return {
    async account() {
      const data = await runJson(bin, "auth status", [...store, ...accountArgs()], accountSchema);
      return { authenticated: data.authenticated, ...(data.linked_jid ? { jid: data.linked_jid } : {}) };
    },
    async messages(chat, limit) {
      const page = await runJson(bin, "messages list", [...store, ...messagesArgs(chat, limit)], pageSchema);
      const rows = (page.messages ?? []).map(storedMessage).filter((row): row is WaMessage => row !== null);
      return rows.sort((a, b) => a.at - b.at);
    },
    async message(chat, id) {
      try {
        const row = storedMessage(await runJson(bin, "messages show", [...store, ...showArgs(chat, id)], z.unknown()));
        if (!row) throw new Error("wacli messages show: unexpected output");
        return row;
      } catch (error) {
        if (error instanceof Error && error.message.includes(NOT_STORED)) return null;
        throw error;
      }
    },
    async editedAt(chat, id) {
      return readEditTime(options.store, chat, id);
    },
    async checkpoint() {
      return (await runJson(bin, "messages changes", [...store, ...checkpointArgs()], changesSchema)).next_checkpoint;
    },
    async changes(since, limit) {
      let page: z.output<typeof changesSchema>;
      try {
        page = await runJson(bin, "messages changes", [...store, ...changesArgs(since, limit)], changesSchema);
      } catch (error) {
        throw error instanceof Error && LOST_CHECKPOINT.test(error.message) ? Object.assign(error, { lost: true }) : error;
      }
      // wacli v0.25.1 records a LID chat's messages moving to the phone number's chat with the new chat only: the id stays.
      const changes = page.changes.map((row): WaChange => ({
        sequence: row.sequence, operation: row.operation, chat: row.chat_jid, id: row.msg_id, at: Date.parse(row.message_time),
        ...(row.new_chat_jid ? { movedTo: { chat: row.new_chat_jid, id: row.new_msg_id || row.msg_id } } : {}),
      }));
      if (changes.some((change) => !Number.isFinite(change.at))) throw new Error("wacli messages changes: unexpected output");
      return { changes, more: page.has_more, next: page.next_checkpoint };
    },
    async sendText(to, body, replyTo) {
      const sent = await runJson(bin, "send text", [...store, ...sendArgs(to, body, replyTo)], sentSchema);
      if (!sent.sent) throw new Error("wacli send text: not sent");
      return sent.id;
    },
    follow(webhook, onEvent) {
      const child = spawn(bin, [...store, ...followArgs(webhook, options.maxDbSize)], {
        stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, NO_COLOR: "1" }, windowsHide: true,
      });
      let ended = false;
      const end = (event: FollowerEvent) => {
        if (ended) return;
        ended = true;
        onEvent(event);
      };
      createInterface({ input: child.stderr }).on("line", (line) => {
        const event = followerEvent(line);
        if (event && !ended) onEvent(event);
      });
      child.on("error", (error: NodeJS.ErrnoException) => end({ kind: "exit", code: null, missing: error.code === "ENOENT" }));
      child.on("close", (code) => end({ kind: "exit", code }));
      return { stop: () => terminate(child) };
    },
  };
}
