// Lazurio MausBot GitHub intake: a workflow run that waits in a GitHub
// Environment where the signed-in account is a required reviewer is a handoff
// to the bot team (Lazurio decision 0218, addendum of 2026-11-01). The intake
// (server/github-intake.ts) asks GitHub and delivers; the contract is
// docs/lazurio-github-intake.md and server/github-intake.test.ts.
import { z } from "zod";

import { login } from "./github-intake-review.ts";
import type { JsonValue } from "./schema.ts";

const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

/** OMB_GITHUB_INTAKE_DEPLOYMENTS: the exact `owner/repo` list whose waiting
 * deployments the intake reads. Unset reads none. */
export function deploymentReposFromEnv(value: string | undefined): string[] {
  const repos = (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const bad = repos.find((repo) => !REPO.test(repo));
  if (bad) throw new Error(`OMB_GITHUB_INTAKE_DEPLOYMENTS: "${bad}" is not an exact owner/repo`);
  return [...new Set(repos)];
}

export const waitingRunsSchema = z.object({
  total_count: z.number().int().nonnegative().optional(),
  workflow_runs: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string().nullable().optional(),
    html_url: z.string(),
    head_sha: z.string(),
    head_branch: z.string().nullable().optional(),
    event: z.string().optional(),
    status: z.string(),
    triggering_actor: login.nullable().optional(),
    actor: login.nullable().optional(),
  })),
});
export const pendingDeploymentsSchema = z.array(z.object({
  environment: z.object({ id: z.number().int().positive(), name: z.string().optional() }),
  current_user_can_approve: z.boolean(),
}));
/** The pull requests of a commit (`GET repos/{repo}/commits/{sha}/pulls`): which merge started the run. */
export const commitPullsSchema = z.array(z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  merged_at: z.string().nullable().optional(),
}));

/** The pull request whose merge made the commit, else the first one that contains it. */
export function mergedPull(pulls: z.output<typeof commitPullsSchema>): { number: number; url: string } | undefined {
  const pull = pulls.find((entry) => entry.merged_at) ?? pulls[0];
  return pull && { number: pull.number, url: pull.html_url };
}

type WaitingRun = z.output<typeof waitingRunsSchema>["workflow_runs"][number];

/** One environment of one waiting run that this account may approve. */
export interface PendingApproval {
  key: string;
  repository: string;
  run: WaitingRun;
  environment: { id: number; name: string };
  /** Started by this account, which never approves its own run. */
  own: boolean;
}

export interface DeploymentReads {
  /** One page (100 runs) of `actions/runs?status=waiting`. */
  waitingRuns(repository: string, page: number): Promise<z.output<typeof waitingRunsSchema>>;
  pending(repository: string, runId: number): Promise<z.output<typeof pendingDeploymentsSchema>>;
}

/** Pages of waiting runs read per repository; more fails visibly instead of being skipped. */
export const WAITING_RUN_PAGES = 10;

/** The waiting deployments of these repositories that GitHub lets this account
 * approve (`current_user_can_approve`), one per run and environment, keyed by
 * their ids. A run that no longer waits drops out by itself. A repository or
 * run that can't be read goes to `errors` and the others are still returned. */
export async function pendingApprovals(read: DeploymentReads, repositories: readonly string[], accountId: number | undefined, errors: unknown[]): Promise<PendingApproval[]> {
  const found: PendingApproval[] = [];
  for (const repository of repositories) {
    let runs: WaitingRun[];
    try {
      runs = await waitingRuns(read, repository, errors);
    } catch (error) {
      errors.push(error);
      continue;
    }
    for (const run of runs) {
      if (run.status !== "waiting") continue;
      const starter = run.triggering_actor ?? run.actor;
      let deployments: z.output<typeof pendingDeploymentsSchema>;
      try {
        deployments = await read.pending(repository, run.id);
      } catch (error) {
        errors.push(error);
        continue;
      }
      for (const deployment of deployments) {
        if (!deployment.current_user_can_approve) continue;
        found.push({
          key: `deployment:${repository}:${run.id}:${deployment.environment.id}`,
          repository, run,
          environment: { id: deployment.environment.id, name: deployment.environment.name ?? "" },
          own: accountId !== undefined && starter?.id === accountId,
        });
      }
    }
  }
  return found;
}

/** Every waiting run of a repository, page by page. Past `WAITING_RUN_PAGES`
 * pages, or when a later page can't be read, the runs read so far still count
 * and the rest is an error, so no approval waits unseen. */
async function waitingRuns(read: DeploymentReads, repository: string, errors: unknown[]): Promise<WaitingRun[]> {
  const runs: WaitingRun[] = [];
  for (let page = 1; page <= WAITING_RUN_PAGES; page++) {
    let batch: z.output<typeof waitingRunsSchema>;
    try {
      batch = await read.waitingRuns(repository, page);
    } catch (error) {
      if (page === 1) throw error;
      errors.push(error);
      return runs;
    }
    runs.push(...batch.workflow_runs);
    if (batch.workflow_runs.length < 100 || (batch.total_count !== undefined && runs.length >= batch.total_count)) return runs;
  }
  errors.push(new Error(`${repository}: more than ${WAITING_RUN_PAGES * 100} runs wait for a deployment; the intake can't read them all`));
  return runs;
}

type Api = <T>(path: string, schema: z.ZodType<T>) => Promise<T>;

/** The GitHub reads of `pendingApprovals` through the intake's `gh api`. */
export function deploymentReads(api: Api): DeploymentReads {
  return {
    waitingRuns: (repository, page) => api(`repos/${repository}/actions/runs?status=waiting&per_page=100&page=${page}`, waitingRunsSchema),
    pending: (repository, runId) => api(`repos/${repository}/actions/runs/${runId}/pending_deployments`, pendingDeploymentsSchema),
  };
}

/** The pull request of the run's commit, or none when it can't be read: the approval goes out without it. */
export async function runPull(api: Api, approval: PendingApproval, errors: unknown[]): Promise<{ number: number; url: string } | undefined> {
  return mergedPull(await api(`repos/${approval.repository}/commits/${approval.run.head_sha}/pulls`, commitPullsSchema).catch((error: unknown) => { errors.push(error); return []; }));
}

/** The intake record fields of an approval; its `number` is the workflow run id. */
export function approvalRecord(approval: PendingApproval) {
  const { run } = approval;
  return { key: approval.key, kind: "deployment" as const, repository: approval.repository, number: run.id, headSha: run.head_sha, requester: (run.triggering_actor ?? run.actor)?.login ?? "" };
}

export function approvalPayload(approval: PendingApproval, account: string, pull?: { number: number; url: string }): Record<string, JsonValue> {
  const { run } = approval;
  const starter = run.triggering_actor ?? run.actor;
  return {
    source: "lazurio-github-intake",
    kind: "deployment",
    reason: "deployment_review",
    account,
    repository: approval.repository,
    run: {
      id: run.id, url: run.html_url, head_sha: run.head_sha, workflow: (run.name ?? "").slice(0, 200),
      ...(run.head_branch ? { head_branch: run.head_branch } : {}), ...(run.event ? { event: run.event } : {}),
      started_by: starter?.login ?? "", ...(starter?.id ? { started_by_id: starter.id } : {}),
    },
    environment: { id: approval.environment.id, name: approval.environment.name },
    ...(pull ? { pull_request: { number: pull.number, url: pull.url } } : {}),
  };
}
