import { execFile } from "node:child_process";
import { z } from "zod";
import { parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById } from "../shared/ask-question.ts";
import { writeFileAtomic } from "./atomic.ts";

const historySchema = z.object({ requests: z.array(z.object({
  requestId: z.string().min(1), threadId: z.string().min(1), status: z.enum(["pending", "resolved", "cancelled", "expired"]),
  createdAt: z.string(), questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.object({ label: z.string(), value: z.string().optional() })).optional(), multiSelect: z.boolean().optional() }).passthrough()),
  answers: z.record(z.string(), z.unknown()).optional(),
})) });
export type T3Question = z.infer<typeof historySchema>["requests"][number];

export type T3Call = (args: string[]) => Promise<any>;
export const t3Call: T3Call = (args) => new Promise((resolve, reject) => {
  execFile(process.env.OMB_T3_CLI ?? "t3", args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(new Error("ask-person-unavailable"));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error("ask-person-unavailable")); }
  });
});

/** T3 agent CLI v1 has idempotent send, but no idempotent launch. */
export class PersonQuestionCli {
  private call: T3Call;
  constructor(call: T3Call = t3Call) { this.call = call; }

  async available(): Promise<void> {
    const capabilities = await this.call(["lazurio", "capabilities"]);
    if (capabilities.agentCli !== true || capabilities.requestHistory !== true) throw new Error("ask-person-unavailable");
  }

  async find(marker: string): Promise<{ threadId: string; link: string } | undefined> {
    const result = await this.call(["thread", "list", "--json", "--title", marker, "--limit", "100"]);
    if (!Array.isArray(result.threads) || result.threads.length >= 100) throw new Error("ask-person-unavailable");
    const matches = result.threads.filter((thread: any) => typeof thread.title === "string" && thread.title.endsWith(marker));
    if (matches.length > 1) throw new Error("ask-person-launch-ambiguous");
    const found = matches[0];
    if (found && (typeof found.threadId !== "string" || !found.threadId || typeof found.link !== "string" || !found.link)) throw new Error("ask-person-unavailable");
    return found;
  }

  async launch(title: string, file: string, prompt: string): Promise<{ threadId: string; link: string }> {
    writeFileAtomic(file, prompt, { mode: 0o600 });
    const result = await this.call(["thread", "launch", "--json", "--title", title, "--message-file", file]);
    const thread = result.thread ?? result;
    if (typeof thread.threadId !== "string" || typeof thread.link !== "string") throw new Error("ask-person-launch-ambiguous");
    return thread;
  }

  async state(threadId: string): Promise<{ archived?: boolean; status?: string }> {
    const thread = (await this.call(["thread", "read", threadId, "--json", "--limit", "1", "--max-chars", "100"])).thread;
    if (!thread || typeof thread.status !== "string" || typeof thread.archived !== "boolean") throw new Error("ask-person-unavailable");
    return thread;
  }

  async history(threadId: string): Promise<T3Question[]> {
    const result = historySchema.parse(await this.call(["request", "history", "--thread", threadId, "--json"]));
    if (result.requests.some((request) => request.threadId !== threadId)) throw new Error("ask-person-unavailable");
    return result.requests.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
  }

  async respond(threadId: string, requestId: string, text: string): Promise<boolean> {
    const result = await this.call(["request", "list", "--json", "--thread", threadId]);
    const request = (result.requests ?? []).find((candidate: any) => candidate.type === "question" && candidate.requestId === requestId);
    if (!request) return false;
    const questions = parseProtocolAskQuestions(request.questions);
    if (!questions) return false;
    const byId = questionAnswersById(text, questions);
    const answers: Record<string, string | string[]> = {};
    for (const { id: questionId, question } of questions) {
      const answer = byId[questionId];
      if (answer === undefined) continue;
      const picked = pickedOptionLabels(answer, question);
      const options = request.questions.find((entry: any) => entry.id === questionId)?.options ?? [];
      const values = picked.labels.map((label) => options.find((option: any) => option.label === label)?.value ?? label);
      if (picked.other !== undefined) values.push(picked.other);
      answers[questionId] = question.multiSelect ? values : values[0]!;
    }
    if (!questions.every(({ id: questionId }) => answers[questionId] !== undefined)) return false;
    await this.call(["request", "respond", requestId, "--thread", threadId, "--answers", JSON.stringify(answers), "--json"]);
    return true;
  }

  async notify(threadId: string, id: string, text: string, requestId?: string): Promise<void> {
    if (requestId) await this.respond(threadId, requestId, text);
    await this.call(["thread", "send", threadId, `Question ${id} was answered in MausBot. The first answer won. Verbatim answer:\n${text}`, "--json", "--mode", "queue", "--idempotency-key", `mausbot-question-${id}`]);
  }
}
