import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatQuestionAnswers } from "../shared/ask-question.ts";
import type { AskQuestion } from "../shared/ask-question.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { RequestOutcome } from "./contracts.ts";
import { PersonQuestionCli, type T3Question } from "./lazurio-person-question-cli.ts";

const receiptSchema = z.object({
  id: z.string(), botId: z.string(), botName: z.string(), threadId: z.string(), requestId: z.string(), instanceId: z.string(),
  question: z.string(), questions: z.array(z.custom<AskQuestion>()).optional(),
  attempted: z.boolean(), t3RequestId: z.string().optional(), t3ThreadId: z.string().optional(), link: z.string().optional(),
  error: z.string().optional(), reported: z.string().optional(),
  nativeRejected: z.boolean().optional(), answer: z.string().optional(), source: z.enum(["mausbot", "t3"]).optional(), delivered: z.boolean().optional(), notified: z.boolean().optional(),
});
export type PersonQuestionReceipt = z.infer<typeof receiptSchema>;
export type PersonQuestionInput = Pick<PersonQuestionReceipt, "botId" | "botName" | "threadId" | "requestId" | "instanceId" | "question" | "questions">;
export interface PersonQuestionDeps {
  dataDir: string;
  cli?: PersonQuestionCli;
  nativeAnswer(receipt: PersonQuestionReceipt, answer: string): Promise<RequestOutcome>;
  lateAnswer(receipt: PersonQuestionReceipt, text: string, sendId: string): Promise<void>;
  notice(receipt: PersonQuestionReceipt, code: string): void | Promise<void>;
}
export const personQuestionId = (threadId: string, requestId: string) => createHash("sha256").update(JSON.stringify([threadId, requestId])).digest("hex");

/** Delivery receipts for native bot questions. The native provider request remains the waiting-state owner. */
export class PersonQuestions {
  private records = new Map<string, PersonQuestionReceipt>();
  private locks = new Map<string, Promise<unknown>>();
  private cli: PersonQuestionCli;
  private dir: string;

  private deps: PersonQuestionDeps;
  constructor(deps: PersonQuestionDeps) {
    this.deps = deps;
    this.dir = join(deps.dataDir, "person-questions");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.cli = deps.cli ?? new PersonQuestionCli();
    for (const name of readdirSync(this.dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = receiptSchema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
      if (`${record.id}.json` !== name || personQuestionId(record.threadId, record.requestId) !== record.id) throw new Error("Invalid person question receipt");
      this.records.set(record.id, record);
    }
  }

  get(id: string): PersonQuestionReceipt | undefined { const record = this.records.get(id); return record && structuredClone(record); }
  has(threadId: string, requestId: string): boolean { return this.records.has(personQuestionId(threadId, requestId)); }

  private save(record: PersonQuestionReceipt): void {
    writeFileAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
    this.records.set(record.id, structuredClone(record));
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }

  async open(input: PersonQuestionInput, card?: () => void): Promise<PersonQuestionReceipt> {
    const id = personQuestionId(input.threadId, input.requestId);
    return this.serial(id, async () => {
      let record = this.get(id);
      if (record && (record.question !== input.question || JSON.stringify(record.questions) !== JSON.stringify(input.questions))) throw new Error("question-id-conflict");
      if (!record) { record = { ...input, id, attempted: false }; this.save(record); }
      card?.();
      if (!record.t3ThreadId && record.answer === undefined) await this.launch(record);
      return this.get(id)!;
    });
  }

  private async report(record: PersonQuestionReceipt, code: string): Promise<void> {
    record.error = code;
    this.save(record);
    if (record.reported !== code) {
      await this.deps.notice(record, code);
      record.reported = code;
    }
    this.save(record);
  }

  private async launch(record: PersonQuestionReceipt): Promise<void> {
    try {
      await this.cli.available();
      const marker = `[mausbot-question:${record.id}]`;
      const found = await this.cli.find(marker);
      if (found) {
        record.t3ThreadId = found.threadId; record.link = found.link;
      } else {
        if (record.attempted) return this.report(record, "ask-person-launch-ambiguous");
        record.attempted = true;
        this.save(record);
        const thread = await this.cli.launch(`${record.botName}: ${record.question.replace(/\s+/g, " ").slice(0, 65)} ${marker}`, join(this.dir, `${record.id}.md`), this.prompt(record));
        record.t3ThreadId = thread.threadId; record.link = thread.link;
      }
      delete record.error;
      this.save(record);
    } catch { await this.report(record, "ask-person-unavailable"); }
  }

  private prompt(record: PersonQuestionReceipt): string {
    return `Ask the person on behalf of bot ${JSON.stringify(record.botName)}. Use the question tool with all the supplied question texts and options exactly as given, in one request. Ask no other question. Follow the Environment's language and tone. A publication choice has no recommendation. Never act on the bot's task. Never treat a default, silence or timeout as the person's answer.\n\nQuestion id: ${record.id}\n${record.question}\nStructured questions: ${JSON.stringify(record.questions ?? [])}\n\nAfter the person answers, confirm that MausBot reads this request's saved answer automatically. Do not POST an answer or relay it yourself. Do nothing else.\n`;
  }

  private bind(record: PersonQuestionReceipt, history: T3Question[]): T3Question | undefined {
    if (!record.t3RequestId) {
      const expected = record.questions?.map((question) => question.question) ?? [record.question];
      const first = history.find((request) => request.questions.length === expected.length && request.questions.every((question, index) => question.question === expected[index]));
      if (first) { record.t3RequestId = first.requestId; delete record.error; this.save(record); }
    }
    return history.find((request) => request.requestId === record.t3RequestId);
  }

  private storedAnswer(record: PersonQuestionReceipt, request: T3Question): string | undefined {
    if (request.status !== "resolved" || !request.answers || !request.questions.length) return undefined;
    const answers: string[][] = [];
    for (const question of request.questions) {
      const raw = request.answers[question.id];
      const value = typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : undefined;
      if (!value?.length || value.every((item) => item.length === 0)) return undefined;
      answers.push(value);
    }
    if (answers.length === 1) return answers[0]!.join(", ");
    return record.questions?.length === answers.length ? formatQuestionAnswers(record.questions, answers) : undefined;
  }

  async refresh(id: string): Promise<{ status: string; receipt: PersonQuestionReceipt }> {
    return this.serial(id, async () => {
      const record = this.get(id);
      if (!record) throw new Error("question-not-found");
      if (record.answer !== undefined) { await this.deliver(record); return this.result(record); }
      if (!record.t3ThreadId) { await this.launch(record); return this.result(record); }
      try {
        const history = await this.cli.history(record.t3ThreadId);
        const request = this.bind(record, history);
        const answer = request && this.storedAnswer(record, request);
        if (answer !== undefined) return this.accept(record, answer, "t3");
        const state = await this.cli.state(record.t3ThreadId);
        if (!request && history.length && !record.t3RequestId) await this.report(record, "ask-person-question-mismatch");
        else if (request?.status === "resolved") await this.report(record, "ask-person-invalid-answer");
        else if ((record.t3RequestId && !request) || request?.status === "cancelled" || request?.status === "expired" || state.archived || ["idle", "completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(state.status ?? "")) await this.report(record, "ask-person-still-open");
      } catch { await this.report(record, "ask-person-unavailable"); }
      return this.result(record);
    });
  }

  private result(record: PersonQuestionReceipt): { status: string; receipt: PersonQuestionReceipt } {
    return { status: record.nativeRejected ? "rejected" : record.delivered ? "delivered" : record.error ? "pending" : "waiting", receipt: this.get(record.id)! };
  }

  private async accept(record: PersonQuestionReceipt, answer: string, source: "mausbot" | "t3"): Promise<{ status: string; receipt: PersonQuestionReceipt }> {
    if (record.answer !== undefined && (record.answer !== answer || record.source !== source)) return { status: "already-answered", receipt: record };
    if (record.answer === undefined) { record.answer = answer; record.source = source; this.save(record); }
    await this.deliver(record);
    return this.result(record);
  }

  async answer(id: string, answer: string): Promise<{ status: string; receipt: PersonQuestionReceipt }> {
    if (!answer.length || answer.length > 100_000) throw new Error("invalid-answer");
    return this.serial(id, async () => {
      const record = this.get(id);
      if (!record) throw new Error("question-not-found");
      return this.accept(record, answer, "mausbot");
    });
  }

  private async deliver(record: PersonQuestionReceipt): Promise<void> {
    if (record.answer === undefined || record.nativeRejected) return;
    try {
      if (!record.delivered) {
        const outcome = await this.deps.nativeAnswer(record, record.answer);
        if (outcome !== "answered" && outcome !== "unavailable") {
          record.nativeRejected = true;
          await this.report(record, "ask-person-answer-rejected");
          return;
        }
        if (outcome === "unavailable") await this.deps.lateAnswer(record, `Answer to question ${record.id} (${record.source}):\n${record.answer}`, `person-question-${record.id}`);
        record.delivered = true;
        delete record.error;
        this.save(record);
      }
      if (record.t3ThreadId && record.source === "mausbot" && !record.notified) {
        if (!record.t3RequestId) this.bind(record, await this.cli.history(record.t3ThreadId));
        await this.cli.notify(record.t3ThreadId, record.id, record.answer, record.t3RequestId);
        if (!record.t3RequestId) {
          const state = await this.cli.state(record.t3ThreadId);
          if (!state.archived && !["completed", "failed", "cancelled", "interrupted"].includes(state.status ?? "")) return;
        }
        record.notified = true;
        delete record.error;
        this.save(record);
      }
    } catch { await this.report(record, "ask-person-delivery-failed"); }
  }

  async reconcile(): Promise<void> {
    for (const id of this.records.keys()) await this.refresh(id);
  }
}
