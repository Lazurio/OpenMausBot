// Lazurio MausBot GitHub intake: which review of a pull request's exact head
// the account still owes, decided from GitHub's records alone. The intake
// (server/github-intake.ts) asks GitHub and delivers; the contract is
// docs/lazurio-github-intake.md and server/github-intake.test.ts.
import { createHash } from "node:crypto";
import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export const login = z.object({ login: z.string(), id: z.number().int().positive().optional() });
export const reviewsSchema = z.array(z.object({
  user: login.nullable().optional(),
  commit_id: z.string().nullable().optional(),
  state: z.string(),
  submitted_at: z.string().nullable().optional(),
}));
export const eventsSchema = z.array(z.object({
  id: z.number().int().positive().optional(),
  event: z.string(),
  actor: login.nullable().optional(),
  assigner: login.nullable().optional(),
  assignee: login.nullable().optional(),
  requested_reviewer: login.nullable().optional(),
  review_requester: login.nullable().optional(),
  created_at: z.string(),
}));
export const commitSchema = z.object({ commit: z.object({ committer: z.object({ date: z.string().optional() }).nullable().optional() }) });

type GithubUser = z.output<typeof login>;
type GithubReview = z.output<typeof reviewsSchema>[number];
type GithubIssueEvent = z.output<typeof eventsSchema>[number];
type IsAccount = (user: GithubUser | null | undefined) => boolean;

/** The account's last verdict on the head, and whether it was submitted after
 * the head last changed. GitHub carries an APPROVED onto a new head whose diff
 * did not change (a base merge, a content-identical rebase) and keeps its old
 * `submitted_at`, so `commit_id` alone does not show what was reviewed. */
export interface HeadVerdict { state: string; submittedAt: string; current: boolean }

/** An explicit request for the account that is still pending on GitHub,
 * identified by its immutable `review_requested` event. */
export interface ReviewRequest { eventId: number; at: number; createdAt: string; requester: string }

/** What the intake reads about one pull request; each read is made only when
 * the decision needs it. */
export interface ReviewReads {
  reviews(): Promise<GithubReview[]>;
  events(): Promise<GithubIssueEvent[]>;
  committerDate(): Promise<string | undefined>;
}

/** The account's verdict on the head and its pending request. A review
 * counts only with the account's id once it is known; an event or a requested
 * reviewer may name the account without one. */
async function readReviewState(
  read: ReviewReads, head: string, account: { login: string; id?: number }, requestedReviewers: readonly GithubUser[],
): Promise<{ verdict?: HeadVerdict; request?: ReviewRequest }> {
  const named = (user: GithubUser | null | undefined) => Boolean(user) && user!.login.toLowerCase() === account.login.toLowerCase();
  const isAccount: IsAccount = (user) => named(user) && (account.id === undefined || user?.id === undefined || user.id === account.id);
  const onHead = lastVerdictOnHead(await read.reviews(), head, (user) => named(user) && (account.id === undefined || user?.id === account.id));
  const pending = requestedReviewers.some(isAccount);
  if (!onHead && !pending) return {};
  const events = await read.events();
  const request = pending ? pendingRequest(events, isAccount) : undefined;
  if (!onHead) return { request };
  return { request, verdict: judgeVerdict(onHead, headChangedAt(await read.committerDate(), events)) };
}

/** The account's last APPROVED or CHANGES_REQUESTED on the head; a later
 * DISMISSED withdraws it. GitHub lists reviews in submission order. */
function lastVerdictOnHead(reviews: readonly GithubReview[], head: string, isReviewer: IsAccount): GithubReview | undefined {
  const last = reviews.filter((review) => isReviewer(review.user) && review.commit_id === head &&
    ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)).at(-1);
  return last && last.state !== "DISMISSED" ? last : undefined;
}

/** The latest request naming the account, unless a later removal withdrew
 * it. Issue events are in the order of their ids. A request through a team
 * names no account and keeps the head's own obligation. */
function pendingRequest(events: readonly GithubIssueEvent[], isAccount: IsAccount): ReviewRequest | undefined {
  const latest = events.filter((event) => ["review_requested", "review_request_removed"].includes(event.event) &&
    event.id && isAccount(event.requested_reviewer)).at(-1);
  const at = Date.parse(latest?.created_at ?? "");
  if (latest?.event !== "review_requested" || !Number.isFinite(at)) return undefined;
  return { eventId: latest.id!, at, createdAt: latest.created_at, requester: latest.review_requester?.login ?? latest.actor?.login ?? "" };
}

/** When the head last changed: its committer date, or a later force push,
 * which GitHub timestamps itself (a committer date can be set back). An
 * unknown date counts as never settled, so a verdict never passes on a guess. */
function headChangedAt(committerDate: string | undefined, events: readonly GithubIssueEvent[]): number {
  const committed = Date.parse(committerDate ?? "");
  const pushed = events.filter((event) => event.event === "head_ref_force_pushed").map((event) => Date.parse(event.created_at)).filter(Number.isFinite);
  return Math.max(Number.isFinite(committed) ? committed : Number.POSITIVE_INFINITY, ...pushed);
}

function judgeVerdict(review: GithubReview, changedAt: number): HeadVerdict {
  const submitted = Date.parse(review.submitted_at ?? "");
  return { state: review.state, submittedAt: review.submitted_at ?? "", current: Number.isFinite(submitted) && submitted > changedAt };
}

/** A native run's status while it still holds the pull request. */
export const ACTIVE_RUN: readonly string[] = ["queued", "running", "waiting"];

/** The webhook delivery id of an intake key: the key itself, hashed when long. */
export function deliveryIdFor(key: string): string {
  const id = `gh:${key}`;
  return id.length <= 200 ? id : `gh:${createHash("sha256").update(key).digest("hex")}`;
}

/** Whether a native run's delivery id may be work on this pull request. An id
 * that names no pull request (a hashed key, or none) may be any of them. */
export function deliveryConcerns(deliveryId: string | undefined, repository: string, number: number): boolean {
  const match = /^gh:(?:review|own|assignment|publish):(.+)#(\d+)[@:]/.exec(deliveryId ?? "");
  if (!match) return true;
  return match[1].toLowerCase() === repository.toLowerCase() && Number(match[2]) === number;
}

/** A head-only delivery from before reviews recorded their obligation answers
 * a request only when made this long after it: GitHub's request time has
 * one-second resolution and this Environment's clock may differ from GitHub's.
 * Closer, the request is delivered, at the cost of at most one more review. */
export const LEGACY_COVER_MARGIN_MS = 60_000;

interface DeliveryRecord {
  key: string; at: number; kind: string; outcome: string; repository: string; number: number; headSha?: string; obligation?: "head" | "request";
}

export type ReviewPlan<T> =
  | { action: "answered"; reason: string }
  | { action: "covered"; record: T }
  | {
    action: "deliver"; key: string; reason: string; requester: string;
    record: { obligation: "head" | "request"; requestEventId?: number }; extras: Record<string, JsonValue>;
  };

/** Nothing while a current verdict is newer than any pending request (GitHub
 * timestamps have one-second resolution, so a request in the verdict's second
 * does not reopen it). Otherwise one review, keyed by the request that asks
 * for it or, without one, by the head, unless a delivery already covers it:
 * one with that key; without a request, any delivery of the head; for a
 * request, also a head-only delivery recorded before obligations were
 * (`LEGACY_COVER_MARGIN_MS`). A delivery for another request never covers it. */
export async function reviewPlan<T extends DeliveryRecord>(read: ReviewReads, input: {
  repository: string; number: number; head: string; author: string; roles: ReadonlySet<string>;
  account: { login: string; id?: number }; requestedReviewers: readonly GithubUser[]; records: readonly T[];
}): Promise<ReviewPlan<T>> {
  const { repository, number, head } = input;
  const requested = input.roles.has("requested") ? input.requestedReviewers : [];
  const { verdict, request } = await readReviewState(read, head, input.account, requested);
  if (verdict?.current && !(request && request.at > Date.parse(verdict.submittedAt))) {
    return { action: "answered", reason: `${verdict.state} already on this head` };
  }
  const headKey = `review:${repository}#${number}@${head}`;
  const key = request ? `${headKey}~request:${request.eventId}` : headKey;
  const record = [...input.records].reverse().find((entry) => entry.kind === "review" &&
    ["delivered", "duplicate", "needs_recovery"].includes(entry.outcome) &&
    entry.repository.toLowerCase() === repository.toLowerCase() && entry.number === number && entry.headSha === head &&
    (entry.key === key || !request ||
      (entry.key === headKey && entry.obligation === undefined && entry.at >= request.at + LEGACY_COVER_MARGIN_MS)));
  if (record) return { action: "covered", record };
  const reason = verdict?.current ? "review_rerequested"
    : input.roles.has("requested") ? "review_requested" : input.roles.has("reviewed") ? "reviewed_before" : "organization_scope";
  return {
    action: "deliver", key, reason, requester: request?.requester || input.author,
    record: request ? { obligation: "request", requestEventId: request.eventId } : { obligation: "head" },
    extras: {
      ...(request ? { request: { event_id: request.eventId, requester: request.requester, created_at: request.createdAt } } : {}),
      ...(verdict ? { last_verdict: { state: verdict.state, submitted_at: verdict.submittedAt, after_head_change: verdict.current } } : {}),
    },
  };
}
