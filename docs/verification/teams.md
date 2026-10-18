# Teams and shared instructions

A team is a named membership group. It can be empty. Group chats are
conversations, and Templates is the catalog that creates new teams and bots.
The sidebar and Team map use the same persisted team list. Existing bot and
group-chat labels migrate automatically; clearing a team's shared instructions
or moving its last bot does not remove the team.

Run the isolated lifecycle checks:

```sh
pnpm exec vitest run server/team-lifecycle.e2e.test.ts server/section-context.test.ts server/store.test.ts src/lib/team-map.test.ts --maxWorkers=2
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-lifecycle-ui.e2e.test.ts scripts/testing/team-template-ui.e2e.test.ts --maxWorkers=1
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-canvas-ui.e2e.test.ts --maxWorkers=1
```

The server test uses `launchVerificationServer`, sends a sample conversation,
creates an empty team, moves two existing bots, saves shared instructions,
renames the populated team, adds and removes members, then empties and renames
it again. It imports a legacy template with a colliding name and restarts the
exact disposable server. It checks retained instructions and conversation
messages, archived bots moving to General when their team is deleted, and
explicit empty-team deletion. API requests and `control-omb` wait/messages
results are kept beside the fixture log in `*.team-lifecycle.json`.

A second real process restart uses legacy bot and group records needing
migration beside a deliberately malformed team registry. Startup keeps both
conversations readable and persists their task migrations, logs a diagnostic,
and leaves the malformed file byte-for-byte unchanged. Later team and shared
instruction writes still fail closed until that file is repaired.

The renderer test uses `control-omb ui launch`, opens **Create team**, and checks
that renaming preserves the sidebar's collapsed state and ordering. It moves
two bots through Team map, edits membership, and creates a bot directly in the
team. Dismissing that pending creation must retain unsaved membership edits and
select the created bot when its response arrives. It edits shared instructions
and reloads. A second fixture client moves the bots out; live updates retain the
empty team. Rename preserves instructions; delete confirms that the team's
instructions will be removed. A delayed, failed deletion cannot be submitted
twice and remains retryable; confirmation focus stays contained and returns to
its trigger when dismissed. It captures
`.omb-scratch/verify-evidence/team-lifecycle.png` before deletion.
New lifecycle labels use the existing string catalog; untranslated packs fall
back to the English labels without changing or regenerating other translations.

The test retains its before/after receipts and dark/light screenshots beside
the fixture log as `*.team-canvas.json` and `*.team-canvas-*.png`. Its injected
pointer events exercise renderer gesture handlers against the isolated API;
they do not prove native pointer capture or physical mouse/touch behavior.
Native input and narrow-window appearance need separate fixture browser or
Electron verification. Never use the running desktop app for those checks.

The owner API keeps the existing `/api/sidebar-sections` name for older clients:

The registry shares the atomic section-context file so rename/delete cannot
split a team's name from its instructions. Team labels are remembered before a
bot write; a storage failure may leave an empty team, but cannot partially move
the selected bots. This does not change bot communication permissions.

Both fixtures own their fake engine, temporary home and data directory. Cleanup
stops only their own child processes. Never run these requests against the live
app or copy live data into a fixture.
