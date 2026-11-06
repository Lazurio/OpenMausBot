// Lazurio MausBot GitHub intake: what follows a review run that ended without
// a verdict. The intake (server/github-intake.ts) asks GitHub and delivers;
// the contract is docs/lazurio-github-intake.md and server/github-intake.test.ts.
import { ACTIVE_RUN, obligationOf } from "./github-intake-review.ts";
import type { JsonValue } from "./schema.ts";

/** What the intake reads of a native run: the server's routine run record. */
export interface RunReceipt {
  status: string;
  threadId?: string;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set while the run waits for a person's answer. */
  asked?: unknown;
  error?: string;
  output?: string;
}

export const RETRY_BACKOFF_MS = 10 * 60_000;

/** Attempt n goes out no earlier than (n-1) × 10 minutes after the previous attempt ended. */
export function retryAt(next: number, previous: RunReceipt | null, deliveredAt: number): number {
  return (previous?.finishedAt ?? previous?.createdAt ?? deliveredAt) + (next - 1) * RETRY_BACKOFF_MS;
}

const STOPPED = "The GitHub intake stopped this run";
const STOPPED_IDLE = `${STOPPED}: no sign of progress for`;

/** Why an active run must be stopped. Past the hard cap since its start always;
 * idle only with a known progress signal, since start time alone cannot tell a
 * long review from a stuck one, and never while it waits for a person's answer. */
export function overdue(run: RunReceipt, now: number, limits: RunLimits, progressAt?: ProgressAt): string | null {
  if (!["running", "waiting"].includes(run.status) || run.startedAt === undefined) return null;
  if (now - run.startedAt >= limits.maxMs) return `${STOPPED}: still active ${Math.round(limits.maxMs / 60_000)} minutes after it started`;
  if (run.status === "waiting" && run.asked) return null;
  const signal = run.threadId ? progressAt?.(run.threadId, run.startedAt) : undefined;
  if (signal === undefined) return null;
  return now - Math.max(run.startedAt, signal) >= limits.idleMs ? `${STOPPED_IDLE} ${Math.round(limits.idleMs / 60_000)} minutes` : null;
}

export interface RunLimits { idleMs: number; maxMs: number }
/** The latest sign of progress of a run's conversation and of the work it handed out since `since`; undefined when none is known. */
export type ProgressAt = (threadId: string, since: number) => number | undefined;
/** Whether work the run's conversation handed out since `since` is still live, at any depth. */
export type WorkLive = (threadId: string, since: number) => boolean;

/** How a native run stands for the intake. A run that ended while the work it
 * handed out still runs keeps holding the pull request as waiting, so nothing
 * starts beside its teammates; `stop` says why it is past its limits. Progress
 * signals live in memory, so a known one counts no earlier than `since`, the
 * intake's own start. */
export function runStanding(run: RunReceipt, now: number, limits: RunLimits, signals: { progressAt?: ProgressAt; workLive?: WorkLive; since: number }): { run: RunReceipt; stop?: string } {
  const since = run.startedAt ?? run.createdAt;
  const delegated = !ACTIVE_RUN.includes(run.status) && run.threadId !== undefined && since !== undefined && signals.workLive?.(run.threadId, since) === true;
  const standing = delegated ? { ...run, status: "waiting", asked: undefined, startedAt: since } : run;
  const { progressAt } = signals;
  const known: ProgressAt | undefined = progressAt && ((threadId, from) => {
    const at = progressAt(threadId, from);
    return at === undefined ? undefined : Math.max(signals.since, at);
  });
  const stop = overdue(standing, now, limits, known);
  return stop ? { run: standing, stop } : { run: standing };
}

/** The run once the intake has stopped it and its delegated work: still
 * waiting while any of that work is live, otherwise ended. */
export function afterStop(run: RunReceipt, stop: string, now: number, workLive?: WorkLive): RunReceipt {
  const since = run.startedAt ?? run.createdAt;
  if (run.threadId !== undefined && since !== undefined && workLive?.(run.threadId, since)) return { ...run, status: "waiting", startedAt: since };
  return ACTIVE_RUN.includes(run.status) ? { ...run, status: "cancelled", error: stop, finishedAt: now } : run;
}

/** A fixed word for how an attempt ended; never the run's own text, since the
 * escalation comment may be on a public repository. */
export function attemptCategory(run: RunReceipt | null): string {
  if (!run) return "receipt-missing";
  if (run.error?.startsWith(STOPPED_IDLE)) return "no-progress";
  if (run.error?.startsWith(STOPPED)) return "time-limit";
  if (ACTIVE_RUN.includes(run.status)) return "running";
  return ({ completed: "no-verdict", failed: "failed", cancelled: "cancelled" } as Record<string, string>)[run.status] ?? "ended";
}

/** The first line of the one comment that ends a review run as blocked on this head. */
export const blockedMarker = (head: string): string => `<!-- lazurio-review: blocked head=${head} -->`;
export const REVIEW_NOTE_CHARS = 1_500;

export interface TeamNote { url?: string; body: string; at: number }
type Note = { user?: { login: string } | null; body?: string | null; html_url?: string; at?: string | null };

/** The account's own notes on the pull request since `since`: the comment that
 * says the run is blocked on this head, and the latest other comment or review
 * body, the progress a later attempt continues from. The intake's own
 * escalation comments are neither. */
export function teamNotes(notes: readonly Note[], account: string, head: string, since: number, ownNotice: string): { blocked?: TeamNote; progress?: TeamNote } {
  const own = notes.flatMap((note) => {
    const at = Date.parse(note.at ?? "");
    const body = (note.body ?? "").trim();
    if (note.user?.login.toLowerCase() !== account.toLowerCase() || !body || !(at >= since) || body.startsWith(ownNotice)) return [];
    return [{ ...(note.html_url ? { url: note.html_url } : {}), body, at }];
  }).sort((a, b) => a.at - b.at);
  const marker = blockedMarker(head);
  const isBlocked = (note: TeamNote) => note.body.split("\n", 1)[0].trim() === marker;
  const progress = own.filter((note) => !isBlocked(note)).at(-1);
  return {
    ...(own.some(isBlocked) ? { blocked: own.filter(isBlocked).at(-1) } : {}),
    ...(progress ? { progress: { ...progress, body: progress.body.slice(0, REVIEW_NOTE_CHARS) } } : {}),
  };
}

/** `previous_attempt` of the next attempt's event: how the last one ended and what it left. */
export function previousAttempt(attempt: number, runId: string | undefined, run: RunReceipt | null, progress: TeamNote | undefined): Record<string, JsonValue> {
  return {
    attempt,
    run_id: runId ?? null,
    status: run?.status ?? null,
    category: attemptCategory(run),
    finished_at: run?.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    error: run?.error?.slice(0, 500) ?? null,
    report: run?.output?.trim().slice(0, REVIEW_NOTE_CHARS) || null,
    progress_comment: progress ? { url: progress.url ?? null, created_at: new Date(progress.at).toISOString(), body: progress.body } : null,
  };
}

export const recoveryLead = (head: string): string => `The review run for head ${head} ended without a verdict`;

/** The one escalation comment per head: how many attempts ran and how each
 * ended, in fixed words only, and whom to ask. Its first words stay
 * `recoveryLead`, so a comment posted by an earlier version is found too. */
export function recoveryNotice(head: string, persona: string, attempts: readonly string[], options: { escalate?: string; blocked?: TeamNote } = {}): string {
  const responsible = options.escalate ? `@${options.escalate}, the person responsible for ${persona},` : `the person responsible for ${persona}`;
  return [
    `${recoveryLead(head)} after ${attempts.length} ${attempts.length === 1 ? "attempt" : "attempts"}, so no review of this head is on its way.`,
    "",
    ...attempts.map((category, index) => `- Attempt ${index + 1}: ${category}`),
    ...(options.blocked?.url ? ["", `What blocks it: ${options.blocked.url}`] : []),
    "",
    `To get a review, push a new head, or ask ${responsible} to start the review again.`,
    "",
    `— ${persona}`,
  ].join("\n");
}

/** Minutes since the oldest review obligation still open among these pull
 * requests was first handed over; null when none is open. */
export function oldestOwed(records: ReadonlyArray<{ key: string; at: number; kind: string; outcome: string; repository: string; number: number }>, pullRequests: ReadonlyArray<{ repo: string; number: number }>, now: number): number | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const { repo, number } of pullRequests) {
    const reviews = records.filter((record) => record.kind === "review" && record.repository.toLowerCase() === repo.toLowerCase() && record.number === number &&
      !["notified", "needs_human_approval"].includes(record.outcome));
    const latest = reviews.at(-1);
    if (!latest || !["delivered", "duplicate", "needs_recovery"].includes(latest.outcome)) continue;
    const obligation = obligationOf(latest.key);
    for (const record of reviews) if (obligationOf(record.key) === obligation) oldest = Math.min(oldest, record.at);
  }
  return Number.isFinite(oldest) ? Math.max(0, Math.floor((now - oldest) / 60_000)) : null;
}
