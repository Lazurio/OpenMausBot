// The wacli adapter of the WhatsApp intake: the exact commands it runs, both
// message shapes and the change journal wacli v0.25.1 prints, the follower's
// event lines and the signed loopback receiver. A fake `wacli` script stands in
// for the real one; nothing reaches WhatsApp.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { EditTime } from "./whatsapp-intake-wacli-store.ts";
import {
  changesArgs, checkpointArgs, followArgs, followerEvent, listenForWacli, liveMessage, lostCheckpoint, messagesArgs, readEdit, sendArgs, showArgs,
  signatureMatches, spawnWacli, storedMessage, wacliSignature, EDIT_READS, SIGNATURE_HEADER, type FollowerEvent,
} from "./whatsapp-intake-wacli.ts";

const GROUP = "120363000000000001@g.us";
const dir = mkdtempSync(join(tmpdir(), "omb-whatsapp-wacli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the commands", () => {
  it("follows with a signed loopback webhook, wacli's own send spacing and a capped store", () => {
    expect(followArgs({ url: "http://127.0.0.1:45000/events", secret: "s3cret" }, "2GB")).toEqual([
      "sync", "--follow", "--events", "--webhook", "http://127.0.0.1:45000/events", "--webhook-secret", "s3cret", "--webhook-allow-private",
      "--send-spacing", "3s-8s", "--max-db-size", "2GB",
    ]);
  });

  it("reads read-only: a chat's newest messages, one message, and the change journal from a checkpoint", () => {
    expect(messagesArgs(GROUP, 40)).toEqual(["--read-only", "--json", "messages", "list", "--chat", GROUP, "--limit", "40"]);
    expect(showArgs(GROUP, "3EB0A1")).toEqual(["--read-only", "--json", "messages", "show", "--chat", GROUP, "--id", "3EB0A1"]);
    expect(changesArgs("eyJ2IjoxfQ", 200)).toEqual(["--read-only", "--json", "messages", "changes", "--since", "eyJ2IjoxfQ", "--limit", "200"]);
  });

  it("takes the checkpoint with a writable open, which migrates a store no writable wacli has opened since the journal came", () => {
    expect(checkpointArgs()).toEqual(["--json", "messages", "changes", "--checkpoint"]);
  });

  it("sends text only, without a link preview, quoting when asked, to a full chat id and never a name", () => {
    expect(sendArgs(GROUP, "Dobrý den", "3EB0AA")).toEqual(["--json", "--timeout", "60s", "send", "text", "--to", GROUP, "--message", "Dobrý den", "--no-preview", "--reply-to", "3EB0AA"]);
    expect(sendArgs("15550000002@s.whatsapp.net", "x")).not.toContain("--reply-to");
    expect(() => sendArgs("Group B", "x")).toThrow(/full chat id/);
    expect(() => messagesArgs("+1 555 000 0000", 1)).toThrow(/full chat id/);
    expect(() => showArgs("Group B", "3EB0A1")).toThrow(/full chat id/);
  });
});

describe("the message shapes", () => {
  const live = {
    Chat: GROUP, ID: "3EB0A1", SenderJID: "15550000101@s.whatsapp.net", Timestamp: "2026-11-02T08:00:00Z", FromMe: false, Text: "@15550000001 dobrý den",
    Buttons: null, Media: null, Location: null, Poll: null, PollVote: null, PollAdd: null, PushName: "Client One", ReplyToID: "3EB0A0",
    ReplyToSenderJID: "15550000001@s.whatsapp.net", ReplyToDisplay: "", ReactionToID: "", ReactionEmoji: "", IsForwarded: false, ForwardingScore: 0,
    StarredKnown: false, Starred: false, Edited: false, Revoked: false, Call: null, UnhandledPayload: "", ChatName: "Group A",
  };

  it("reads a live webhook message", () => {
    expect(liveMessage(live)).toEqual({
      chat: GROUP, id: "3EB0A1", sender: "15550000101@s.whatsapp.net", senderName: "Client One", at: Date.parse("2026-11-02T08:00:00Z"),
      fromMe: false, text: "@15550000001 dobrý den", replyToId: "3EB0A0", replyToSender: "15550000001@s.whatsapp.net",
    });
    expect(liveMessage({ ...live, Text: "", Media: { Type: "image", Caption: "screenshot", Filename: "", MimeType: "image/jpeg", FileLength: 1 } }))
      .toMatchObject({ text: "screenshot", media: "image" });
    expect(liveMessage({ ...live, ReactionToID: "3EB0A0", ReactionEmoji: "👍" })).toMatchObject({ service: true });
    expect(liveMessage({ ...live, Revoked: true })).toMatchObject({ service: true });
    expect(liveMessage({ ...live, Revoked: true })).not.toHaveProperty("edited");
    // wacli v0.25.1 posts an edit with the edited message's id and the edit's own time.
    expect(liveMessage({ ...live, Edited: true, Timestamp: "2026-11-02T08:04:00Z" })).toMatchObject({ id: "3EB0A1", at: Date.parse("2026-11-02T08:04:00Z"), service: true, edited: true });
  });

  it("is null for receipts, presence and anything else", () => {
    expect(liveMessage({ EventType: "receipt", Chat: GROUP, Sender: "x", MessageIDs: ["3EB0A1"], Timestamp: "2026-11-02T08:00:01Z", Type: "read" })).toBeNull();
    expect(liveMessage({ EventType: "chat_presence", Chat: GROUP, Sender: "x", State: "composing", Media: "" })).toBeNull();
    expect(liveMessage({ ...live, Timestamp: "yesterday" })).toBeNull();
    expect(liveMessage("hello")).toBeNull();
  });

  it("reads a stored row of messages list and messages show, a deleted one as no question, an edited one as an edit", () => {
    const row = {
      ChatJID: GROUP, ChatName: "Group A", MsgID: "3EB0A2", SenderJID: "15550000003@s.whatsapp.net", SenderName: "Team Member", Timestamp: "2026-11-02T08:01:00Z",
      FromMe: false, Text: "Podívám se", DisplayText: "> dobrý den\nPodívám se", quoted_msg_id: "3EB0A1", quoted_sender_jid: "15550000101@s.whatsapp.net",
      IsForwarded: true, ReactionToID: "", MediaType: "", MediaCaption: "", Revoked: false, Edited: false, DeletedForMe: false,
    };
    expect(storedMessage(row)).toEqual({
      chat: GROUP, id: "3EB0A2", sender: "15550000003@s.whatsapp.net", senderName: "Team Member", at: Date.parse("2026-11-02T08:01:00Z"), fromMe: false,
      text: "Podívám se", replyToId: "3EB0A1", replyToSender: "15550000101@s.whatsapp.net", forwarded: true,
    });
    expect(storedMessage({ ...row, deleted_at: "2026-11-02T08:05:00Z", deletion_reason: "expired" })).toMatchObject({ service: true });
    expect(storedMessage({ ...row, deleted_at: "2026-11-02T08:05:00Z", deletion_reason: "expired" })).not.toHaveProperty("edited");
    // wacli v0.25.1 stores an edit over the message it edits: the row keeps that message's time, the edit's own is not printed.
    expect(storedMessage({ ...row, Text: "STOP", Edited: true })).toMatchObject({ at: Date.parse("2026-11-02T08:01:00Z"), text: "STOP", service: true, edited: true });
  });
});

describe("readEdit", () => {
  /** A store whose edit time reads are `times`, in order, and whose text reads number themselves. */
  const reading = (times: EditTime[]) => {
    const order: string[] = [];
    let texts = 0;
    const wacli = {
      editedAt: async () => { order.push("time"); return times.shift()!; },
      message: async () => { order.push("text"); return storedMessage({ ChatJID: GROUP, MsgID: "3EB0E1", Timestamp: "2026-11-02T08:01:00Z", Text: `text ${++texts}`, Edited: true }); },
    };
    return { order, read: () => readEdit(wacli, GROUP, "3EB0E1") };
  };

  it("takes the time read before and after the text when both agree, and reads the text again while it moves, three times at most", async () => {
    const ms = (seconds: number) => Date.parse("2026-11-02T08:05:00Z") + seconds * 1_000;
    const at = (seconds: number): EditTime => ({ at: ms(seconds) });
    const unknown: EditTime = { unknown: "file is not a database" };
    const cases: Array<[EditTime[], string, EditTime, boolean, number | null]> = [
      [[at(0), at(0)], "text 1", at(0), true, ms(0)],
      [[at(0), at(1), at(1)], "text 2", at(1), true, ms(1)],
      [[at(0), at(1), at(2), at(2)], "text 3", at(2), true, ms(2)],
      [[at(0), at(1), at(2), at(3)], "text 3", at(3), false, ms(3)],
      // A store that cannot tell at both reads settles; one that tells at one of them only vouches for no text.
      [[unknown, unknown], "text 1", unknown, true, null],
      [[unknown, at(0), at(0)], "text 2", at(0), true, ms(0)],
      [[at(0), unknown, unknown], "text 2", unknown, true, ms(0)],
      [[at(0), unknown, at(0), unknown], "text 3", unknown, false, ms(0)],
      // Pablo's review of 1cbf1ccb: whatever settles, the newest time any read gave counts, the first one's included.
      [[at(0), unknown, at(1), unknown], "text 3", unknown, false, ms(1)],
      [[at(1), at(0), at(0)], "text 2", at(0), true, ms(1)],
    ];
    for (const [times, text, edited, settled, newest] of cases) {
      const { order, read } = reading([...times]);
      expect(await read()).toMatchObject({ message: { text }, edited, settled, newest });
      expect(order).toEqual(["time", ...times.slice(1).flatMap(() => ["text", "time"])]);
    }
    expect(EDIT_READS).toBe(3);
  });
});

describe("the follower's stderr", () => {
  it("knows the lifecycle events it acts on and nothing else", () => {
    expect(followerEvent(JSON.stringify({ event: "connected", ts: 1 }))).toEqual({ kind: "connected" });
    expect(followerEvent(JSON.stringify({ event: "stale", data: { threshold: "2m" }, ts: 1 }))).toEqual({ kind: "reconnecting" });
    expect(followerEvent(JSON.stringify({ event: "logged_out", ts: 1 }))).toEqual({ kind: "logged_out" });
    expect(followerEvent(JSON.stringify({ event: "warning", data: { code: "sync_webhook_failed", message: "…" }, ts: 1 }))).toEqual({ kind: "warning", code: "sync_webhook_failed" });
    expect(followerEvent(JSON.stringify({ event: "error", data: { message: "sync storage limit reached: database size is 3, limit is 2" }, ts: 1 })))
      .toEqual({ kind: "error", message: "sync storage limit reached: database size is 3, limit is 2" });
    expect(followerEvent(JSON.stringify({ event: "chat_presence", data: { chat_jid: GROUP }, ts: 1 }))).toBeNull();
    expect(followerEvent("Messages stored: 3")).toBeNull();
  });
});

describe("the loopback receiver", () => {
  it("takes only a body signed with its secret, as wacli signs it", async () => {
    const payloads: unknown[] = [];
    const receiver = await listenForWacli("k".repeat(64), (payload) => payloads.push(payload));
    try {
      expect(receiver.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/events$/);
      const body = JSON.stringify({ Chat: GROUP, ID: "3EB0A1" });
      const post = (headers: Record<string, string>, data = body, path = "/events") =>
        fetch(receiver.url.replace("/events", path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: data });
      expect((await post({})).status).toBe(401);
      expect((await post({ [SIGNATURE_HEADER]: wacliSignature("wrong", body) })).status).toBe(401);
      expect((await post({ [SIGNATURE_HEADER]: wacliSignature("k".repeat(64), `${body} `) })).status).toBe(401);
      expect((await post({ [SIGNATURE_HEADER]: wacliSignature("k".repeat(64), body) }, body, "/other")).status).toBe(404);
      expect((await post({ [SIGNATURE_HEADER]: "sha256=00" }, "x".repeat(300 * 1024))).status).toBe(413);
      expect(payloads).toEqual([]);
      expect((await post({ [SIGNATURE_HEADER]: wacliSignature("k".repeat(64), body) })).status).toBe(204);
      expect(payloads).toEqual([{ Chat: GROUP, ID: "3EB0A1" }]);
    } finally {
      await receiver.close();
    }
  });

  it("compares signatures in constant time over the exact bytes", () => {
    const body = Buffer.from("{\"a\":1}");
    expect(signatureMatches("s", body, wacliSignature("s", body))).toBe(true);
    expect(signatureMatches("s", body, wacliSignature("s", body).toUpperCase())).toBe(false);
    expect(signatureMatches("s", body, undefined)).toBe(false);
  });
});

// CommonJS on purpose: an extensionless file outside any package.json.
const FAKE_WACLI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(__CALLS__, JSON.stringify(args) + "\n");
const out = (data) => { process.stdout.write(JSON.stringify({ success: true, data, error: null }) + "\n"); process.exit(0); };
const fail = (error) => { process.stderr.write(JSON.stringify({ success: false, data: null, error }) + "\n"); process.exit(1); };
const has = (word) => args.includes(word);
const value = (flag) => args[args.indexOf(flag) + 1];
if (has("auth")) out({ authenticated: true, linked_jid: "15550000001@s.whatsapp.net", phone: "+15550000001" });
if (has("show") && value("--id") === "GONE") fail("sql: no rows in result set");
if (has("show") && value("--id") === "BROKEN") fail("database disk image is malformed");
if (has("show")) out({ ChatJID: value("--chat"), MsgID: value("--id"), SenderJID: "15550000101@s.whatsapp.net", SenderName: "Client One", Timestamp: "2026-11-02T08:01:00Z", FromMe: false, Text: "first", DeletedForMe: false });
if (has("changes") && has("--checkpoint")) out({ store_id: "s1", changes: [], has_more: false, next_checkpoint: "token-now" });
if (has("changes") && value("--since") === "expired") fail("expired checkpoint: obtain a fresh --checkpoint before a full export, then replay changes after processing that export; restart an invalidated export");
if (has("changes") && value("--since") === "busy") fail("database is locked");
if (has("changes")) out({ store_id: "s1", has_more: true, next_checkpoint: "token-2", changes: [
  { sequence: 3, recorded_at: "2026-11-02T08:03:01Z", operation: "upsert", chat_jid: "120363000000000001@g.us", msg_id: "M3", message_time: "2026-11-02T08:03:00Z" },
  { sequence: 4, recorded_at: "2026-11-02T08:03:02Z", operation: "identity_move", chat_jid: "123456789012345@lid", msg_id: "M4", new_chat_jid: "15550000101@s.whatsapp.net",
    new_msg_id: "M4", reason: "identity_normalization", message_time: "2026-11-02T08:02:00Z" },
  { sequence: 5, recorded_at: "2026-11-02T08:03:03Z", operation: "delete", chat_jid: "120363000000000001@g.us", msg_id: "M2", reason: "revoke", message_time: "2026-11-02T08:02:30Z" },
  { sequence: 6, recorded_at: "2026-11-02T08:03:04Z", operation: "identity_move", chat_jid: "123456789012345@lid", msg_id: "M5", new_chat_jid: "15550000101@s.whatsapp.net",
    reason: "identity_normalization", message_time: "2026-11-02T08:02:40Z" },
] });
if (has("list")) out({ messages: [
  { ChatJID: "120363000000000001@g.us", MsgID: "M2", SenderJID: "15550000101@s.whatsapp.net", SenderName: "Client One", Timestamp: "2026-11-02T08:02:00Z", FromMe: false, Text: "second" },
  { ChatJID: "120363000000000001@g.us", MsgID: "M1", SenderJID: "15550000101@s.whatsapp.net", SenderName: "Client One", Timestamp: "2026-11-02T08:01:00Z", FromMe: false, Text: "first" },
], fts: false, page: {}, source: {} });
if (has("send") && args[args.indexOf("--message") + 1] === "fail") fail("not authenticated; run ` + "`wacli auth`" + String.raw`");
if (has("send")) out({ sent: true, to: args[args.indexOf("--to") + 1], id: "3EB0SENT01" });
if (has("sync")) {
  process.stderr.write(JSON.stringify({ event: "connected", ts: 1 }) + "\n");
  process.stderr.write(JSON.stringify({ event: "error", data: { message: "sync storage limit reached: database size is 3, limit is 2" }, ts: 2 }) + "\n");
  process.exit(1);
}
fail("unexpected command");
`;

describe("spawnWacli", () => {
  const calls = join(dir, "calls.log");
  const bin = join(dir, "wacli");
  writeFileSync(calls, "");
  writeFileSync(bin, FAKE_WACLI.replace("__CALLS__", JSON.stringify(calls)));
  chmodSync(bin, 0o755);
  const wacli = spawnWacli({ bin, store: "/srv/wacli-store", maxDbSize: "1GB" });

  it.skipIf(process.platform === "win32")("reads one stored message and the change journal, a LID chat's move with the new chat only, and tells a lost checkpoint from a failure", async () => {
    expect(await wacli.message(GROUP, "M1")).toEqual({
      chat: GROUP, id: "M1", sender: "15550000101@s.whatsapp.net", senderName: "Client One", at: Date.parse("2026-11-02T08:01:00Z"), fromMe: false, text: "first",
    });
    expect(await wacli.message(GROUP, "GONE")).toBeNull();
    await expect(wacli.message(GROUP, "BROKEN")).rejects.toThrow("wacli messages show: database disk image is malformed");
    expect(await wacli.checkpoint()).toBe("token-now");
    expect(await wacli.changes("token-1", 3)).toEqual({
      changes: [
        { sequence: 3, operation: "upsert", chat: GROUP, id: "M3", at: Date.parse("2026-11-02T08:03:00Z") },
        { sequence: 4, operation: "identity_move", chat: "123456789012345@lid", id: "M4", movedTo: { chat: "15550000101@s.whatsapp.net", id: "M4" }, at: Date.parse("2026-11-02T08:02:00Z") },
        { sequence: 5, operation: "delete", chat: GROUP, id: "M2", at: Date.parse("2026-11-02T08:02:30Z") },
        { sequence: 6, operation: "identity_move", chat: "123456789012345@lid", id: "M5", movedTo: { chat: "15550000101@s.whatsapp.net", id: "M5" }, at: Date.parse("2026-11-02T08:02:40Z") },
      ],
      more: true, next: "token-2",
    });
    const expired = await wacli.changes("expired", 3).catch((error: unknown) => error);
    expect(lostCheckpoint(expired)).toBe(true);
    const busy = await wacli.changes("busy", 3).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(Error);
    expect(lostCheckpoint(busy)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("runs wacli with the store and reads its JSON envelopes", async () => {
    expect(await wacli.account()).toEqual({ authenticated: true, jid: "15550000001@s.whatsapp.net" });
    expect((await wacli.messages(GROUP, 40)).map((message) => message.id)).toEqual(["M1", "M2"]);
    expect(await wacli.sendText(GROUP, "ahoj", "M2")).toBe("3EB0SENT01");
    await expect(wacli.sendText(GROUP, "fail")).rejects.toThrow("wacli send text: not authenticated");
    const recorded = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(recorded.every((args) => args[0] === "--store" && args[1] === "/srv/wacli-store")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reports the follower's events and its exit", async () => {
    const events: FollowerEvent[] = [];
    await new Promise<void>((resolve) => {
      wacli.follow({ url: "http://127.0.0.1:1/events", secret: "s" }, (event) => {
        events.push(event);
        if (event.kind === "exit") resolve();
      });
    });
    expect(events).toEqual([
      { kind: "connected" },
      { kind: "error", message: "sync storage limit reached: database size is 3, limit is 2" },
      { kind: "exit", code: 1 },
    ]);
  });

  it("says when wacli is not installed", async () => {
    await expect(spawnWacli({ bin: join(dir, "missing-wacli"), maxDbSize: "1GB" }).account()).rejects.toThrow(/not installed/);
  });
});
