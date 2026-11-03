// Lazurio MausBot GitHub intake: a workflow run that waits in a GitHub
// Environment where the signed-in account is a required reviewer is a handoff
// to the bot team (Lazurio decision 0218, addendum of 2026-11-01). The intake
// (server/github-intake.ts) asks GitHub and delivers the facts the team
// decides on; no model runs while nothing waits. The contract is
// docs/lazurio-github-intake.md and server/github-intake.test.ts.
import { z } from "zod";

import { login } from "./github-intake-review.ts";
import type { JsonValue } from "./schema.ts";

const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

/** The job of a Lazurio release workflow that logs the dispatch inputs as its
 * first step's environment, before anything is built. */
export const VERIFY_JOB = "Verify source and version";
const MAX_LOGGED_ENV = 50;
const MAX_LOGGED_VALUE = 500;

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
    run_attempt: z.number().int().positive().default(1),
    name: z.string().nullable().optional(),
    path: z.string().optional(),
    html_url: z.string(),
    head_sha: z.string(),
    head_branch: z.string().nullable().optional(),
    event: z.string().optional(),
    status: z.string(),
    created_at: z.string().optional(),
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
const repositorySchema = z.object({ default_branch: z.string().min(1) });
const branchSchema = z.object({ commit: z.object({ sha: z.string() }) });
const jobsSchema = z.object({
  jobs: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
  })),
});
/** `GET repos/{repo}/actions/runs/{id}/approvals`: the run's review history, without attempts or times. */
const approvalsSchema = z.array(z.object({
  state: z.string(),
  comment: z.string().nullable().optional(),
  user: login.nullable().optional(),
  environments: z.array(z.object({ id: z.number().int().positive() })).optional(),
}));

/** The pull request whose merge made the commit, else the first one that contains it. */
export function mergedPull(pulls: z.output<typeof commitPullsSchema>): { number: number; url: string } | undefined {
  const pull = pulls.find((entry) => entry.merged_at) ?? pulls[0];
  return pull && { number: pull.number, url: pull.html_url };
}

type WaitingRun = z.output<typeof waitingRunsSchema>["workflow_runs"][number];

/** One attempt of one waiting run, with the environments this account may approve. */
export interface PendingApproval {
  key: string;
  repository: string;
  run: WaitingRun;
  environments: Array<{ id: number; name: string }>;
  /** Started by this account, which never approves its own run. */
  own: boolean;
}

export interface DeploymentReads {
  /** One page (100 runs) of `actions/runs?status=waiting`. */
  waitingRuns(repository: string, page: number): Promise<z.output<typeof waitingRunsSchema>>;
  pending(repository: string, runId: number): Promise<z.output<typeof pendingDeploymentsSchema>>;
  repository(repository: string): Promise<z.output<typeof repositorySchema>>;
  branch(repository: string, branch: string): Promise<z.output<typeof branchSchema>>;
  jobs(repository: string, runId: number, attempt: number): Promise<z.output<typeof jobsSchema>>;
  /** A job's plain-text log. */
  jobLog(repository: string, jobId: number): Promise<string>;
  approvals(repository: string, runId: number): Promise<z.output<typeof approvalsSchema>>;
}

/** Pages of waiting runs read per repository; more fails visibly instead of being skipped. */
export const WAITING_RUN_PAGES = 10;

/** `deployment:<repo>:<run id>:<attempt>`: a rerun is a new attempt and a new decision. */
export function deploymentKey(repository: string, runId: number, attempt: number): string {
  return `deployment:${repository}:${runId}:${attempt}`;
}

/** What one poll saw: the approvals to hand over, and which attempts still
 * wait in the repositories it could read completely. */
export interface DeploymentScan {
  approvals: PendingApproval[];
  waiting: Set<string>;
  read: Set<string>;
}

/** The waiting deployments of these repositories that GitHub lets this account
 * approve (`current_user_can_approve`), one per run attempt. A run that no
 * longer waits drops out by itself. A repository or run that can't be read
 * goes to `errors` and the others are still returned. */
export async function pendingApprovals(read: DeploymentReads, repositories: readonly string[], accountId: number | undefined, errors: unknown[]): Promise<DeploymentScan> {
  const scan: DeploymentScan = { approvals: [], waiting: new Set(), read: new Set() };
  for (const repository of repositories) {
    let runs: WaitingRun[];
    const failures = errors.length;
    try {
      runs = await waitingRuns(read, repository, errors);
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (errors.length === failures) scan.read.add(repository);
    for (const run of runs) {
      if (run.status !== "waiting") continue;
      scan.waiting.add(deploymentKey(repository, run.id, run.run_attempt));
      const starter = run.triggering_actor ?? run.actor;
      let deployments: z.output<typeof pendingDeploymentsSchema>;
      try {
        deployments = await read.pending(repository, run.id);
      } catch (error) {
        errors.push(error);
        continue;
      }
      const environments = deployments.filter((deployment) => deployment.current_user_can_approve)
        .map((deployment) => ({ id: deployment.environment.id, name: deployment.environment.name ?? "" }));
      if (!environments.length) continue;
      scan.approvals.push({
        key: deploymentKey(repository, run.id, run.run_attempt),
        repository, run, environments,
        own: accountId !== undefined && starter?.id === accountId,
      });
    }
  }
  return scan;
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

/** The GitHub reads of the deployment handoff through the intake's `gh api`. */
export function deploymentReads(api: Api, text: (path: string) => Promise<string>): DeploymentReads {
  return {
    waitingRuns: (repository, page) => api(`repos/${repository}/actions/runs?status=waiting&per_page=100&page=${page}`, waitingRunsSchema),
    pending: (repository, runId) => api(`repos/${repository}/actions/runs/${runId}/pending_deployments`, pendingDeploymentsSchema),
    repository: (repository) => api(`repos/${repository}`, repositorySchema),
    branch: (repository, branch) => api(`repos/${repository}/branches/${encodeURIComponent(branch)}`, branchSchema),
    jobs: (repository, runId, attempt) => api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, jobsSchema),
    jobLog: (repository, jobId) => text(`repos/${repository}/actions/jobs/${jobId}/logs`),
    approvals: (repository, runId) => api(`repos/${repository}/actions/runs/${runId}/approvals`, approvalsSchema),
  };
}

/** The pull request of the run's commit, or none when it can't be read: the approval goes out without it. */
export async function runPull(api: Api, approval: PendingApproval, errors: unknown[]): Promise<{ number: number; url: string } | undefined> {
  return mergedPull(await api(`repos/${approval.repository}/commits/${approval.run.head_sha}/pulls`, commitPullsSchema).catch((error: unknown) => { errors.push(error); return []; }));
}

const LOG_STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const LOGGED_VARIABLE = /^ {2}([A-Za-z_][A-Za-z0-9_]*): (.*)$/;

/** The environment GitHub Actions prints for the job's first `run` step: the
 * plain `env:` line and its indented `NAME: value` lines inside the step's
 * `##[group]Run` header. Script lines in that header are printed with colour
 * codes, so a script line reading `env:` never matches. Absent when the log
 * has no such block. */
export function loggedEnvironment(log: string): Record<string, string> | undefined {
  const lines = log.split(/\r?\n/).map((line) => line.replace(LOG_STAMP, ""));
  const group = lines.findIndex((line) => line.startsWith("##[group]Run "));
  if (group < 0) return undefined;
  const end = lines.indexOf("##[endgroup]", group);
  const header = lines.slice(group + 1, end < 0 ? undefined : end);
  const start = header.indexOf("env:");
  if (start < 0) return undefined;
  const env: Record<string, string> = {};
  for (const line of header.slice(start + 1, start + 1 + MAX_LOGGED_ENV)) {
    const match = LOGGED_VARIABLE.exec(line);
    if (!match) break;
    env[match[1]] = match[2].slice(0, MAX_LOGGED_VALUE);
  }
  return env;
}

/** What the team checks a release run against, read from GitHub when it is
 * handed over: the default branch and its tip, every job of this attempt, and
 * the inputs the verify job logged. A failed read throws: the run is handed
 * over on a later poll with complete facts, never without them. */
export async function deploymentFacts(read: DeploymentReads, approval: PendingApproval): Promise<Record<string, JsonValue>> {
  const { repository, run } = approval;
  const { default_branch: branch } = await read.repository(repository);
  const tip = (await read.branch(repository, branch)).commit.sha;
  const { jobs } = await read.jobs(repository, run.id, run.run_attempt);
  const verify = jobs.find((job) => job.name === VERIFY_JOB);
  const env = verify?.status === "completed" ? loggedEnvironment(await read.jobLog(repository, verify.id)) : undefined;
  return {
    default_branch: { name: branch, tip_sha: tip },
    jobs: jobs.map((job) => ({ name: job.name.slice(0, 200), status: job.status, conclusion: job.conclusion ?? null })),
    verify_job: verify
      ? { name: VERIFY_JOB, id: verify.id, url: verify.html_url ?? "", conclusion: verify.conclusion ?? null, logged_env: env ?? null }
      : null,
  };
}

/** The intake record fields of an approval; its `number` is the workflow run id. */
export function approvalRecord(approval: PendingApproval) {
  const { run } = approval;
  return { key: approval.key, kind: "deployment" as const, repository: approval.repository, number: run.id, headSha: run.head_sha, requester: (run.triggering_actor ?? run.actor)?.login ?? "" };
}

export function approvalPayload(approval: PendingApproval, account: string, facts: Record<string, JsonValue>, pull?: { number: number; url: string }): Record<string, JsonValue> {
  const { run } = approval;
  const starter = run.triggering_actor ?? run.actor;
  return {
    source: "lazurio-github-intake",
    kind: "deployment",
    reason: "deployment_review",
    account,
    repository: approval.repository,
    run: {
      id: run.id, attempt: run.run_attempt, url: run.html_url, head_sha: run.head_sha, workflow: (run.name ?? "").slice(0, 200),
      ...(run.path ? { workflow_path: run.path.slice(0, 300) } : {}),
      ...(run.head_branch ? { head_branch: run.head_branch } : {}), ...(run.event ? { event: run.event } : {}),
      ...(run.created_at ? { created_at: run.created_at } : {}),
      started_by: starter?.login ?? "", ...(starter?.id ? { started_by_id: starter.id } : {}),
    },
    environments: approval.environments.map((environment) => ({ id: environment.id, name: environment.name })),
    decision_comment_prefix: decisionPrefix(run.id, run.run_attempt),
    ...facts,
    ...(pull ? { pull_request: { number: pull.number, url: pull.url } } : {}),
  };
}

/** Every approval or rejection of a run attempt starts its comment with this,
 * because GitHub's review history of a run names neither attempt nor time. */
export function decisionPrefix(runId: number, attempt: number): string {
  return `Run ${runId} attempt ${attempt}:`;
}

export type DeploymentDecision = { outcome: "approved" | "rejected" | "ended"; reason: string };

/** How a handed-over attempt that no longer waits was decided: the review
 * whose comment starts with its decision prefix, else `ended` (cancelled,
 * failed, or decided without the prefix). */
export async function deploymentDecision(read: DeploymentReads, record: { repository: string; key: string; number: number }): Promise<DeploymentDecision> {
  const attempt = Number(record.key.split(":").at(-1));
  const prefix = decisionPrefix(record.number, attempt);
  const review = (await read.approvals(record.repository, record.number)).find((entry) => (entry.comment ?? "").trimStart().startsWith(prefix));
  if (!review || !["approved", "rejected"].includes(review.state)) {
    return { outcome: "ended", reason: "no longer waits; no review of this attempt starts with its decision prefix" };
  }
  return { outcome: review.state as "approved" | "rejected", reason: `${review.user?.login ?? "?"}: ${(review.comment ?? "").trim().slice(0, 500)}` };
}
