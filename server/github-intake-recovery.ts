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
export function overdue(run: RunReceipt, now: number, limits: RunLimits, progressAt?: ProgressAt, personWait = false): string | null {
  if (!["running", "waiting"].includes(run.status) || run.startedAt === undefined) return null;
  if (now - run.startedAt >= limits.maxMs) return `${STOPPED}: still active ${Math.round(limits.maxMs / 60_000)} minutes after it started`;
  if (personWait || (run.status === "waiting" && run.asked)) return null;
  const signal = run.threadId ? progressAt?.(run.threadId, run.startedAt) : undefined;
  if (signal === undefined) return null;
  return now - Math.max(run.startedAt, signal) >= limits.idleMs ? `${STOPPED_IDLE} ${Math.round(limits.idleMs / 60_000)} minutes` : null;
}

export interface RunLimits { idleMs: number; maxMs: number }
/** The latest sign of progress of a run's conversation and of the work it handed out since `since`; undefined when none is known. */
export type ProgressAt = (threadId: string, since: number) => number | undefined;
/** Whether work the run's conversation handed out since `since` is still live, at any depth: `asked` when some of it waits on a person's answer. */
export type WorkLive = (threadId: string, since: number) => false | "live" | "asked";

/** How a native run stands for the intake. A run that ended while the work it
 * handed out still runs keeps holding the pull request as waiting, so nothing
 * starts beside its teammates; `stop` says why it is past its limits. Progress
 * signals live in memory, so a known one counts no earlier than `since`, the
 * intake's own start. */
export function runStanding(run: RunReceipt, now: number, limits: RunLimits, signals: { progressAt?: ProgressAt; workLive?: WorkLive; since: number }): { run: RunReceipt; stop?: string } {
  const since = run.startedAt ?? run.createdAt;
  const tree = run.threadId !== undefined && since !== undefined ? signals.workLive?.(run.threadId, since) ?? false : false;
  const standing = tree && !ACTIVE_RUN.includes(run.status) ? { ...run, status: "waiting", asked: undefined, startedAt: since } : run;
  const { progressAt } = signals;
  const known: ProgressAt | undefined = progressAt && ((threadId, from) => {
    const at = progressAt(threadId, from);
    return at === undefined ? undefined : Math.max(signals.since, at);
  });
  const stop = overdue(standing, now, limits, known, tree === "asked");
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

/** How each attempt of an obligation ended, from the run of its record (`unknown` when no record of it is left); the last one `blocked` when it said so. */
export function attemptCategories(attempts: number, blocked: boolean, record: (attempt: number) => { runId?: string } | undefined, runState?: (runId: string) => RunReceipt | null): string[] {
  return Array.from({ length: attempts }, (_, index) => {
    if (blocked && index === attempts - 1) return "blocked";
    const ran = record(index + 1);
    return ran ? attemptCategory(ran.runId ? runState?.(ran.runId) ?? null : null) : "unknown";
  });
}

/** The first line of the one comment that ends a review run as blocked on this head. */
export const blockedMarker = (head: string): string => `<!-- lazurio-review: blocked head=${head} -->`;
export const REVIEW_NOTE_CHARS = 1_500;

export interface TeamNote { url?: string; body: string; at: number }
type Note = { id?: number; user?: { login: string } | null; body?: string | null; html_url?: string; at?: string | null };

/** Which blocked comment belongs to an attempt: an issue comment above the
 * highest comment id the intake saw when it handed the attempt over. GitHub's
 * comment ids only grow, so an older run's or request's comment never counts,
 * whatever the clocks say. An attempt handed over before floors were recorded
 * keeps the time window: posted at most a minute before its delivery. */
export interface AttemptFloor { notesFloor?: number; deliveredAt: number }

/** The account's own notes on the pull request since `since`: the issue
 * comment in which this attempt said it is blocked on this head, and the
 * latest other comment or review body, the progress a later attempt continues
 * from. The intake's own escalation comments are neither. */
export function teamNotes(notes: { comments: readonly Note[]; reviews: readonly Note[] }, account: string, head: string, since: number, ownNotice: string, attempt: AttemptFloor): { blocked?: TeamNote; progress?: TeamNote } {
  const own = (list: readonly Note[]) => list.flatMap((note) => {
    const at = Date.parse(note.at ?? "");
    const body = (note.body ?? "").trim();
    if (note.user?.login.toLowerCase() !== account.toLowerCase() || !body || !(at >= since) || body.startsWith(ownNotice)) return [];
    return [{ ...(note.html_url ? { url: note.html_url } : {}), body, at, id: note.id ?? 0 }];
  });
  const marker = blockedMarker(head);
  const isMarker = (note: TeamNote) => note.body.split("\n", 1)[0].trim() === marker;
  const ours = (note: { id: number; at: number }) => attempt.notesFloor !== undefined ? note.id > attempt.notesFloor : note.at >= attempt.deliveredAt - 60_000;
  const comments = own(notes.comments);
  const blocked = comments.filter((note) => isMarker(note) && ours(note)).sort((a, b) => a.id - b.id).at(-1);
  const progress = [...comments, ...own(notes.reviews)].filter((note) => !isMarker(note)).sort((a, b) => a.at - b.at).at(-1);
  const plain = (note: TeamNote & { id: number }): TeamNote => ({ ...(note.url ? { url: note.url } : {}), body: note.body.slice(0, REVIEW_NOTE_CHARS), at: note.at });
  return { ...(blocked ? { blocked: plain(blocked) } : {}), ...(progress ? { progress: plain(progress) } : {}) };
}

/** The highest issue comment id among a repository's newest comments: the floor an attempt's blocked comment must exceed. */
export const notesFloorOf = (newest: ReadonlyArray<{ id: number }>): number => Math.max(0, ...newest.map((comment) => comment.id));

/** Since when the account's notes on this head count: a minute before the head was first handed over. */
export function headSince(records: ReadonlyArray<{ kind: string; outcome: string; repository: string; number: number; headSha?: string; at: number }>, pull: { repository: string; number: number; at: number }, head: string): number {
  return Math.min(pull.at, ...records.filter((entry) => entry.kind === "review" && ["delivered", "duplicate", "needs_recovery"].includes(entry.outcome) &&
    entry.repository.toLowerCase() === pull.repository.toLowerCase() && entry.number === pull.number && entry.headSha === head).map((entry) => entry.at)) - 60_000;
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
