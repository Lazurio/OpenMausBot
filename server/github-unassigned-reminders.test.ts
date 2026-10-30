import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnassignedReminders } from "./github-unassigned-reminders.ts";
import type { GhRunner, GithubIntakeConfig } from "./github-intake.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-reminders-")); dirs.push(dir);
  const config: GithubIntakeConfig = { bot: "Henry", scope: "requested", owners: ["acme"], exclude: ["acme/infra"], intervalMs: 90_000, reminderSignature: "Pablo" };
  const file = join(dir, "state");
  const pulls = new Map<number, { number: number; state: string; draft: boolean; assignees: unknown[] }>();
  const comments = new Map<number, Array<{ user: { id: number }; body: string }>>();
  let posts = 0;
  let uncertain = false;
  let assignBeforePost = false;
  let incomplete = false;
  const calls: string[] = [];
  const gh: GhRunner = async (args) => {
    const path = args[1]; calls.push(path);
    const url = new URL(path, "https://github.test");
    const page = Number(url.searchParams.get("page") ?? "1");
    const batch = <T>(a: T[]) => a.slice((page - 1) * 100, page * 100);
    const ok = (x: unknown) => ({ ok: true as const, stdout: JSON.stringify(x) });
    if (url.pathname === "/user/repos") return ok(batch([{ full_name: "acme/app", archived: false, permissions: { push: true } }, { full_name: "acme/infra", archived: false, permissions: { push: true } }, { full_name: "other/app", archived: false, permissions: { push: true } }]));
    if (url.pathname === "/repos/acme/app/pulls") return ok(incomplete ? Array.from({ length: 100 }, (_, i) => ({ number: page * 100 + i, state: "open", draft: true, assignees: [] })) : batch([...pulls.values()]));
    const current = url.pathname.match(/^\/repos\/acme\/app\/pulls\/(\d+)$/);
    if (current) {
      const pr = pulls.get(Number(current[1]))!;
      if (assignBeforePost) pr.assignees = [{}];
      return ok(pr);
    }
    const issue = url.pathname.match(/^\/repos\/acme\/app\/issues\/(\d+)\/comments$/);
    if (issue) {
      const n = Number(issue[1]);
      if (args.includes("-f")) {
        posts++;
        const body = args[args.indexOf("-f") + 1].slice(5);
        if (uncertain) return { ok: false, code: null, stderr: "timeout" };
        const comment = { user: { id: 12 }, body };
        comments.set(n, [...(comments.get(n) ?? []), comment]);
        return ok(comment);
      }
      return ok(batch(comments.get(n) ?? []));
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const make = () => new UnassignedReminders({ gh, file, config, guard: (fn) => fn() });
  return { config, file, pulls, comments, calls, make, get posts() { return posts; }, uncertain: (v: boolean) => { uncertain = v; }, assignBeforePost: () => { assignBeforePost = true; }, incomplete: () => { incomplete = true; } };
}
const pr = (number: number) => ({ number, state: "open", draft: false, assignees: [] as unknown[] });

describe("unassigned reminders", () => {
  it("covers a second page within scoped pushable repositories and does not repeat across restart", async () => {
    const f = fixture();
    for (let i = 1; i <= 101; i++) f.pulls.set(i, { ...pr(i), draft: i !== 101 });
    await f.make().poll(12);
    await f.make().poll(12);
    expect(f.posts).toBe(1);
    expect(f.comments.get(101)?.[0].body).toContain("— Pablo");
    expect(f.calls).toContain("repos/acme/app/pulls?state=open&per_page=100&page=2");
    expect(f.calls.some((c) => c.includes("infra") || c.includes("other/app"))).toBe(false);
  });
  it("rechecks current assignment immediately before posting", async () => {
    const f = fixture(); f.pulls.set(1, pr(1)); f.assignBeforePost();
    await f.make().poll(12); expect(f.posts).toBe(0);
  });
  it("persists an uncertain attempt and refuses to repeat it after a restart", async () => {
    const f = fixture(); f.pulls.set(1, pr(1)); f.uncertain(true);
    await expect(f.make().poll(12)).rejects.toThrow(/uncertain/);
    f.uncertain(false);
    await expect(f.make().poll(12)).rejects.toThrow(/uncertain/);
    expect(f.posts).toBe(1);
    expect(JSON.parse(readFileSync(f.file, "utf8")).entries["acme/app#1"]).toBe("pending");
    f.comments.set(1, [{ user: { id: 12 }, body: "<!-- lazurio:unassigned-reminder:v1 -->" }]);
    await f.make().poll(12);
    expect(f.posts).toBe(1);
  });
  it("reports a pagination bound instead of claiming complete coverage", async () => {
    const f = fixture(); f.incomplete();
    await expect(f.make().poll(12)).rejects.toThrow(/coverage is incomplete/);
    expect(f.posts).toBe(0);
  });
});
