import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { GhRunner, GithubIntakeConfig } from "./github-intake.ts";

const marker = "<!-- lazurio:unassigned-reminder:v1 -->";
const identity = z.object({ id: z.number().int().positive() });
const repoSchema = z.array(z.object({ full_name: z.string(), archived: z.boolean(), permissions: z.object({ push: z.boolean() }).optional() }));
const pull = z.object({ number: z.number().int().positive(), state: z.string(), draft: z.boolean(), assignees: z.array(z.unknown()) });
const comments = z.array(z.object({ user: identity.nullable(), body: z.string().nullable() }));
const journal = z.object({ version: z.literal(1), accountId: z.number().int().positive(), entries: z.record(z.string(), z.enum(["pending", "sent"])) });

type Journal = z.output<typeof journal>;

export class UnassignedReminders {
  private journal: Journal | undefined;
  private readonly options: { gh: GhRunner; file: string; config: GithubIntakeConfig; guard: <T>(fn: () => T) => T; claim?: () => () => void };
  constructor(options: { gh: GhRunner; file: string; config: GithubIntakeConfig; guard: <T>(fn: () => T) => T; claim?: () => () => void }) { this.options = options; }

  private async api<T>(path: string, schema: z.ZodType<T>, args: string[] = []): Promise<T> {
    const result = await this.options.gh(["api", path, ...args]);
    if (!result.ok) throw new Error(`gh api ${path.split("?")[0]} failed: ${result.stderr.split("\n")[0]}`);
    try { return schema.parse(JSON.parse(result.stdout)); }
    catch { throw new Error(`gh api ${path.split("?")[0]} returned an unexpected response`); }
  }

  private async pages<T>(path: string, schema: z.ZodType<T[]>): Promise<T[]> {
    const result: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 10; page++) {
      const batch = await this.api(`${path}${separator}per_page=100&page=${page}`, schema);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
    throw new Error(`GitHub pagination limit reached for ${path.split("?")[0]}; reminder coverage is incomplete`);
  }

  private load(accountId: number): Journal {
    if (!this.journal) {
      try { this.journal = journal.parse(JSON.parse(readFileSync(this.options.file, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The unassigned reminder journal is unreadable; stop and recover it before sending comments");
        this.journal = { version: 1, accountId, entries: {} };
      }
    }
    if (this.journal.accountId !== accountId) throw new Error("The unassigned reminder journal belongs to a different GitHub account");
    return this.journal;
  }

  private save(): void {
    this.options.guard(() => {
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileAtomic(this.options.file, JSON.stringify(this.journal, null, 2), { mode: 0o600 });
    });
  }

  async poll(accountId: number): Promise<void> {
    const state = this.load(accountId);
    const { config } = this.options;
    const excluded = config.exclude.map((pattern) => new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"));
    const repos = await this.pages("user/repos?affiliation=owner,collaborator,organization_member", repoSchema);
    let pending = false;
    for (const repo of repos) {
      if (repo.archived || !repo.permissions?.push || !config.owners.includes(repo.full_name.split("/")[0].toLowerCase()) || excluded.some((r) => r.test(repo.full_name))) continue;
      const prs = await this.pages(`repos/${repo.full_name}/pulls?state=open`, z.array(pull));
      for (const item of prs) {
        const key = `${repo.full_name.toLowerCase()}#${item.number}`;
        if (state.entries[key] === "sent") continue;
        if (item.draft || item.state !== "open" || item.assignees.length) {
          if (state.entries[key] === "pending") pending = true;
          continue;
        }
        const found = await this.pages(`repos/${repo.full_name}/issues/${item.number}/comments`, comments);
        if (found.some((comment) => comment.user?.id === accountId && comment.body?.includes(marker))) {
          state.entries[key] = "sent";
          this.save();
          continue;
        }
        if (state.entries[key] === "pending") { pending = true; continue; }
        const current = await this.api(`repos/${repo.full_name}/pulls/${item.number}`, pull);
        if (current.state !== "open" || current.draft || current.assignees.length) continue;
        const release = this.options.claim?.() ?? (() => {});
        try {
          state.entries[key] = "pending";
          this.save();
          const body = `Please assign a person responsible for this pull request before it is merged.\n\n${marker}\n\n— ${config.reminderSignature}`;
          try {
            const posted = await this.api(`repos/${repo.full_name}/issues/${item.number}/comments`, comments.element, ["-f", `body=${body}`]);
            if (posted.user?.id !== accountId || posted.body !== body) throw new Error("GitHub did not confirm the reminder's author and body");
            state.entries[key] = "sent";
            this.save();
          } catch { state.entries[key] = "pending"; pending = true; }
        } finally { release(); }
      }
    }
    if (pending || Object.values(state.entries).includes("pending")) throw new Error("An unassigned reminder has an uncertain outcome; inspect GitHub and the reminder journal before recovery");
  }
}
