# A bot's question reaches the person in T3 Code

Status: shaping and implementation in progress. Contract: [#101](https://github.com/Lazurio/OpenMausBot/issues/101).

## Intent and choice

Automate runs autonomously. A bot that needs a person opens a normal chat in
T3 Code on the same Environment. That chat uses its question tool; the
answer returns to the bot without a supervising thread. A pending question
never grants consent to an action or treats silence as an answer.

Use the existing `request.opened` → `waiting-on-you` path, rather than add a
second ask tool. It already owns the question, its provider request id, card,
answer delivery and activity. A new tool would make bots choose between two
ways of asking and leave native engine questions unseen. Only questions are
relayed; permission requests keep their existing gates. The bot includes its
context, 2–4 options (recommended first where appropriate), the issue/PR link,
and what it continues with meanwhile in the question. A publication choice
has no recommended answer.

The relay is a durable delivery receipt, not another authority for bot work.
It records the source bot, thread, request, T3 thread and verbatim answer.
A reply endpoint uses the same native answer path as the MausBot card. Once
the provider request ends, a late answer is delivered as a new message with
the question id. First answer wins across both channels; retries return the
receipt. Deleted bots and failed delivery remain visibly unresolved.

## Existing T3 capabilities and idempotency

Probe `t3 lazurio capabilities`; require `agentCli`. Use `t3 thread launch`
in the Environment's Lazurio Folder project, and `t3 request` to inspect or
settle a pending question when the other channel answered. Never read T3's
database, reconfigure it or restart its service.

The source thread/request pair identifies one question. Persist intent before
launch. T3's launch CLI currently has no idempotency flag. Give the chat a
unique question marker, reconcile it with `t3 thread list --title`, and never
blindly relaunch an ambiguous attempt. Serialize processing and reconcile
across restart. An interrupted launch that cannot be found stays a reported
failure: avoiding duplicate questions takes precedence over automatic retry.

## Failures and proof

- Missing CLI/capability or offline T3: `ask-person-unavailable`, with the
  original question retained in MausBot and a visible failure on the run.
- Ambiguous launch: reconcile by question marker, otherwise keep the failed
  receipt for operator recovery. No second chat from an ordinary retry.
- Free text is returned verbatim, including newlines and shell characters.
- An answer in MausBot wins if first; T3 is informed. A later answer cannot
  overwrite the first. A provider timeout is not a person's answer.
- An archived, failed or completed chat without a callback leaves the question
  open and reports it to the bot; it is never interpreted as refusal.
- A late answer after the source turn ends becomes a new bot message. A
  stopped/deleted bot or a delivery failure is reported, never called resumed.
- Persist receipts before externally visible delivery and retain recoverable
  delivery errors across restart. Tests cover crash boundaries and races.

Waiting for an event uses an interval with no `endsAt` by default. An
escalation changes the cadence to a lower frequency, not to a hard end. The
routine continues until the event arrives or someone pauses it. The explicit
end of a genuinely finite routine remains available.

Contract tests use isolated servers and fake CLIs, including missing T3,
ambiguous launches, duplicate source events, concurrent answers, restarts,
free text, archive and late replies. Release proof is a question from the
real release bot, answered in T3 and resumed without a supervisor. This live
proof is separately authorized in #101's implementation task; test fixtures
never mutate a person's live bot.

Release uses the fork's existing contract: bot dispatches, persona approves,
then Ring 0 browser acceptance gates the next wave. A development deployment
lane waits for its operator's explicit instruction.
