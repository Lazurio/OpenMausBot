import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonQuestions, personQuestionId, type PersonQuestionDeps } from "./lazurio-person-questions.ts";
import { PersonQuestionCli } from "./lazurio-person-question-cli.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const input = { botId: "bot", botName: "Release", threadId: "source", requestId: "request", instanceId: "codex", question: "Choose a version. Options: wait, continue. Default: wait on publishing; continue tests. https://github.com/example/repo/issues/1" };
function fixture(overrides: Partial<PersonQuestionDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "person-question-")); dirs.push(dataDir);
  const cli = { available: vi.fn(async () => {}), find: vi.fn(async () => undefined as { threadId: string; link: string } | undefined), launch: vi.fn(async () => ({ threadId: "t3", link: "<t3-thread://test/t3>" })), state: vi.fn(async () => ({ status: "waiting", archived: false })), notify: vi.fn(async () => {}) };
  const deps = { dataDir, port: 1234, cli: cli as unknown as PersonQuestionCli, nativeAnswer: vi.fn(async () => true), lateAnswer: vi.fn(async () => {}), notice: vi.fn(), ...overrides };
  return { deps, cli, questions: new PersonQuestions(deps) };
}

describe("native bot questions delivered to a T3 chat", () => {
  it("launches once for simultaneous duplicate events and keeps the receipt on restart", async () => {
    const f = fixture();
    const receipts = await Promise.all([f.questions.open(input), f.questions.open(input)]);
    expect(f.cli.launch).toHaveBeenCalledTimes(1);
    expect(receipts[0]).toMatchObject({ id: personQuestionId("source", "request"), t3ThreadId: "t3" });
    const restarted = new PersonQuestions(f.deps);
    await restarted.open(input);
    expect(f.cli.launch).toHaveBeenCalledTimes(1);
    expect(f.cli.launch.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining(input.question)]));
  });

  it("keeps missing T3 visible and retains the original question without an attempted launch", async () => {
    const f = fixture(); f.cli.available.mockRejectedValue(new Error("missing CLI"));
    const receipt = await f.questions.open(input);
    expect(receipt).toMatchObject({ error: "ask-person-unavailable", question: input.question, attempted: false });
    expect(f.deps.notice).toHaveBeenCalledWith(expect.anything(), "ask-person-unavailable");
    expect(f.cli.launch).not.toHaveBeenCalled();
    f.cli.available.mockResolvedValue();
    await f.questions.reconcile();
    expect(f.cli.launch).toHaveBeenCalledTimes(1);
  });

  it("reconciles an interrupted launch without a second chat; unknown delivery stays ambiguous", async () => {
    const f = fixture(); f.cli.launch.mockRejectedValue(new Error("response lost"));
    const receipt = await f.questions.open(input);
    expect(receipt.attempted).toBe(true);
    const restarted = new PersonQuestions(f.deps);
    await restarted.reconcile();
    expect(restarted.get(receipt.id)?.error).toBe("ask-person-launch-ambiguous");
    expect(f.cli.launch).toHaveBeenCalledTimes(1);
    f.cli.find.mockResolvedValue({ threadId: "accepted", link: "<t3-thread://test/accepted>" });
    await restarted.reconcile();
    expect(restarted.get(receipt.id)?.t3ThreadId).toBe("accepted");
    expect(f.cli.launch).toHaveBeenCalledTimes(1);
  });

  it("first answer wins across both channels and free text survives byte for byte", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    const answer = 'Keep the old version\n\n`touch nope` $(echo nope) " \\ Č';
    const results = await Promise.all([f.questions.answer(receipt.id, answer, "t3"), f.questions.answer(receipt.id, "Different", "mausbot")]);
    expect(results.map((result) => result.status)).toEqual(["delivered", "already-answered"]);
    expect(f.deps.nativeAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: receipt.id }), answer);
    expect(new PersonQuestions(f.deps).get(receipt.id)?.answer).toBe(answer);
    await f.questions.answer(receipt.id, answer, "t3");
    expect(f.deps.nativeAnswer).toHaveBeenCalledTimes(1);
  });

  it("tells T3 when the person answered in MausBot", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    await f.questions.answer(receipt.id, "Wait", "mausbot");
    expect(f.cli.notify).toHaveBeenCalledExactlyOnceWith("t3", receipt.id, "Wait");
    expect((await f.questions.answer(receipt.id, "Continue", "t3")).status).toBe("already-answered");
  });

  it("retries a failed notification after restart without delivering the bot’s answer twice", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    f.cli.notify.mockRejectedValueOnce(new Error("offline T3"));
    const result = await f.questions.answer(receipt.id, "Wait", "mausbot");
    expect(result.status).toBe("delivered");
    expect(result.receipt.error).toBe("ask-person-delivery-failed");
    const restarted = new PersonQuestions(f.deps);
    await restarted.reconcile();
    expect(f.deps.nativeAnswer).toHaveBeenCalledTimes(1);
    expect(f.cli.notify).toHaveBeenCalledTimes(2);
    expect(restarted.get(receipt.id)).toMatchObject({ delivered: true, notified: true });
    expect(restarted.get(receipt.id)?.error).toBeUndefined();
  });

  it("delivers a late answer as a new message carrying the question id", async () => {
    const f = fixture({ nativeAnswer: vi.fn(async () => false) }); const receipt = await f.questions.open(input);
    await f.questions.answer(receipt.id, "Later\nanswer", "t3");
    expect(f.deps.lateAnswer).toHaveBeenCalledExactlyOnceWith(expect.anything(), `Answer to question ${receipt.id} (t3):\nLater\nanswer`, `person-question-${receipt.id}`);
  });

  it("persists a delivery failure and retries the same first answer after restart", async () => {
    const lateAnswer = vi.fn().mockRejectedValueOnce(new Error("bot deleted" )).mockResolvedValue(undefined);
    const f = fixture({ nativeAnswer: vi.fn(async () => false), lateAnswer }); const receipt = await f.questions.open(input);
    expect((await f.questions.answer(receipt.id, "Wait", "t3")).status).toBe("pending");
    const restarted = new PersonQuestions(f.deps);
    expect(restarted.get(receipt.id)).toMatchObject({ answer: "Wait", error: "ask-person-delivery-failed" });
    await restarted.reconcile();
    expect(restarted.get(receipt.id)?.delivered).toBe(true);
    expect(lateAnswer).toHaveBeenCalledTimes(2);
    expect(lateAnswer.mock.calls[0]![2]).toBe(lateAnswer.mock.calls[1]![2]);
  });

  it("an archived chat is still an open question, reported once, never a default answer", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    f.cli.state.mockResolvedValue({ status: "completed", archived: true });
    await f.questions.reconcile(); await f.questions.reconcile();
    expect(f.questions.get(receipt.id)).toMatchObject({ error: "ask-person-still-open" });
    expect(f.questions.get(receipt.id)?.answer).toBeUndefined();
    expect(f.deps.notice).toHaveBeenCalledTimes(1);
    expect(f.deps.nativeAnswer).not.toHaveBeenCalled();
  });

  it("does not launch when intent cannot be durably recorded", async () => {
    const f = fixture(); const id = personQuestionId(input.threadId, input.requestId);
    rmSync(join(f.deps.dataDir, "person-questions"), { recursive: true });
    writeFileSync(join(f.deps.dataDir, "person-questions"), "blocked");
    await expect(f.questions.open(input)).rejects.toThrow();
    expect(f.cli.launch).not.toHaveBeenCalled();
    expect(f.questions.get(id)).toBeUndefined();
  });
});

it("uses the existing T3 capability and question CLI without a shell or permission approval", async () => {
  const call = vi.fn(async (args: string[]) => {
    if (args[0] === "lazurio") return { agentCli: true };
    if (args[0] === "request" && args[1] === "list") return { requests: [{ type: "approval", requestId: "permission" }, { type: "question", requestId: "question", questions: [{ id: "q" }] }] };
    return { threads: [] };
  });
  const cli = new PersonQuestionCli(call);
  await cli.available();
  await cli.notify("thread", "id", "Wait\n$(nope)");
  expect(call).toHaveBeenCalledWith(["request", "respond", "question", "--thread", "thread", "--answers", JSON.stringify({ q: "Wait\n$(nope)" }), "--json"]);
  expect(call.mock.calls.some(([args]) => args.includes("approve"))).toBe(false);
});
