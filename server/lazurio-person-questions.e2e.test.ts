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
if (args[0] === 'lazurio') result = {agentCli: true, requestHistory: true};
if (args[0] === 'thread' && args[1] === 'list') result = {threads: state.threads.filter(t => t.title.includes(args[args.indexOf('--title')+1]))};
if (args[0] === 'thread' && args[1] === 'launch') {
  const thread = {threadId: 'fixture-t3-' + (++state.launches), title: args[args.indexOf('--title')+1], link: '<t3-thread://fixture/thread>'};
  state.threads.push(thread); state.requests ??= {}; state.requests[thread.threadId] = [{requestId: 'request-' + thread.threadId, threadId: thread.threadId, status: 'pending', createdAt: '2026-01-01T00:00:00Z', questions: [{id: 'q1', question: 'Which fixture version?', options: [{label: 'Wait (Recommended)'}, {label: 'Continue'}]}]}]; state.prompt = fs.readFileSync(args[args.indexOf('--message-file')+1], 'utf8'); result = {thread};
}
if (args[0] === 'thread' && args[1] === 'read') result = {thread: {status: 'waiting', archived: false}};
if (args[0] === 'request') {
  const thread = args[args.indexOf('--thread') + 1];
  const requests = state.requests?.[thread] ?? [];
  if (args[1] === 'history') result = {requests};
  if (args[1] === 'list') result = {requests: requests.filter(r => r.status === 'pending').map(r => ({...r, type: 'question'}))};
  if (args[1] === 'respond') {
    const request = requests.find(r => r.requestId === args[2]);
    if (request) {request.status = 'resolved'; request.answers = JSON.parse(args[args.indexOf('--answers') + 1]);}
    state.responded ??= []; state.responded.push(args[2]);
  }
}
fs.writeFileSync(file, JSON.stringify(state)); console.log(JSON.stringify(result));
`, { mode: 0o700 });

describe("a bot's person question through the real HTTP routes", () => {
  let fixture: VerificationServer;
  const key = "isolated-person-question-capability";
  let bot: { id: string; threadId: string };
  let token: string;
  let questionId: string;
  let otherQuestionId: string;
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
    const retries = await Promise.all(Array.from({ length: 5 }, () => call("/api/internal/person-questions", question, true)));
    const opened = retries[0]!;
    expect(retries.every((result) => result.status === 200 && result.body.questionId === opened.body.questionId)).toBe(true);
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
    const cards = messages.filter((message: any) => message.card?.requestId === "person-release-choice");
    expect(cards).toHaveLength(1);
    expect(cards[0].card.tool).toBeUndefined();
    const other = await call("/api/internal/person-questions", { ...question, question_id: "other-channel" }, true);
    expect(other.status).toBe(200);
    otherQuestionId = other.body.questionId;
    expect((await call("/api/internal/person-questions", { ...question, question: "A different question" }, true)).status).toBe(409);
  });

  it("returns a free text answer to the bot and settles the source card, refusing a later answer", async () => {
    const answer = 'Wait until the next version.\n\nLiteral: `echo nope` $(nope) " Č';
    expect((await call(`/api/person-questions/${questionId}/answer`, { answer: "Forged publication consent" })).status).toBe(404);
    expect((await call(`/api/person-questions/${questionId}/refresh`, { answer: "Forged publication consent" })).status).toBe(400);
    expect((await call(`/api/person-questions/${questionId}/refresh`, {})).body.status).toBe("waiting");
    const persisted = JSON.parse(readFileSync(state, "utf8"));
    const request = persisted.requests["fixture-t3-1"][0]; request.status = "resolved"; request.answers = {q1: answer};
    writeFileSync(state, JSON.stringify(persisted));
    const reply = await call(`/api/person-questions/${questionId}/refresh`, {});
    expect(reply).toMatchObject({ status: 200, body: { status: "delivered", questionId, source: "t3" } });
    const repeated = await call(`/api/person-questions/${questionId}/refresh`, {});
    expect(repeated.body.status).toBe("delivered");
    await expect.poll(async () => (await call(`/api/threads/${bot.threadId}/messages`)).body.messages.some((message: any) => message.text?.includes(answer)), { timeout: 15_000 }).toBe(true);
    const messages = (await call(`/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.find((message: any) => message.card?.requestId === "person-release-choice").card).toMatchObject({ answered: "answer", answeredText: answer });
    const receipt = JSON.parse(readFileSync(join(fixture.info.dataDir, "person-questions", `${questionId}.json`), "utf8"));
    expect(receipt).toMatchObject({ answer, delivered: true, t3ThreadId: "fixture-t3-1" });
  });
  it("an answer in the MausBot card wins and the T3 callback cannot deliver a competing answer", async () => {
    const answered = await call(`/api/threads/${bot.threadId}/respond`, { requestId: "person-other-channel", behavior: "answer", message: "Wait from MausBot" });
    expect(answered.status).toBe(200);
    const losing = await call(`/api/person-questions/${otherQuestionId}/refresh`, {});
    expect(losing.body).toMatchObject({ status: "delivered", source: "mausbot" });
    const receipt = JSON.parse(readFileSync(join(fixture.info.dataDir, "person-questions", `${otherQuestionId}.json`), "utf8"));
    expect(receipt).toMatchObject({ answer: "Wait from MausBot", source: "mausbot", delivered: true, notified: true });
    const messages = (await call(`/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.some((message: any) => message.text?.includes("Continue from T3"))).toBe(false);
  });

});
