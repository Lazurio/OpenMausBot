# The headless command line

Use an isolated fixture, never the live app or workspace. The end-to-end test
runs the published `openmausbot` entry as a child process against its own
fake-engine server (ports 19975-19999): a team file makes a Chief, two
teammates and a room, and a second apply sends no write; `run --wait job`
waits until the Chief and both teammates are done, and the export holds the
job tree, three transcripts, the Chief's report and both screenshots. Then
`team export` applies back with no changes, a second file renames a bot
(`was:`) and `--prune` deletes one made by hand, an older file that selects
tools applies without them and with a warning, and a job whose teammate hangs is
stopped, teammate included, by `--on-timeout stop`.

Routines and webhooks have an end-to-end test of their own against an isolated
server: the published entry, pointed at it only by `--port` and `OMB_PORT`,
creates a routine and pauses, reschedules, runs and deletes it, the server's
`GET /api/routines` showing each change; it saves a webhook's secret to a
`0600` file, the webhook accepts a call with that secret and refuses a wrong
one, a rotation turns the old secret away, no output carries a secret, and
`openmausbot mcp` lists the same routines and webhooks. In the same file, the
entry makes a bot with its instructions read from stdin, `run` gives it work and
waits until it is done, and the fake engine's system prompt for that turn holds
the instructions; `bot create` makes the same record as `create_bot` through
`openmausbot mcp` from the same values; `bot update` and `bot model` change the
bot (`--dry-run` changes nothing), `openmausbot mcp` reads it back, and a model
no available engine offers is refused with exit 2.

```sh
pnpm exec vitest run server/headless-cli.e2e.test.ts server/headless-automations.e2e.test.ts
pnpm exec vitest run server/headless/ server/job-view.test.ts server/routes/jobs.test.ts server/mcp-server.test.ts server/mcp-automations.test.ts server/control-omb.test.ts
pnpm typecheck
pnpm lint
```

By hand, against a fixture (`OMB_TEST_PORTS` keeps it in a range):

```sh
OMB_TEST_PORTS=19975-19999 node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb doctor --url http://127.0.0.1:PORT
pnpm control:omb team apply team.yaml --dry-run --url http://127.0.0.1:PORT
pnpm control:omb team apply team.yaml --url http://127.0.0.1:PORT
pnpm control:omb run --bot ID --text "Say hello" --url http://127.0.0.1:PORT
pnpm control:omb export --thread THREAD_ID --out /tmp/omb-export --url http://127.0.0.1:PORT
```

`control-omb` runs the same verbs as `openmausbot` (docs/headless-cli.md) and
prints each JSON result; a verb that changes something needs the explicit
`--url`. The job a wait watches is the server's own read,
`GET /api/threads/:id/job`; keep its JSON with the run's result as evidence.

The fake engine is scripted (`FAKE_CLAUDE_ROOM_PLAN`), so this proves the
command line, the job read and the export, not real model behaviour or a real
browser's screenshots.
