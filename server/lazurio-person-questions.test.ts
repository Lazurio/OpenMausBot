import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonQuestions, personQuestionId, type PersonQuestionDeps } from "./lazurio-person-questions.ts";
import { PersonQuestionCli, type T3Question } from "./lazurio-person-question-cli.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const input = { botId: "bot", botName: "Release", threadId: "source", requestId: "request", instanceId: "codex", question: "Choose a version. Options: wait, continue. Default: wait on publishing; continue tests. https://github.com/example/repo/issues/1" };
function fixture(overrides: Partial<PersonQuestionDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "person-question-")); dirs.push(dataDir);
  const cli = { available: vi.fn(async () => {}), find: vi.fn(async () => undefined as { threadId: string; link: string } | undefined), launch: vi.fn(async () => ({ threadId: "t3", link: "<t3-thread://test/t3>" })), state: vi.fn(async () => ({ status: "waiting", archived: false })), history: vi.fn<() => Promise<T3Question[]>>(async () => [{ requestId: "t3-question", threadId: "t3", status: "pending", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }] }]), notify: vi.fn(async () => {}) };
  const respond = vi.fn(async (_thread: string, _request: string, answer: string) => {
    cli.history.mockResolvedValue([{ requestId: "t3-question", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }], answers: { q: answer } }]);
    return true;
  });
  Object.assign(cli, { respond });
  const deps = { dataDir, cli: cli as unknown as PersonQuestionCli, nativeAnswer: vi.fn(async () => "answered" as const), lateAnswer: vi.fn(async () => {}), notice: vi.fn(), ...overrides };
  const questions = new PersonQuestions(deps);
  const replyT3 = async (id: string, answer: string) => {
    cli.history.mockResolvedValue([{ requestId: "t3-question", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }], answers: { q: answer } }]);
    return questions.refresh(id);
  };
  return { deps, cli, questions, replyT3, respond };
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
    const results = await Promise.all([f.replyT3(receipt.id, answer), f.questions.answer(receipt.id, "Different")]);
    expect(results.map((result) => result.status)).toEqual(["delivered", "already-answered"]);
    expect(f.deps.nativeAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: receipt.id }), answer);
    expect(new PersonQuestions(f.deps).get(receipt.id)?.answer).toBe(answer);
    await f.replyT3(receipt.id, answer);
    expect(f.deps.nativeAnswer).toHaveBeenCalledTimes(1);
  });

  it("tells T3 when the person answered in MausBot", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    await f.questions.answer(receipt.id, "Wait");
    expect(f.cli.notify).toHaveBeenCalledExactlyOnceWith("t3", receipt.id, "Wait", "t3-question");
    expect((await f.replyT3(receipt.id, "Continue")).receipt).toMatchObject({ source: "mausbot", answer: "Wait" });
  });

  it("retries a failed notification after restart without delivering the bot’s answer twice", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    f.cli.notify.mockRejectedValueOnce(new Error("offline T3"));
    const result = await f.questions.answer(receipt.id, "Wait");
    expect(result.status).toBe("delivered");
    expect(result.receipt.error).toBe("ask-person-delivery-failed");
    const restarted = new PersonQuestions(f.deps);
    await restarted.reconcile();
    expect(f.deps.nativeAnswer).toHaveBeenCalledTimes(1);
    expect(f.cli.notify).toHaveBeenCalledTimes(2);
    expect(restarted.get(receipt.id)).toMatchObject({ delivered: true, notified: true });
    expect(restarted.get(receipt.id)?.error).toBeUndefined();
  });

  it("a rejected native answer is never retried or delivered as a late message", async () => {
    const f = fixture({ nativeAnswer: vi.fn(async () => "rejected" as const) }); const receipt = await f.questions.open(input);
    expect((await f.replyT3(receipt.id, "Unsupported free text")).status).toBe("rejected");
    expect(f.questions.get(receipt.id)).toMatchObject({ nativeRejected: true, error: "ask-person-answer-rejected" });
    await f.questions.reconcile();
    await new PersonQuestions(f.deps).reconcile();
    expect(f.deps.lateAnswer).not.toHaveBeenCalled();
    expect(f.deps.nativeAnswer).toHaveBeenCalledTimes(1);
    expect(f.questions.get(receipt.id)?.delivered).not.toBe(true);
  });

  it("reads the first bound T3 request's persisted answer and ignores a later question", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    await f.questions.refresh(receipt.id);
    const original: T3Question = { requestId: "t3-question", threadId: "t3", status: "pending", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }] };
    const later: T3Question = { ...original, requestId: "unrelated", status: "resolved", questions: [{ id: "q", question: "Another decision?" }], answers: { q: "Publish something else" } };
    f.cli.history.mockResolvedValue([original, later]);
    await f.questions.refresh(receipt.id);
    expect(f.deps.nativeAnswer).not.toHaveBeenCalled();
    f.cli.history.mockResolvedValue([{ ...original, status: "resolved", answers: { q: "Wait\nexactly" } }, later]);
    expect((await f.questions.refresh(receipt.id)).status).toBe("delivered");
    expect(f.questions.get(receipt.id)).toMatchObject({ t3RequestId: "t3-question", answer: "Wait\nexactly", source: "t3" });
  });

  it("does not bind an unrelated question even before the relay question opens", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    f.cli.history.mockResolvedValue([{ requestId: "unrelated", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: "Deploy another project?" }], answers: { q: "Yes" } }]);
    await f.questions.refresh(receipt.id);
    expect(f.questions.get(receipt.id)).toMatchObject({ error: "ask-person-question-mismatch" });
    expect(f.questions.get(receipt.id)?.t3RequestId).toBeUndefined();
    expect(f.deps.nativeAnswer).not.toHaveBeenCalled();
  });

  it("does not bind identical question text with different choices", async () => {
    const f = fixture(); const receipt = await f.questions.open({ ...input, questions: [{ question: input.question, options: [{ label: "Wait" }, { label: "Cancel" }] }] });
    f.cli.history.mockResolvedValue([{ requestId: "unrelated", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question, options: [{ label: "Publish" }, { label: "Cancel" }] }], answers: { q: "Publish" } }]);
    await f.questions.refresh(receipt.id);
    expect(f.questions.get(receipt.id)?.t3RequestId).toBeUndefined();
    expect(f.deps.nativeAnswer).not.toHaveBeenCalled();
  });

  it("does not treat a closed T3 request without an accepted answer as a person's decision", async () => {
    const f = fixture(); const receipt = await f.questions.open(input);
    f.cli.history.mockResolvedValue([{ requestId: "closed", threadId: "t3", status: "cancelled", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }] }]);
    await f.questions.refresh(receipt.id);
    expect(f.questions.get(receipt.id)).toMatchObject({ t3RequestId: "closed", error: "ask-person-still-open" });
    expect(f.questions.get(receipt.id)?.answer).toBeUndefined();
    expect(f.deps.nativeAnswer).not.toHaveBeenCalled();
  });

  it("delivers a late answer as a new message carrying the question id", async () => {
    const f = fixture({ nativeAnswer: vi.fn(async () => "unavailable" as const) }); const receipt = await f.questions.open(input);
    await f.replyT3(receipt.id, "Later\nanswer");
    expect(f.deps.lateAnswer).toHaveBeenCalledExactlyOnceWith(expect.anything(), `Answer to question ${receipt.id} (t3):\nLater\nanswer`, `person-question-${receipt.id}`);
    expect(new PersonQuestions(f.deps).get(receipt.id)).toMatchObject({ delivered: true, late: true, queued: false });
  });

  it("persists a delivery failure and retries the same first answer after restart", async () => {
    const lateAnswer = vi.fn().mockRejectedValueOnce(new Error("bot deleted" )).mockResolvedValue(undefined);
    const f = fixture({ nativeAnswer: vi.fn(async () => "unavailable" as const), lateAnswer }); const receipt = await f.questions.open(input);
    expect((await f.replyT3(receipt.id, "Wait")).status).toBe("pending");
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
    if (args[0] === "lazurio") return { agentCli: true, requestHistory: true };
    if (args[0] === "request" && args[1] === "list") return { requests: [{ type: "approval", requestId: "permission" }, { type: "question", requestId: "question", questions: [{ id: "q", question: "Continue?", options: [] }] }, { type: "question", requestId: "unrelated", questions: [{ id: "later" }] }] };
    return { threads: [] };
  });
  const cli = new PersonQuestionCli(call);
  await cli.available();
  await cli.notify("thread", "id", "Wait\n$(nope)", "question");
  expect(call).toHaveBeenCalledWith(["request", "respond", "question", "--thread", "thread", "--answers", JSON.stringify({ q: "Wait\n$(nope)" }), "--json"]);
  expect(call.mock.calls.some(([args]) => args.includes("approve"))).toBe(false);
  expect(call.mock.calls.some(([args]) => args[1] === "respond" && args[2] === "unrelated")).toBe(false);
});

it("an older agent CLI without persisted question history is unavailable to the relay", async () => {
  const cli = new PersonQuestionCli(async () => ({ agentCli: true }));
  await expect(cli.available()).rejects.toThrow("ask-person-unavailable");
});


it("maps persisted T3 option values to labels and preserves free text", async () => {
  const f = fixture();
  const receipt = await f.questions.open({ ...input, questions: [{ question: input.question, options: [{ label: "Wait" }, { label: "Cancel" }], multiSelect: true }] });
  f.cli.history.mockResolvedValue([{ requestId: "t3-question", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question, options: [{ label: "Wait", value: "" }, { label: "Cancel", value: "1" }], multiSelect: true }], answers: { q: ["", "own words\nverbatim"] } }]);
  await f.questions.refresh(receipt.id);
  expect(f.questions.get(receipt.id)?.answer).toBe("Wait, own words\nverbatim");
});

it("maps each MausBot answer to its T3 question and provider option value", async () => {
  const call = vi.fn(async (_args: string[]) => ({ requests: [{ type: "question", requestId: "bound", questions: [{ id: "one", question: "First?", options: [{ label: "Wait", value: "0" }] }, { id: "two", question: "Second?", options: [] }] }] }));
  const cli = new PersonQuestionCli(call);
  await cli.notify("thread", "id", "The user answered your questions.\n\nQ: First?\nA: Wait\n\nQ: Second?\nA: own words", "bound");
  expect(call).toHaveBeenCalledWith(["request", "respond", "bound", "--thread", "thread", "--answers", JSON.stringify({ one: "0", two: "own words" }), "--json"]);
  call.mockClear();
  await cli.notify("thread", "id", "ambiguous answer", "bound");
  expect(call.mock.calls.some((args) => args[0]?.[1] === "respond")).toBe(false);
});


it("honors a T3 answer persisted before a MausBot reply even before reconciliation", async () => {
  const f = fixture(); const receipt = await f.questions.open(input);
  f.cli.history.mockResolvedValue([{ requestId: "t3-question", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }], answers: { q: "T3 first" } }]);
  expect((await f.questions.answer(receipt.id, "MausBot later")).status).toBe("already-answered");
  expect(f.deps.nativeAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "t3" }), "T3 first");
});

it("does not commit a competing MausBot reply when T3 history cannot be reconciled", async () => {
  const f = fixture(); const receipt = await f.questions.open(input);
  f.cli.history.mockRejectedValue(new Error("offline"));
  await f.questions.answer(receipt.id, "MausBot later");
  expect(f.questions.get(receipt.id)?.answer).toBeUndefined();
  expect(f.deps.nativeAnswer).not.toHaveBeenCalled();
});


it("uses T3's single request resolution when a T3 answer races the MausBot submission", async () => {
  const f = fixture(); const receipt = await f.questions.open(input);
  f.respond.mockImplementation(async () => {
    f.cli.history.mockResolvedValue([{ requestId: "t3-question", threadId: "t3", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "q", question: input.question }], answers: { q: "T3 won the race" } }]);
    throw new Error("Runtime request is resolved");
  });
  await Promise.all([f.questions.answer(receipt.id, "MausBot competing"), f.questions.refresh(receipt.id)]);
  expect(f.deps.nativeAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "t3" }), "T3 won the race");
});

it("retains opaque option values when parsing the T3 history wire response", async () => {
  const cli = new PersonQuestionCli(async () => ({ requests: [{ requestId: "q", threadId: "thread", status: "resolved", createdAt: "2026-01-01T00:00:00Z", questions: [{ id: "one", question: "First?", options: [{ label: "Wait", value: "0" }] }], answers: { one: "0" } }] }));
  expect((await cli.history("thread"))[0]?.questions[0]?.options?.[0]).toEqual({ label: "Wait", value: "0" });
});
