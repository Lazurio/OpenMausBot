# A bot's question reaches the person in T3 Code

Status: shaping and implementation in progress. Contract: [#101](https://github.com/Lazurio/OpenMausBot/issues/101).

## Intent and choice

Automate runs autonomously. A bot that needs a person opens a normal chat in
T3 Code on the same Environment. That chat uses its question tool; the
answer returns to the bot without a supervising thread. A pending question
never grants consent to an action or treats silence as an answer.

Use one `ask_person` tool for all engines. It supplies the question, 2–4
options, the related issue/PR link and what the bot does meanwhile. Native
engine questions already use `request.opened` → `waiting-on-you`; relay them
through the same receipt path as well, so an engine's own question cannot
remain unseen. The existing card and answer delivery remain the source-side
interaction. An explicit tool is necessary because engines without a native
question tool otherwise only produce ordinary text. Automatic detection of
questions in prose would guess intent and cannot reliably carry the default
or issue link. A publication choice has no recommended answer.

The relay is a durable delivery receipt, not another authority for bot work.
It records the source bot, thread, request, T3 thread and verbatim answer.
MausBot reads the saved answer from the authenticated T3 CLI, bound to the
first T3 request matching the supplied question texts in this fresh relay thread. No HTTP caller supplies
an answer or declares it human-authored. Once
the provider request ends, a late answer is delivered as a new message with
the question id. First answer wins across both channels; retries return the
receipt. Deleted bots and failed delivery remain visibly unresolved.

## Existing T3 capabilities and idempotency

Probe `t3 lazurio capabilities`; require `agentCli` and `requestHistory`. Use `t3 thread launch`
in the Environment's Lazurio Folder project, and `t3 request history` to read persisted request status and answers. When
the other channel answered, settle only the exact bound request id, never
a later question in that chat. Never read T3's
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
- An archived, failed or completed chat without a saved answer leaves the question
  open and reports it to the bot; it is never interpreted as refusal.
- A late answer after the source request is actually unavailable becomes a new bot message.
  A native `rejected` outcome remains an explicit rejected-delivery record and
  never becomes a successful late message or an automatic retry. A
  stopped/deleted bot or a delivery failure is reported, never called resumed.
- Persist receipts before externally visible delivery and retain recoverable
  delivery errors across restart. Tests cover crash boundaries and races.

Waiting for an event uses an interval with no `endsAt` by default. The bot uses `manage_trigger` at escalation to change the interval, preserving
the existing routine rather than scheduling a replacement. An
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

The CLI history capability exposes the running server's existing persisted
question state; it changes no server route, data or authentication. Older
CLIs without this capability report `ask-person-unavailable`. A qualified
CLI is a rollout dependency; it does not authorize restarting a live T3
service. Like other Environment tools, it acts within the shared account's
rights; this is no isolation boundary between Full-access agents.
