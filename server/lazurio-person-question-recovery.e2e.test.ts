import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { PersonQuestions, type PersonQuestionReplyContext } from "./lazurio-person-questions.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("a real server restart recovers a failed late answer with its accepted sender and call attribution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "person-question-recovery-"));
  const cli = join(dir, "unavailable-t3");
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({agentCli:false}));\n`, { mode: 0o700 });
  const key = "fixture-question-recovery";
  const parentEnv = { FAKE_T3_CLI: cli, OMB_TEST_ENVIRONMENT_BROWSER: "1", OMB_TEST_INTERNAL_CAPABILITY_KEY: key };
  const fixture = await launchVerificationServer(parentEnv);
  let restarted: ChildProcess | undefined;
  const api = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = (await api("/api/bots", { name: "Recovery fixture" })).body.bot;
    const minted = await fetch(`${fixture.info.url}/api/testing/internal-capability`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
      body: JSON.stringify({ botId: bot.id, threadId: bot.threadId }),
    });
    const internalToken = (await minted.json() as { token: string }).token;
    const open = (question_id: string) => api("/api/internal/person-questions", {
      question_id, question: "Which fixture version?", options: ["Wait", "Continue"],
      meanwhile: "Continue independent tests.", link: "https://github.com/example/repo/issues/1",
    }, internalToken);
    const first = await open("accepted-context");
    const pending = await open("interrupted-context");
    expect(first.status).toBe(503);
    expect(pending.status).toBe(503);
    const pairing = await api("/api/auth/pairing", {});
    const paired = await api("/api/auth/pair", { code: pairing.body.code });
    expect(paired.status).toBe(200);
    const sessionToken = paired.body.token as string;
    expect((await api(`/api/threads/${bot.threadId}/respond`, {
      requestId: "person-accepted-context", behavior: "answer", message: "Wait",
      replyContext: { sender: { name: "Forged body identity" }, via: "call", callId: "forged-call", auth: { token: "not-to-be-saved" } },
    }, sessionToken)).status).toBe(200);
    const receiptFile = (id: string) => join(fixture.info.dataDir, "person-questions", `${id}.json`);
    const accepted = JSON.parse(readFileSync(receiptFile(first.body.questionId), "utf8"));
    const context = accepted.replyContext as PersonQuestionReplyContext;
    expect(context).toMatchObject({ sender: { id: expect.stringMatching(/^p_/) }, trigger: { kind: "user" }, answerer: { kind: "session" } });
    expect(context.sender?.name).not.toBe("Forged body identity");
    expect(context).not.toHaveProperty("via");
    expect(context).not.toHaveProperty("callId");
    expect(JSON.stringify(context)).not.toContain(sessionToken);
    expect(JSON.stringify(context)).not.toMatch(/tokenHash|not-to-be-saved/);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // Fault at the relay's delivery dependency, with the same source card and on-disk receipt as the server.
    const failed = new PersonQuestions({ dataDir: fixture.info.dataDir,
      nativeAnswer: async () => "unavailable", lateAnswer: async () => { throw new Error("fixture delivery interrupted"); }, notice: () => {},
    });
    const spokenContext = { ...context, via: "call" as const, callId: "fixture-recovered-call" };
    expect((await failed.answer(pending.body.questionId, "Recovered answer", spokenContext)).status).toBe("pending");
    expect(JSON.parse(readFileSync(receiptFile(pending.body.questionId), "utf8"))).toMatchObject({
      answer: "Recovered answer", replyContext: spokenContext, error: "ask-person-delivery-failed",
    });
    const env = verificationServerEnvironment(parentEnv, fixture.info.dataDir, Number(new URL(fixture.info.url).port));
    restarted = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env, stdio: "ignore",
    });
    await expect.poll(async () => {
      try { return (await api("/api/health")).status; } catch { return 0; }
    }, { timeout: 20_000 }).toBe(200);
    const messages = async () => (await api(`/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).find((message) => message.text === "Recovered answer"), { timeout: 15_000 }).toMatchObject({
      sender: context.sender, via: "call", callId: "fixture-recovered-call", replyToId: expect.any(String),
    });
    expect((await messages()).find((message) => message.card?.requestId === "person-interrupted-context")?.card).toMatchObject({
      answered: "answer", answeredText: "Recovered answer", answeredBy: { ...context.answerer, via: "call" },
    });
    expect((await api(`/api/person-questions/${pending.body.questionId}/refresh`, {})).body.status).toBe("delivered");
    expect((await messages()).filter((message) => message.text === "Recovered answer")).toHaveLength(1);
    const recovered = readFileSync(receiptFile(pending.body.questionId), "utf8");
    expect(JSON.parse(recovered)).toMatchObject({ delivered: true, replyContext: spokenContext });
    expect(recovered).not.toContain(sessionToken);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
