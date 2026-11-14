import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const dir = mkdtempSync(join(tmpdir(), "mausbot-fake-t3-"));
const cli = join(dir, "fake-t3");
const state = join(dir, "state.json");
writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(state)};
let state = {threads: [], launches: 0}; try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
let result = {};
if (args[0] === 'lazurio') result = {agentCli: true};
if (args[0] === 'thread' && args[1] === 'list') result = {threads: state.threads.filter(t => t.title.includes(args[args.indexOf('--title')+1]))};
if (args[0] === 'thread' && args[1] === 'launch') {
  const thread = {threadId: 'fixture-t3-' + (++state.launches), title: args[args.indexOf('--title')+1], link: '<t3-thread://fixture/thread>'};
  state.threads.push(thread); state.prompt = fs.readFileSync(args[args.indexOf('--message-file')+1], 'utf8'); result = {thread};
}
if (args[0] === 'thread' && args[1] === 'read') result = {thread: {status: 'waiting', archived: false}};
if (args[0] === 'request') result = {requests: []};
fs.writeFileSync(file, JSON.stringify(state)); console.log(JSON.stringify(result));
`, { mode: 0o700 });

describe("a bot's person question through the real HTTP routes", () => {
  let fixture: VerificationServer;
  const key = "isolated-person-question-capability";
  let bot: { id: string; threadId: string };
  let token: string;
  let questionId: string;
  const headers = { "content-type": "application/json", "x-openmausbot-cli": "1" };
  const call = async (path: string, body?: unknown, auth = false) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...(auth ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  beforeAll(async () => {
    fixture = await launchVerificationServer({ FAKE_T3_CLI: cli, OMB_TEST_ENVIRONMENT_BROWSER: "1", OMB_TEST_INTERNAL_CAPABILITY_KEY: key });
    bot = (await call("/api/bots", { name: "Release fixture" })).body.bot;
    const minted = await fetch(`${fixture.info.url}/api/testing/internal-capability`, { method: "POST", headers: { ...headers, "x-openmausbot-test-capability": key }, body: JSON.stringify({ botId: bot.id, threadId: bot.threadId }) });
    token = (await minted.json() as { token: string }).token;
  }, 60_000);
  afterAll(async () => { await fixture?.close(); rmSync(dir, { recursive: true, force: true }); });

  const question = { question_id: "release-choice", question: "Which fixture version?", options: ["Wait (Recommended)", "Continue"], meanwhile: "Continue tests. Publishing waits.", link: "https://github.com/example/repository/issues/1" };

  it("requires a capability, validates the contract and launches exactly one chat for retries", async () => {
    expect((await call("/api/internal/person-questions", question)).status).not.toBe(200);
    expect((await call("/api/internal/person-questions", { ...question, options: ["Only one"] }, true)).status).toBe(400);
    const opened = await call("/api/internal/person-questions", question, true);
    expect(opened.status).toBe(200);
    questionId = opened.body.questionId;
    expect(opened.body).toMatchObject({ threadId: "fixture-t3-1", link: "<t3-thread://fixture/thread>" });
    expect((await call("/api/internal/person-questions", question, true)).body.questionId).toBe(questionId);
    const t3 = JSON.parse(readFileSync(state, "utf8"));
    expect(t3.launches).toBe(1);
    expect(t3.prompt).toContain("question tool");
    expect(t3.prompt).toContain(question.meanwhile);
    expect(t3.prompt).toContain(question.link);
    const messages = (await call(`/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.filter((message: any) => message.card?.requestId === "person-release-choice")).toHaveLength(1);
  });

  it("returns a free text answer to the bot and settles the source card, refusing a later answer", async () => {
    const answer = 'Wait until the next version.\n\nLiteral: `echo nope` $(nope) " Č';
    const reply = await call(`/api/person-questions/${questionId}/answer`, { answer });
    expect(reply).toMatchObject({ status: 200, body: { status: "delivered", questionId, source: "t3" } });
    const repeated = await call(`/api/person-questions/${questionId}/answer`, { answer: "Another choice" });
    expect(repeated.body.status).toBe("already-answered");
    await expect.poll(async () => (await call(`/api/threads/${bot.threadId}/messages`)).body.messages.some((message: any) => message.text?.includes(answer)), { timeout: 15_000 }).toBe(true);
    const messages = (await call(`/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.find((message: any) => message.card?.requestId === "person-release-choice").card).toMatchObject({ answered: "answer", answeredText: answer });
    const receipt = JSON.parse(readFileSync(join(fixture.info.dataDir, "person-questions", `${questionId}.json`), "utf8"));
    expect(receipt).toMatchObject({ answer, delivered: true, t3ThreadId: "fixture-t3-1" });
  });
});
