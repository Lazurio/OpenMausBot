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

**Review** fires once per pull request and head SHA; a new head fires again.
A pull request is picked when:

1. the account is a requested reviewer (directly or through a team); or
2. the account reviewed it before (it keeps following it, so a push after
   *changes requested* is reviewed without a new request); or
3. with `OMB_GITHUB_INTAKE_SCOPE=organization`, it is in a repository the
   account can push to, is not archived and does not match
   `OMB_GITHUB_INTAKE_EXCLUDE`.

A review is also not handed over when the account already submitted
`APPROVED` or `CHANGES_REQUESTED` on that exact head.

**The account's own pull requests are never reviewed by it.** The intake
records them as `needs_human_approval` (in the status and the log) and starts
no bot turn: a person approves them.

**Publication** fires once per instruction comment when all of these hold:

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
  the assignment does not count.

Assignment alone never publishes. An instruction that fails a check is
recorded as `ignored` with the reason and is never retried; the person asks
again with a new comment. The bot still checks approvals and required checks
before it merges (see the Steward team).

## What the bot receives

The intake keeps one webhook named **GitHub intake** for the target bot
(visible under Webhooks; it creates it on first use and moves it when the
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

`reason` is `review_requested`, `reviewed_before`, `organization_scope` or
`publish_instruction`. `requester` is the pull request's author for a review
and the instruction's author for a publication, which also carries
`instruction: {comment_id, url, author, created_at, marker}`. The event name
is `github.review` or `github.publish`.

Pausing the webhook pauses the intake: work stays pending and is delivered
when it is enabled again. So does a full queue; the intake then tries once
per poll, not once per pull request.

## Polling, limits and state

- One poll at a time, every interval. On a GitHub rate limit, or when GitHub
  cannot be asked at all, the interval doubles up to 30 minutes and returns
  to normal after a good poll. A single pull request that fails is retried
  next poll without slowing the rest.
- At most four `gh` calls run at once.
- An idle poll asks GitHub who the account is and runs three searches (plus
  one per owner in the `organization` scope; the list of pushable
  repositories is refreshed every 15 minutes). Details of a pull request are
  fetched only when its `updated_at` changed since it was last handled.
- State lives in `<data>/github-intake.json` (mode 0600): the handled keys
  with their outcome and the webhook id. It is restart-safe. If it is lost,
  the webhook's own delivery receipts still stop a second run for the same
  event (for 7 days), and an existing verdict on the head stops a repeated
  review.

## Status

`GET /api/github-intake` returns `{enabled: false}` or the state (`ok`,
`gh_missing`, `gh_signed_out`, `no_target`, `paused`, `queue_full`,
`rate_limited`, `error`), the account, the target bot, the webhook id, the
configuration, `lastPollAt`, `lastSuccessAt`, `nextPollInMs`, `lastError` and
the 50 most recent outcomes (`delivered`, `duplicate`, `already_reviewed`,
`needs_human_approval`, `ignored`). `POST /api/github-intake/poll` polls now
and returns the poll summary with the status. Both need the admin scope
(the owner on loopback). The server log carries `[github-intake]` lines for
changes of state, deliveries, own pull requests and ignored instructions.

## Security notes

- **Loopback is the owner.** OpenMausBot trusts every loopback request as
  its owner, so any process of the Environment's user can read the status,
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
  sandbox (Organization Admin decision of 2026-10-01, issue #3, superseding
  Auto): the Environment, one Machine with one operator, is the boundary.
  The operator starts the service with `OMB_HEADLESS_FULL_ACCESS=1` and sets
  each bot to Full after the import
  ([self-hosting](self-hosting.md#full-access-without-the-desktop-app));
  Machines never sets it. Every intake delivery opens a new conversation,
  which starts Full, and the leader's delegated work runs Full too.
  Questions and missing credentials still wait for the operator.
