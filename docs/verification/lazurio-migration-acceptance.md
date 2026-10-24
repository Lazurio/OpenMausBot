# Passive migration acceptance of 0.1.115-lazurio.7

Status: **Draft; not executed.** This harness changes no production application,
connection, account, service or schedule. Its CLI explicitly starts a disposable
candidate, so do not invoke `migration qualify` without separate authorization.
Unit tests exercise admission and argument construction only, never the candidate.

## Intent and boundary

Qualify the published Linux x64 archive, not the current source server, against an
offline snapshot. Only `0.1.115-lazurio.7`, source
`b726e96af313b621b6e4200a5deb4d593af96df9`, archive SHA-256
`5b58fda0e5fd6533a7603e004950038378bc53811e2845adfaf40be51057f264`
(9,724,231 bytes) is admitted. Signature/provenance verification and obtaining the
archive remain an operator preflight; a matching checksum is not an attestation.
No package installation, dependency preparation or candidate download occurs.

The existing `launch` command remains unchanged: it seeds a bot and uses the
source tree. `migration qualify` never seeds, renames or sends to a bot, does not
discover running apps, and preserves its private working directory on failure.

## Required input

An existing, absolute, canonical, offline snapshot directory with config.json,
bots.json and a consistent messages.db. Create it through an owner-approved
consistent backup before this harness; never copy a running DB without its WAL.
The harness rejects WAL/SHM inputs, symlinks, special files, sessions, provider
directories, CLI credentials, active bots and saved automation/coordinator state.
The latter includes calendar calls, pending memory capture and legacy room handoffs,
not only routines and webhooks. Hard-linked files and common credential files are
also refused. The copied tree is checked again before configuration is read.
The supported config shape is deliberately restricted to profile/onboarding and
an optional synthetic Composio section whose three values are `fixture-only`.
Do not pass a production directory. The harness does not sanitize raw credentials
on your behalf. Other shapes are BLOCKED, not silently dropped.

Private copies stay inside the authorized Organization's trusted Environment.
Never upload them to CI or attach logs, messages, model cursors, instructions or
attachment contents to the public PR. CI unit inputs are synthetic.

Two existing empty output directories are required: work and evidence. They must
be separate from the input and from each other (neither ancestors nor descendants).
No cleanup is automatic. Inspect outputs first and delete only the specifically
approved disposable directories later.

## Admission and execution contract

The future invocation takes explicit `--archive`, `--manifest`, `--snapshot`,
`--work`, `--evidence` and `--input-kind synthetic|private-lumbio` absolute paths;
`--observe-ms` defaults to 90000, range 90000–300000, for **each** of two starts.
Use the foreground `node --experimental-strip-types scripts/control-omb.ts`
entrypoint with `migration qualify`; package-manager wrapping is refused.
This is a recipe, not a request to run it.

Linux x64, Node >=24, `/usr/bin/bwrap` and `/usr/bin/strace` are prerequisites.
Nothing installs them. A missing tool, refused namespace or unsupported snapshot
blocks the run; there is no host fallback. Bubblewrap has a new network/PID/mount
namespace, an empty root, cleared environment and dropped capabilities. Only Node,
its libraries, the read-only archive and harness, and the disposable work mount
are exposed. Production home, repositories, runtime sockets and browser are not
mounted. The controller runs **inside** the network namespace and only polls
the fixture health endpoint; no host port is published.

Before the candidate starts, the worker compares network namespace identities,
checks that host runtime paths are absent and verifies the fixture guards and
memory flags. The `strace` parent follows network connect calls only, never
exec argv or read/write buffers. Only fixture loopback ports 19971/19972 are
accepted. Namespace enforcement prevents external connectivity; tracing detects
unexpected attempts. Failure stops the candidate. These mechanisms are not yet
runtime-qualified; their negative admission checks must be exercised on synthetic
data before any private snapshot is used.

## Recorded fixture transformations

The untouched input is never written. In its working copy only:

- both engine IDs point to discovery-only guards;
- working-copy directories/files become owner-only writable (0700/0600), without
  changing the source snapshot's permissions;
- every bot has `memoryUpkeep: false`;
- bot/task working directories point inside the fixture;
- project-bearing bots are refused until their paths have an explicit contract.

The baseline is taken **after** these transformations; they are reported separately
from the candidate's migration. The guards return synthetic version/auth/catalog
answers and reject every generation, session start/resume and unknown request.
No prompts, arguments or environment values enter their journal. The native CLIs,
OAuth and live MCP servers are absent. Ordinary happy-mode fakes are not used.

## Acceptance and evidence

The exact package CLI starts with its own data dir, loopback port and webhook
port. A health deadline is 30 s; each start is observed at least 90 s, covering the
first one-minute memory tick. On both starts, no engine denial, runtime assignment,
notification, follow-up or automation file may appear. A denied generation counts
as FAIL, even with zero billed tokens. No message or routine is submitted.

After graceful stop, compare logical messages/thread state/receipts/memory rows,
protected file hashes, unchanged config bytes, bot/thread identity and model
overrides. Only known removed settings, redundant model copies, derived thread
timestamps, migration markers and missing SOUL mirrors are accepted. Other data
file changes fail; only the explicitly enumerated SQLite/lease/session operational
files are exempt from byte equality. Second start must not change bot data again.
Database integrity and existing schema must remain valid; only the exact expected
notification table/index and message-ordering index may be added. A PASS also
requires a zero exit status from the isolation supervisor, both scenario results,
the worker completion marker and a nonempty network trace. Missing evidence,
cancellation and abnormal supervisor exit cannot inherit the worker's PASS.

`report.json` records the candidate, UTC time, input kind, transformations, scope,
scenario verdicts and unexpected connect count. Application logs and migrated
data stay in the private work directory. `PASS` covers passive migration only.
Browser, real account/scopes, external provider behavior, interruption drills and
the production maintenance procedure remain separate qualification gates.
Do not describe this result as complete rollout acceptance.

## Recovery

SIGINT/SIGTERM and an overall deadline kill the owned process group; Bubblewrap's
parent-death behavior and PID namespace contain descendants. Preserve evidence,
fix the cause and retry with new empty outputs and the original offline snapshot.
Never retry against the partially migrated copy. No downgrade, service restart,
connection switch, OAuth, routine replay or production recovery is authorized here.
