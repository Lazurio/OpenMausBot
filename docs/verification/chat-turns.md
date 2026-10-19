# Chat turns

## Sub-features

- Create a bot through the normal profile boundary.
- Send to its selected task or an explicitly pinned owned task.
- Run two bot tasks independently, with separate models and approval modes.
- Keep waits, approval responses, and Stop pinned while task selection changes.
- Distinguish settled, failed, stalled, timed-out, and needs-user outcomes.
- Read a bounded, redacted transcript.

## User path

Create or select a bot in the sidebar, type in the composer, and send.
Starting or selecting another bot task does not stop the previous one.

## Driving it

```sh
pnpm control:omb new-bot --name Probe --url http://127.0.0.1:PORT
# Copy bot.id from the JSON above as BOT_ID.
pnpm control:omb send --bot BOT_ID --text "hello" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --limit 10 --url http://127.0.0.1:PORT
```

The wait result must be `settled`, and the messages result must contain the
fake engine's bot response. Use `--dry-run` on `send` when checking a target or
command without starting a turn.

## Gotchas

- Omitting `--task` snapshots the selected task before sending, waiting,
  reading, or stopping. Pass `--task THREAD_ID` to target another owned bot task
  without changing the selection. A channel send still requires its active task.
- `set-model --bot BOT_ID --task THREAD_ID --instance INSTANCE_ID --model MODEL_ID`
  changes only that idle task. Get exact available IDs from `control:omb models`.
  Without `--task`, the legacy model operation updates the bot default and its
  selected idle task, leaving other tasks unchanged.
- A bot working inside a channel must be awaited through that channel.
- `needs-user`, `failed`, and `stalled` are results, not successful settlement.

## Queued follow-up recovery

Accepted bot and channel follow-ups are committed to the transcript database
before acknowledgement. A normal restart restores only work whose dispatch has
not begun. A claimed dispatch has an uncertain outcome: retain the user's words
and a visible review notice instead of automatically repeating the action.
Cancellation receipts survive restart. Importing a workspace backup pauses all
of its queued work for review, even when restoring to the original directory.

```sh
pnpm exec vitest run server/chat-followups.test.ts server/chat-followups-restart.test.ts server/workspace-backup.test.ts
```

The restart test launches an isolated real server with the fake engine, accepts
queued bot/channel sends, kills only that fixture server, and starts a replacement
against the same disposable home. It checks original receipts, native image
content, reply targets, cancellation conflicts, one uncertain-dispatch notice,
and a second restart without replay. It records the fixture log and a retained
`.log.chat-followups-restart.json` receipt before removing the temporary home.
This does not prove resumption or cleanup of real provider sessions after a crash.

## Concurrent-task regression

### Hand-offs on the job runtime

Every hand-off between bots is an assignment on the job runtime
(docs/runtime-contract.md §9): `coordinate_bots` from a chat, a room, a
routine run, a webhook run, a goal run, a Cloud guest's turn or a standing
external runtime. There is no mailbox: a queued assignment is bounded by
the runtime's queue clock (§6, 24 hours, `failed(expired)` and reported), its
windows restart at boot, and nothing outside `server/runtime/` holds hand-off
state. The ledger the mailbox kept (`delegations.json`,
`delegation-receipts.json`) is imported once at boot and renamed `*.migrated`
(`server/runtime/import-legacy.ts`). A routine run waiting on teammates is
`waiting` while the runtime has outstanding assignments for its thread; the
run's resume is a routine turn; a restart reruns a cut teammate turn once (§5)
and keeps the run waiting instead of failing it. `assignment_status` reads an
assignment's status, outcome and result, or everything a conversation still
waits on; it is read-only and refuses an id handed out in the same turn.

```sh
pnpm exec vitest run server/runtime-paths.e2e.test.ts server/runtime-coordinator.test.ts server/runtime/import-legacy.test.ts
pnpm exec vitest run server/independent-threads-api.test.ts -t "holds coordinated work behind a peer's approval"
pnpm exec vitest run server/independent-threads-api.test.ts -t "unanswered|what became of each teammate approval"
pnpm exec vitest run server/comms.test.ts server/thread-capacity-api.test.ts -t "free slot"
```

The approval fixtures use the isolated launcher and per-model fake-engine
gates. A peer waits on a real approval-broker card. A card holds only its own
thread: fresh coordinated work waits only while the card's thread holds the
peer's last free slot, and then the Chief's conversation says once, in a
notice that never reads as running, whose card it waits behind and where, as
does the Chief's prompt. With a slot free, the work starts beside the open
card. Approving the card lets its own turn go on, and one attributed result
returns to the Chief without another user prompt. The approval cases follow a
teammate's cards through the broker's own course: the Chief's chip says
denied, or that nobody answered and the step did not run, never "got your
approval". The fixture fires the broker's fifteen-minute deadline through a
marker file (`server/testing/approval-clock-hooks.mjs`, loaded only when
`OMB_TEST_APPROVAL_CLOCK=1` reaches the isolated launcher). The result a
Chief's coordination, a routine run's hand-off and a room's coordinator each
read then leads with the action that did not run; a failed teammate turn
carries it after its failure, and an action the model asked again and was
allowed is not named. Exact control commands, waits, transcripts and the
server log path are retained in the fixture's `.log.json` evidence, without
capability tokens. The runtime's own suite (`server/runtime/*.test.ts`) covers
the queue clock, restart reconciliation and the invariants. These tests do not
claim real-provider performance.

### Independent tasks

```sh
pnpm exec vitest run server/independent-threads-api.test.ts
```

This test launches a fresh `control-omb` fixture for each case, wraps only its
fake engine with per-model completion gates, and uses the shared MCP/CLI surface
for pinned sends, waits, model changes, reads, and interrupts. It verifies two
tasks running under one bot, switching and creating while busy, separate model
and approval settings, stopping A without stopping B, transcript isolation, and
an unattended task remaining approval-blocked while its attended sibling runs.
It also exercises live provider capabilities against the memory-update route:
both sibling appends survive, stale replacements conflict, foreign ownership is
refused, and stopped-turn tokens expire without revoking the running sibling.
Provider working directories are checked against each task's private directory;
an explicitly shared project folder cannot launch a second engine until its
owner stops. On macOS, an inert computer descriptor inside the disposable home
checks lazy first-use ownership and exact-generation release through the real
control gate. It does not launch a desktop driver or prove actual UI actions.
The fixture prints its server log and a retained `.log.json` evidence path with
the exact control commands, wait results, and bounded transcripts. Its temporary
home is removed after the test.

See the [Threads renderer recipe](threads.md) for the real sidebar, composer,
optional folders, and group-history navigation checks.

## CLI Stop regression

```sh
pnpm exec vitest run server/kill-tree.test.ts server/engine-install.test.ts server/cli-stop.e2e.test.ts
```

The Stop fixture wraps only the isolated launcher's fake Claude CLI with an
owned helper that ignores TERM. It covers both a root that exits first and a
root that also ignores TERM: the task stays busy during the grace period,
settles only after both PIDs are gone, and accepts a subsequent message.
The printed `.log.json` retains exact control commands, waits, transcripts,
and PID checks. No real engine, account, or user's app data is used.

Focused process checks also cover concurrent stops, denied signals, unrelated
process safety, and bounded npm timeout errors. Codex's driver tests retain
task ownership after an uncertain stop until a verified retry.
POSIX group escalation and the
new server cases are skipped on Windows; its existing `taskkill /T /F` path
remains covered by the cross-platform child-tree test when run on Windows.
Windows event-order regressions also run on every host in
`server/kill-tree-windows.test.ts`: successful `taskkill` alone is not proof
that Node observed the child's exit. Both orders (exit before or after the
command callback) must settle without waiting for inherited pipes to close;
an unobserved exit still times out as uncertain.
Processes that intentionally detach into a different group are not owned by
this POSIX group-based cancellation.
