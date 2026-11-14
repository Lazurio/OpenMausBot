import { execFile } from "node:child_process";
import { writeFileAtomic } from "./atomic.ts";

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
    if ((await this.call(["lazurio", "capabilities"])).agentCli !== true) throw new Error("ask-person-unavailable");
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

  async notify(threadId: string, id: string, text: string): Promise<void> {
    const result = await this.call(["request", "list", "--json", "--thread", threadId]);
    for (const request of result.requests ?? []) {
      if (request.type !== "question") continue;
      const answers = Object.fromEntries((request.questions ?? []).map((question: any) => [question.id, text]));
      await this.call(["request", "respond", request.requestId, "--thread", threadId, "--answers", JSON.stringify(answers), "--json"]);
    }
    await this.call(["thread", "send", threadId, `Question ${id} was answered in MausBot. The first answer won. Verbatim answer:\n${text}`, "--json", "--mode", "queue", "--idempotency-key", `mausbot-question-${id}`]);
  }
}
