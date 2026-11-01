# GitHub intake (Lazurio MausBot)

The GitHub intake lets a bot team work on GitHub pull requests without
anyone opening the app. Plain code polls GitHub under the Environment's
signed-in `gh` CLI and hands a bot only real work: a review request, a new
head on a pull request it reviewed, or an explicit publication instruction.
No model runs while there is nothing to do.

It is a standard feature of Lazurio MausBot, not tied to one persona: any
operator can turn it on, for example for the pull requests sent to them.
The Steward team in [`lazurio/teams/steward.openmaus.json`](../lazurio/teams/steward.openmaus.json)
is the team Lazurio Organizations run behind it (Lazurio decision 0169,
plan DEV-6632).

## Turning it on

The intake is off unless the server starts with `OMB_GITHUB_INTAKE=1`. Unset,
the server behaves exactly as upstream OpenMausBot.

| Variable | Meaning |
| --- | --- |
| `OMB_GITHUB_INTAKE` | `1` turns the intake on. Unset, empty, `0` or `false`: off. |
| `OMB_GITHUB_INTAKE_BOT` | Required. The id, or the exact name (case-insensitive), of the bot that receives the work, normally a team leader. |
| `OMB_GITHUB_INTAKE_SCOPE` | `requested` (default) or `organization`; see Triggers. |
| `OMB_GITHUB_INTAKE_OWNERS` | Comma-separated owner logins. Only their repositories count, for every trigger. Unset: any owner. |
| `OMB_GITHUB_INTAKE_EXCLUDE` | Comma-separated `owner/repo` patterns (`*` matches anything) left out of the `organization` scope, e.g. `acme/infra,acme/productionspace-*`. |
| `OMB_GITHUB_INTAKE_INTERVAL_SECONDS` | Poll interval, default 90, bounded to 30–3600. |
| `OMB_GITHUB_INTAKE_ASSIGNMENTS` | `1` enables assignment handoff as the scoped completion/merge mandate. Off by default for an explicit migration; only assignments after first activation qualify. |
| `OMB_GITHUB_INTAKE_DEPLOYMENTS` | Comma-separated exact `owner/repo` list whose workflow runs waiting for a deployment approval the intake reads; see Deployment approvals. Unset: none. |
| `OMB_GITHUB_INTAKE_GH` | The `gh` executable; default `gh` on `PATH`. |

An unknown value stops the server at start with the reason. Example for a
new Lazurio Environment whose persona reviews one Organization:

```sh
OMB_GITHUB_INTAKE=1 \
OMB_GITHUB_INTAKE_BOT=Henry \
OMB_GITHUB_INTAKE_OWNERS=acme \
openmausbot serve
```

**Start with `requested`** (Organization Admin decision, issue #5). A new
Environment keeps the default scope and reviews only pull requests that
request the account. `organization` is a later, deliberate switch: its first
poll finds every open ready pull request the account can push to and queues
a review for each, a wave of reviews and model cost. When switching, set
`OMB_GITHUB_INTAKE_EXCLUDE` as well, for example
`acme/infra,acme/productionspace-*`.

**Identity.** The intake runs `gh api` as the server's user and has no token
of its own. Sign that user in once (`gh auth login`); every GitHub action of
the intake and of the bots is then that account's. If `gh` is missing or not
signed in, the intake reports it and does nothing until it is.

**The target bot** may be created after the server starts (for example by
importing the Steward team): until a bot with that id or name exists, the
intake reports `no_target` and does not query GitHub beyond the account.
Two bots with the same name are refused; use the id then. A persona other
than Henry imports the same team, renames its leader and sets
`OMB_GITHUB_INTAKE_BOT` to the new name.

## Triggers

Every trigger needs an open pull request. Drafts are skipped until they are
marked ready.

**Review** fires once per pull request and head SHA, and once per explicit
request (below); a new head fires again. A pull request is picked when:

1. the account is a requested reviewer (directly or through a team); or
2. the account reviewed it before (it keeps following it, so a push after
   *changes requested* is reviewed without a new request); or
3. with `OMB_GITHUB_INTAKE_SCOPE=organization`, it is in a repository the
   account can push to, is not archived and does not match
   `OMB_GITHUB_INTAKE_EXCLUDE`.

A review is also not handed over while the account's verdict on the head
is current and no explicit request came after it.

### Verdicts and explicit requests

- **A verdict is current** when the account's last `APPROVED` or
  `CHANGES_REQUESTED` (a later `DISMISSED` withdraws it) has `commit_id`
  equal to the head **and** its `submitted_at` is later than the head's last
  change. GitHub carries an `APPROVED` onto a new head whose diff did not
  change, a base merge or a content-identical rebase, and keeps the old
  `submitted_at`; such a record is no verdict on the new head. The head's last
  change is the later of its committer date (`GET repos/{repo}/commits/{sha}`)
  and the latest `head_ref_force_pushed` issue event, which GitHub timestamps
  itself, so a committer date set back does not hide a rebase. An unknown
  date counts as a change after every verdict.
- **An explicit request** is the latest `review_requested` issue event naming
  the account (`requested_reviewer`), not followed by a
  `review_request_removed`, while the pull request still lists the account in
  `requested_reviewers`. Its event id is its identity. When it is newer than
  the current verdict (one-second resolution: a request in the verdict's
  second does not count), the intake queues one re-review of the exact current
  head with `reason: review_rerequested`, also on an unchanged head. A comment,
  even the author's answer, is not a request. A request through a team names
  no account; it is handled as before, once per head.
- **Identity.** A review answering a request is keyed
  `review:<repo>#<n>@<head>~request:<event id>`; one without a request keeps
  `review:<repo>#<n>@<head>`. The key is the webhook delivery id, so repeated
  polls, a restart or a lost state file never queue a request twice (the
  webhook's receipt answers `duplicate`), and a new request never meets the
  receipt of an earlier delivery of the same head. A request is answered only
  by a delivery with its own key: a delivery for another request never covers
  it, even within the same second. Each review record names its `obligation`
  (`head` or `request`). A head-only record without one was written before
  requests had keys; it answers a request only when recorded at least 60
  seconds after the request's GitHub time, because that time has one-second
  resolution and the Environment's clock may differ from GitHub's. Closer than
  that, the request is delivered, at the cost of at most one more review after
  an upgrade.
- **Safety.** While a native run of the pull request is queued, running or
  waiting, nothing new is queued for it; a moved head or a newer request is
  delivered once that work ends. The intake finds that run through its own
  records, and also in the server's native queue by the intake webhook's id and
  the run's delivery id, so a lost state file does not start a concurrent
  review. A run whose delivery id names no pull request (a key longer than 200
  characters is hashed) counts as work on every pull request until it ends. A request removed while its run waits leaves
  the run to finish and queues nothing more; a delivered request whose native
  run ended without a current verdict reports `needs_recovery` and is not
  replayed. A later request is the requester's explicit retry and gets its
  own delivery.
- **Bounds.** Requests and force pushes come from the first 1 000 issue
  events; on a longer history a newer request is not seen and the head's own
  rule applies.

Every outcome of a request is in the status's `recent` list with
`requestEventId` and the requester. Telling the requester on the pull request
which state their request is in (queued, in progress, the verdict, or why it
waits) belongs to the intake's existing reply on the pull request
(Lazurio/OpenMausBot#82), not to a second channel.

**The account's own pull requests are never reviewed by it.** The intake
records them as `needs_human_approval` (in the status and the log) and starts
no bot turn: a person approves them.

**Assignment handoff**, enabled by `OMB_GITHUB_INTAKE_ASSIGNMENTS=1`,
queues one completion task for a current assignment from a live repository
writer. It needs the immutable GitHub assignment event, actor and recipient
IDs, matching live writer identity, and the signed-in recipient. The REST issue-events
reader takes the initiating actor from `assigner`, never the endpoint’s `actor`
(which may be the recipient). Missing `assigner` fails closed; timeline events
are a different projection. Self-assignment
is not a mandate. No `/lazurio publish` comment is required: the assignee owns
bounded repairs, verification and permitted merge, or an explicit transfer to
the next authorized assignee. Review requests alone remain review-only.

First activation persists `assignmentActivatedAt` in the existing intake
state. Historical assignments do not silently become publication consent;
reassign those PRs explicitly. Restart preserves that boundary and the event
receipt. Drafts wait for Ready. A removed/replaced assignment revokes its
handoff. Before merging the worker must recheck the current assignment event,
immutable identities, live rights and current-head repository gates. Owner-only
merge rules still apply; Free repositories use the same process agreement.

Steward team **1.1.1** makes that provider-field check explicit in the worker's
shared instructions. A real assignment can pass intake correctly and still
be returned incorrectly if the worker re-reads issue-events and mistakes its
`actor` for the initiator. Workers must compare REST `assigner.id`, recipient
`assignee.id` and live rights; they must not infer self-assignment from the
recipient-shaped `actor`. This does not relax any authorization check.

The portable team has its own release number. An explicitly authorized update
of an existing team reconciles the changed shared-instruction block through
the native section-context API, preserving Organization context, bot IDs,
history, models and grants. Importing a fresh team is not a migration of an
existing one. This instruction-only update needs no new server behavior,
receipt reset, activation cutoff or runtime restart; independently verify the
next real assignment before claiming the worker behavior is fixed.

Steward team **1.1.2** sets the review bar in the same shared instructions
(Organization Admin decision of 2026-10-30). A worker requests changes only
for a real defect the pull request introduces or leaves and approves with
everything else as non-blocking notes, reports every finding in one review
grouped as "Blocking" and "Non-blocking", and files a finding outside the
pull request's purpose as an issue in the owning repository instead of
blocking on it. An approval carries its non-blocking notes in the review body.
A worker keeps exactly one clone of a repository that is not in the Lazurio
Folder, outside the Folder. It removes the pull request's worktree and local
branch as soon as its verdict is on GitHub or the work stops, unless the
worktree holds commits or changes that are not pushed: then it keeps the
worktree and names exactly what is unpushed in its result. An existing team
takes 1.1.2 through the same explicitly authorized update of its
shared-instruction block; its next real review on GitHub shows whether the team
follows it.

An assignment is not authority for separate releases, infrastructure applies,
repository settings or credentials. The shipped team explains these bounds.

A PR with a qualifying assignment gets one completion task rather than a
concurrent review task. The same assignment is not automatically replayed:
if its native run ends while the PR remains open and assigned, the status
shows `needs_recovery`. Check native workers and the actual PR before a new
handoff. In-flight delegated work must not be duplicated.

**Legacy publication comments** remain compatible. This path fires once per
instruction comment when all of these hold:

- the pull request is assigned to the account;
- a comment on the pull request (its conversation, not a review comment)
  contains the line **`/lazurio publish`**: exactly that, on a line of its
  own, not quoted and not in a code block (CommonMark: a fence closes only with
  the same character at least as long, and a line indented four spaces or a
  tab is code);
- the comment's author has the `write`, `maintain` or `admin` role on the
  repository and is not the account itself;
- the comment was written after the latest assignment to the account; GitHub
  timestamps have one-second resolution, so a comment in the same second as
  the assignment does not count. The latest assignment comes only from the
  complete event history: a pull request with more than 1 000 issue events
  fails closed (`error`) instead of trusting an older assignment.

With assignment handoff disabled, assignment alone does not publish. An instruction that fails a check is
recorded as `ignored` with the reason and is never retried; the person asks
again with a new comment. The bot still checks approvals and required checks
before it merges (see the Steward team).

### Deployment approvals

Lazurio decision 0218 (addendum of 2026-11-01) has three handoffs between
agents: a review request, an assignment, and being a required reviewer of the
GitHub Environment where a production step waits. The third is how Pablo
approves the releases of Lazurio lines. With `OMB_GITHUB_INTAKE_DEPLOYMENTS`
set, each poll reads those repositories' runs that wait for a deployment
(`GET repos/{repo}/actions/runs?status=waiting`, then
`.../runs/{id}/pending_deployments`).

- **Which.** Each environment of a waiting run that GitHub lets the account
  approve (`current_user_can_approve`) is handed over once, keyed
  `deployment:<repo>:<run id>:<environment id>` through the intake key and
  the webhook's delivery receipt. Repeated polls, a restart or a lost state
  file never deliver it twice.
- **Never its own.** A run the account itself started is recorded as `ignored`
  and never handed over (`prevent_self_review` keeps that approval with
  another reviewer anyway).
- **Drops out.** A run that no longer waits (approved, rejected or cancelled
  by anyone) drops out with no recovery noise.
- **Recovery.** A handed-over approval whose native run ended while the
  deployment still waits reports `needs_recovery`; nothing is handed over
  again on its own.
- **Every page, every repository.** Waiting runs are read page by page, up
  to 1 000 per repository. Past that, or when a later page can't be read,
  the runs already read are still handed over, and the rest is reported as
  an `error` rather than skipped. A failed pull request search doesn't stop
  the deployments being read: they are handed over, the poll ends in `error`
  and backs off as before, and what earlier polls settled stays settled. A
  repository or run that can't be read (403, 404, a server error) is an
  `error` too, and every other approval of the poll is still handed over. A
  failed lookup of the commit's pull request hands the approval over without
  `pull_request`.
- **Bounds.** The intake only hands the approval over. The team decides it
  with `gh`, according to the webhook's instructions and its standing
  mandate, and says on the pull request what it decided. Without a mandate
  it approves nothing. A repository outside this list is never read, so
  approvals there wait for their people.

## What the bot receives

The intake keeps one webhook named **GitHub intake** for the target bot
(visible under Automations; it creates it on first use and moves it when the
target changes) and delivers each event through it, in-process. The event
takes the same path as an HTTP webhook delivery: the same queue behind a
busy bot, delivery receipts, the pending-run limit (6 for this webhook) and
rate limit, the attempt log, and the same prompt shape, the webhook's
instructions followed by the event in an `UNTRUSTED WEBHOOK EVENT DATA`
block:

```json
{
  "source": "lazurio-github-intake",
  "kind": "review",
  "reason": "review_requested",
  "account": "henry-bot",
  "repository": "acme/app",
  "number": 42,
  "url": "https://github.com/acme/app/pull/42",
  "head_sha": "…",
  "base_ref": "main",
  "title": "…",
  "author": "alice",
  "requester": "alice"
}
```

`reason` is `review_requested`, `review_rerequested`, `reviewed_before`,
`organization_scope`, `publish_instruction` or `assignment_handoff`. A review
that answers an explicit request carries
`request: {event_id, requester, created_at}`, and one on a head where the
account has a verdict carries
`last_verdict: {state, submitted_at, after_head_change}`. `assignment_handoff` carries
`assignment: {event_id, actor, actor_id, assignee, assignee_id, created_at}`. `requester` is the request's actor for an explicit request, otherwise the pull request's author for a review
and the instruction's author for a publication, which also carries
`instruction: {comment_id, url, author, created_at, marker}`. The event name
is `github.review`, `github.publish` or `github.deployment`.

A deployment event has `kind: "deployment"`, `reason: "deployment_review"`,
`run: {id, url, head_sha, workflow, head_branch, event, started_by,
started_by_id}`, `environment: {id, name}` and, when the commit belongs to a
pull request, `pull_request: {number, url}`. Its record's `number` is the
workflow run id. An intake webhook made before deployments gets the
`github.deployment` event type and, unless an operator changed them, the
current instructions on the next delivery.

Pausing the webhook prevents new delivery and **cancels queued runs** in
upstream's native queue. A full queue defers not-yet-accepted work; the intake
tries once per poll, not once per pull request. Accepted delivery is not
completion. The intake reads native run receipts even when GitHub's
`updated_at` did not change. If a coordinator ended or disappeared without a
current-head GitHub verdict, it reports `needs_recovery` with the PR, run and
next action. It does not replay work that may still have delegated workers.
A late worker verdict resolves the status without another review. Publication
recovery remains distinct: verify the current assignment and PR, never retry
a publication as a review or erase deduplication receipts.

**The pull request hears it.** When a review run ends without a current-head
verdict, the intake posts one conversation comment on the pull request as the
account, signed with the target bot's name like the team's reviews
(`— Henry`). It names the head the run was for and what the author can do:
push a new head, or ask the person responsible for the persona to start the
review again. The intake does not start the review again itself. There is one
comment per head: a `notified` record keyed
`recovery-notice:<repo>#<n>@<head>` in the intake state keeps later polls and
restarts from repeating it. Without that record (pruned after 180 days or
10 000 records, or the state file lost), the intake reads the pull request's
conversation first and takes the account's own earlier comment for that head
as the notice instead of posting another. A conversation of 1 000 comments or
more cannot be read completely, so there the intake posts nothing (it fails
closed, as on a long assignment history) and the pull request stays
`needs_recovery`. A comment GitHub refuses (a rate limit, a missing
permission) changes nothing else: the pull request stays `needs_recovery`,
the other pull requests are handled as before, and a later poll posts the
comment. An assignment handoff that ends without a result gets no comment.

## Polling, limits and state

- One poll at a time, every interval. On a GitHub rate limit, or when GitHub
  cannot be asked at all, the interval doubles up to 30 minutes and returns
  to normal after a good poll. A single pull request that fails is retried
  next poll without slowing the rest.
- At most four `gh` calls run at once.
- An idle poll asks GitHub who the account is and runs three searches (plus
  one per owner in the `organization` scope; the list of pushable
  repositories is refreshed every 15 minutes). Details of a pull request are
  fetched only when its `updated_at` changed since it was last handled. A
  review decision reads the pull request's reviews; its issue events only
  while the account is requested or has a verdict on the head, and the head
  commit only for such a verdict.
- State lives in `<data>/github-intake.json` (mode 0600): the handled keys
  with their outcome and the webhook id. It is restart-safe. If it is lost,
  the webhook's own delivery receipts still stop a second run for the same
  event (for 7 days), and an existing verdict on the head stops a repeated
  review. Every write of the file, like every delivery, claims the server's
  maintenance gate: while a workspace backup or a pending restore owns the
  quiet workspace the file stays untouched and nothing is delivered; the
  state waits in memory for the next poll after it.

## Status

`GET /api/github-intake` returns `{enabled: false}` or the state (`ok`,
`gh_missing`, `gh_signed_out`, `no_target`, `paused`, `queue_full`,
`rate_limited`, `needs_recovery`, `error`), the account, the target bot, the webhook id, the
configuration, `lastPollAt`, `lastSuccessAt`, `nextPollInMs`, `lastError`,
`needsRecovery` (how many open pull requests are in `needs_recovery`, as of
the last poll that read them) and the 50 most recent outcomes (`delivered`,
`duplicate`, `already_reviewed`, `needs_human_approval`, `needs_recovery`,
`notified`, `ignored`); a review that answers an explicit request names its
`requestEventId`. `lastError` names every problem of the poll, so a recovery
doesn't hide a read failure beside it. Status also exposes
`assignmentHandoff` and its persisted `assignmentActivatedAt`. `POST /api/github-intake/poll` polls now
and returns the poll summary with the status. Both need the admin scope
(the owner on loopback). The server log carries `[github-intake]` lines for
changes of state, deliveries, own pull requests, ignored instructions and
recovery comments, posted or refused.

## Security notes

- **Loopback is the owner.** OpenMausBot trusts a loopback request without
  forwarding headers as its owner (a browser is not, upstream #2930), so any process of the Environment's user can read the status,
  trigger a poll or steer the bots. That is the same boundary as the rest of
  the Environment. A gateway in front of the app must require sign-in, and
  the port must never be exposed.
- **GitHub content is untrusted.** Titles, names and comments reach the bot
  only inside the untrusted block, and the webhook's instructions tell it to
  treat them as data. The intake itself acts only on GitHub facts (review
  requests, assignees, repository roles, SHAs), never on free text, except
  for the exact publish marker from a writer.
- **The account's rights are the limit.** The intake adds no permission: a
  bot can only do what the signed-in account may do on GitHub. Give the
  account write only where it should review and publish; branch rules stay
  the enforcement, the team's standing instructions the process.
- **Approval levels.** Unattended bots run with their own approval level;
  the intake changes none. Steward teams run on Full access without a
  sandbox (Organization Admin decision of 2026-10-01, issue #3): the
  Environment, one Machine with one operator, is the boundary. Full is
  upstream's default for new and imported bots (#2808), so nothing needs to
  be set. Every intake delivery opens a new conversation, which starts at the
  bot's level, and the leader's delegated work runs Full too. Questions and
  missing credentials still wait for the operator.


## Contract and verification

The 12 October 2026 Operator decision makes GitHub assignee the ordinary
handoff for people and personas. The existing webhook queue and native
execution receipts remain the only scheduler and work ledger. A second
comment would duplicate intent; treating every reviewed PR as mergeable
would discard the concrete handoff. The activation boundary prevents an
upgrade from executing old assignments made under the previous contract.

`server/github-intake.test.ts` exercises GitHub-shaped events, identities,
live roles, review-only requests, migration, reassignment, pause/restart,
late verdicts, carried approvals, repeated requests on one head and the one
comment per head after a review run without a verdict through the real
WebhookManager; `server/github-intake-review.ts` decides which review is owed
and `server/github-intake-gh.ts` runs the signed-in `gh`. `github-intake.e2e.test.ts`
runs the isolated real server and exercises the native queue and execution
receipts with fake GitHub and model providers.
These fixtures do not claim that a real GitHub merge or deployment occurred;
that evidence belongs to each commissioned Environment.
