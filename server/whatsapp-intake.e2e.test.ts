// Lazurio overlay: the WhatsApp intake through the real isolated server. A fake
// `wacli`, handed to the fixture explicitly, stores messages, posts them to the
// intake's loopback webhook signed as wacli signs them (or drops one, as a
// best-effort webhook may), lists and shows them, reads its store as the change
// journal and records what is sent. The bot's turns run on the fake engine
// through the real Claude driver, so the tool log the guards read is the
// server's own. Nothing reaches WhatsApp; every id is synthetic.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import type { RoutineRun } from "./routines.ts";

const OPERATOR = "15550000002@s.whatsapp.net";
const CLIENT = "15550000101@s.whatsapp.net";
const A = "120363000000000001@g.us";
const B = "120363000000000002@g.us";

// CommonJS on purpose: an extensionless file outside any package.json.
const FAKE_WACLI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const STATE = __STATE__;
const args = process.argv.slice(2);
fs.appendFileSync(STATE + "/calls.jsonl", JSON.stringify(args) + "\n");
const value = (flag) => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
const out = (data) => { process.stdout.write(JSON.stringify({ success: true, data, error: null }) + "\n"); process.exit(0); };
const readStore = () => { try { return JSON.parse(fs.readFileSync(STATE + "/store.json", "utf8")); } catch { return []; } };
const writeStore = (rows) => fs.writeFileSync(STATE + "/store.json", JSON.stringify(rows));
if (args.includes("auth")) out({ authenticated: true, linked_jid: "15550000001@s.whatsapp.net", phone: "+15550000001" });
if (args.includes("list")) {
  const rows = readStore().filter((row) => row.ChatJID === value("--chat")).sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp));
  out({ messages: rows.slice(-Number(value("--limit"))).reverse(), fts: false, page: {}, source: {} });
}
if (args.includes("show")) {
  const row = readStore().find((candidate) => candidate.ChatJID === value("--chat") && candidate.MsgID === value("--id"));
  if (row) out(row);
  process.stderr.write(JSON.stringify({ success: false, data: null, error: "sql: no rows in result set" }) + "\n");
  process.exit(1);
}
// The store only grows, so its rows in order are the change journal and a checkpoint is a count of them.
if (args.includes("changes")) {
  const rows = readStore();
  if (args.includes("--checkpoint")) out({ store_id: "e2e", changes: [], has_more: false, next_checkpoint: String(rows.length) });
  const since = Number(value("--since"));
  const page = rows.slice(since, since + Number(value("--limit")));
  out({ store_id: "e2e", has_more: since + page.length < rows.length, next_checkpoint: String(since + page.length), changes: page.map((row, index) => ({
    sequence: since + index + 1, recorded_at: new Date().toISOString(), operation: "upsert", chat_jid: row.ChatJID, msg_id: row.MsgID, message_time: row.Timestamp,
  })) });
}
if (args.includes("send")) {
  const to = value("--to");
  const id = "3EB0SENT" + Date.now();
  fs.appendFileSync(STATE + "/outbox.jsonl", JSON.stringify({ to, message: value("--message"), replyTo: value("--reply-to") ?? null, noPreview: args.includes("--no-preview") }) + "\n");
  writeStore([...readStore(), { ChatJID: to, MsgID: id, SenderJID: "15550000001@s.whatsapp.net", SenderName: "", Timestamp: new Date().toISOString(), FromMe: true, Text: value("--message") }]);
  out({ sent: true, to, id });
}
if (args.includes("sync")) {
  const url = value("--webhook");
  const secret = value("--webhook-secret");
  process.stderr.write(JSON.stringify({ event: "connected", ts: Date.now() }) + "\n");
  let posted = 0;
  setInterval(() => {
    let lines = [];
    try { lines = fs.readFileSync(STATE + "/inbox.jsonl", "utf8").split("\n").filter(Boolean); } catch {}
    for (const line of lines.slice(posted)) {
      posted++;
      const { drop, ...payload } = JSON.parse(line);
      writeStore([...readStore(), { ChatJID: payload.Chat, MsgID: payload.ID, SenderJID: payload.SenderJID, SenderName: payload.PushName, Timestamp: payload.Timestamp,
        FromMe: payload.FromMe, Text: payload.Text, quoted_msg_id: payload.ReplyToID, quoted_sender_jid: payload.ReplyToSenderJID }]);
      if (drop) continue;
      const body = JSON.stringify(payload);
      const request = http.request(url, { method: "POST", headers: { "content-type": "application/json",
        "x-wacli-signature": "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex") } });
      request.on("error", () => {});
      request.end(body);
    }
  }, 100);
  process.on("SIGTERM", () => process.exit(0));
} else {
  process.stderr.write(JSON.stringify({ success: false, data: null, error: "unexpected command" }) + "\n");
  process.exit(1);
}
`;

describe.skipIf(process.platform === "win32")("a server started with OMB_WHATSAPP_INTAKE", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-whatsapp-intake-e2e-"));
  const state = join(dir, "wacli");
  const bundle = join(dir, "bundle");
  const replyFile = join(dir, "reply.json");
  const toolsFile = join(dir, "tools.json");
  let fixture: VerificationServer;
  let count = 0;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const outbox = () => existsSync(join(state, "outbox.jsonl"))
    ? readFileSync(join(state, "outbox.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { to: string; message: string; replyTo: string | null; noPreview: boolean })
    : [];
  /** One WhatsApp message as wacli's follower would see it. */
  const say = (chat: string, text: string, extra: { sender?: string; drop?: boolean; at?: number } = {}) => {
    const id = `3EB0E2E${String(++count).padStart(12, "0")}`;
    const sender = extra.sender ?? CLIENT;
    writeFileSync(join(state, "inbox.jsonl"), `${JSON.stringify({
      Chat: chat, ID: id, SenderJID: sender, Timestamp: new Date(extra.at ?? Date.now()).toISOString(), FromMe: false, Text: text, PushName: sender === CLIENT ? "Client One" : "",
      ReplyToID: "", ReplyToSenderJID: "", Media: null, IsForwarded: false, ReactionToID: "", Revoked: false, Edited: false, PollVote: null, PollAdd: null, Call: null,
      ChatName: "", ...(extra.drop ? { drop: true } : {}),
    })}\n`, { flag: "a" });
    return id;
  };
  const answer = (reply: string, tools: unknown[]) => {
    writeFileSync(replyFile, JSON.stringify({ action: "reply", reply, reply_to: "", commitment: false, confidence: "high", sources: ["guide.md"], digest_line: "" }));
    writeFileSync(toolsFile, JSON.stringify(tools));
  };
  const nextSend = async (sentBefore: number) => {
    await expect.poll(() => outbox().length, { timeout: 60_000, interval: 200 }).toBeGreaterThan(sentBefore);
    return outbox()[sentBefore]!;
  };
  const READ = [{ name: "Read", input: { file_path: join(bundle, "guide.md") } }];
  const CLEAN = "Dobrý den, otevřete Nastavení → Integrace a klikněte na Připojit.";

  beforeAll(async () => {
    mkdirSync(state);
    mkdirSync(bundle);
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(bundle, "guide.md"), "# Integrace\nOtevřete Nastavení → Integrace.\n");
    writeFileSync(join(dir, "notes", "a.md"), "Note of group A: the client uses one Work Environment.");
    writeFileSync(join(dir, "notes", "b.md"), "Note of group B: never shown to group A.");
    writeFileSync(join(dir, "groups.json"), JSON.stringify({
      version: 1,
      team: ["15550000003@s.whatsapp.net"],
      allowedLinks: ["https://github.com/example-provider/handbook"],
      groups: {
        [A]: { key: "a", name: "Group A", mode: "auto", note: "notes/a.md", clientNames: ["Contoso"], owners: ["contoso-labs"] },
        [B]: { key: "b", name: "Group B", mode: "auto", note: "notes/b.md", clientNames: ["Fabrikam"], owners: ["fabrikam-ltd"] },
      },
    }));
    const wacli = join(dir, "wacli-bin");
    writeFileSync(wacli, FAKE_WACLI.replace("__STATE__", JSON.stringify(state)));
    chmodSync(wacli, 0o755);
    answer(CLEAN, READ);
    // The launcher's own intake settings, here a store, stand for a configured Environment's live ones.
    fixture = await launchVerificationServer(
      { ...process.env, OMB_WHATSAPP_INTAKE_STORE: join(dir, "launcher-store"), FAKE_CLAUDE_REPLY_FILE: replyFile, FAKE_CLAUDE_TOOL_CALLS_FILE: toolsFile },
      undefined, undefined, undefined, undefined, undefined, [], undefined, undefined,
      { wacli, bot: "Support", groups: join(dir, "groups.json"), operator: OPERATOR, bundle },
    );
  });

  afterAll(async () => {
    await fixture?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a mention in its group only, drafts what a guard stops, obeys STOP and catches up a dropped message", async () => {
    await expect.poll(async () => (await api("GET", "/api/whatsapp-intake")).body.follower?.state, { timeout: 20_000, interval: 200 }).toBe("connected");
    const created = await api("POST", "/api/bots", { name: "Support", cwd: bundle });
    expect(created.status).toBe(201);

    // A message of another group, then a mention in group A: the run sees group A only.
    say(B, "Group B's own news that group A must never see.");
    const mention = say(A, "@15550000001 Jak připojím Integraci?");
    const sent = await nextSend(0);
    expect(sent).toEqual({ to: A, message: CLEAN, replyTo: mention, noPreview: true });
    const hooks = (await api("GET", "/api/webhooks")).body.webhooks as Array<{ id: string; name: string; botId: string }>;
    const hook = hooks.find((candidate) => candidate.name === "WhatsApp · a")!;
    expect(hook.botId).toBe(created.body.bot.id);
    const run = ((await api("GET", "/api/routines")).body.runs as RoutineRun[]).find((candidate) => candidate.webhookId === hook.id)!;
    const transcript = JSON.stringify(await runControlOmb(["messages", "--bot", created.body.bot.id, "--task", run.threadId!, "--url", fixture.info.url]));
    expect(transcript).toContain("UNTRUSTED WEBHOOK EVENT DATA");
    expect(transcript).toContain("Jak připojím Integraci?");
    expect(transcript).toContain("Note of group A");
    expect(transcript).not.toContain("Group B's own news");
    expect(transcript).not.toContain("Note of group B");
    for (const hidden of ["Contoso", "contoso-labs", A]) expect(transcript).not.toContain(hidden);

    // The cross-client guard and the tool-log guard turn a send into a draft for the operator.
    answer("U Fabrikam to funguje stejně.", READ);
    say(A, "@15550000001 Jak to mají ostatní?");
    expect(await nextSend(1)).toMatchObject({ to: OPERATOR, message: expect.stringContaining("zmiňuje jinou skupinu nebo klienta") });
    answer(CLEAN, [{ name: "Bash", input: { command: "gh repo list some-client" } }]);
    say(A, "@15550000001 A repozitáře?");
    expect(await nextSend(2)).toMatchObject({ to: OPERATOR, message: expect.stringContaining("běh použil gh") });
    // A link in the bundle to another group's note is read where it leads.
    symlinkSync(join(dir, "notes", "b.md"), join(bundle, "faq.md"));
    answer(CLEAN, [{ name: "Read", input: { file_path: join(bundle, "faq.md") } }]);
    say(A, "@15550000001 Co říká FAQ?");
    expect(await nextSend(3)).toMatchObject({ to: OPERATOR, message: expect.stringContaining("běh četl mimo podklady") });

    // STOP from the operator's chat pauses sending; START resumes it.
    answer(CLEAN, READ);
    const stop = say(OPERATOR, "STOP", { sender: OPERATOR });
    expect(await nextSend(4)).toMatchObject({ to: OPERATOR, message: expect.stringContaining("pozastavené") });
    say(A, "@15550000001 Ještě jednou?");
    expect(await nextSend(5)).toMatchObject({ to: OPERATOR, message: expect.stringContaining("odesílání je pozastavené (STOP)") });
    const start = say(OPERATOR, "START", { sender: OPERATOR });
    expect(await nextSend(6)).toMatchObject({ to: OPERATOR, message: expect.stringContaining("obnovené") });

    // The webhook drops a mention and delivers a later message; the catch-up still finds the mention and the bot answers it.
    const dropped = say(A, "@15550000001 Ztracená otázka?", { drop: true, at: Date.now() - 5_000 });
    say(A, "Mezitím ještě jedna zpráva.");
    const batch = async () => ((await api("GET", "/api/whatsapp-intake")).body.groups as Array<{ key: string; batch: number }>).find((group) => group.key === "a")?.batch;
    await expect.poll(batch, { timeout: 10_000, interval: 200 }).toBe(1);
    expect(readFileSync(join(state, "store.json"), "utf8")).toContain(dropped);
    const caught = await api("POST", "/api/whatsapp-intake/catch-up");
    expect(caught.status).toBe(200);
    expect(caught.body.summary.messages).toBeGreaterThanOrEqual(1);
    expect(await nextSend(7)).toEqual({ to: A, message: CLEAN, replyTo: dropped, noPreview: true });

    const status = (await api("GET", "/api/whatsapp-intake")).body;
    expect(status).toMatchObject({ enabled: true, state: "ok", account: "15550000001@s.whatsapp.net", bot: { name: "Support" }, stopped: { all: false, groups: [] } });
    expect(status.recent.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining(["sent", "draft", "command", "run"]));
    expect(outbox().every((entry) => entry.to === A || entry.to === OPERATOR)).toBe(true);

    // Ids, times and actions only: no message text in the intake's state or the server log.
    const intakeState = readFileSync(join(fixture.info.dataDir, "whatsapp-intake.json"), "utf8");
    const log = readFileSync(fixture.info.logPath, "utf8");
    for (const text of ["Jak připojím Integraci", "Ztracená otázka", "Group B's own news"]) {
      expect(intakeState).not.toContain(text);
      expect(log).not.toContain(text);
    }
    expect(log).toContain("[whatsapp-intake] a: reply sent");

    const calls = readFileSync(join(state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    // The catch-up read wacli's journal from the checkpoint it took at start. It fetched the message it had not seen, and
    // the operator's commands once more, as it reads every change to the operator's messages, since one may be an edit:
    // never a group message delivered live, nor its own sends.
    const anchored = calls.findIndex((args) => args.includes("--checkpoint"));
    expect(anchored).toBeGreaterThanOrEqual(0);
    expect(anchored).toBeLessThan(calls.findIndex((args) => args.includes("sync")));
    expect(calls.some((args) => args.includes("changes") && args.includes("--since"))).toBe(true);
    expect(calls.filter((args) => args.includes("show")).map((args) => args[args.indexOf("--id") + 1])).toEqual([stop, start, dropped]);
    // The launcher's store never reached the fixture's wacli.
    expect(calls.some((args) => args.includes("send"))).toBe(true);
    expect(calls.filter((args) => args.includes("--store"))).toEqual([]);
  }, 240_000);
});
