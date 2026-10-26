# Passive migration acceptance of 0.1.115-lazurio.7

Status: **Draft; synthetic passive migration PASS (2026-10-25).** This harness changes no production application,
connection, account, service or schedule. Its CLI explicitly starts a disposable
candidate, so do not invoke `migration qualify` without separate authorization.
Unit tests exercise admission, discovery guards and negative contracts, never the candidate. Runtime qualification requires its own explicit invocation.

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

The invocation takes explicit `--archive`, `--manifest`, `--snapshot`,
`--work`, `--evidence` and `--input-kind synthetic|private-org` absolute paths;
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
unexpected attempts. Failure stops the candidate. Qualification results apply only to the exact harness revision and synthetic fixture recorded in the evidence; they do not authorize private inputs.

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
The exact additional CLI forms `codex login status`, `claude --help` and `claude auth status --json` return only fictional discovery data. Extra arguments and unknown RPCs fail closed, with fixed operation categories instead of raw payloads.
No prompts, arguments or environment values enter their journal. The native CLIs,
OAuth and live MCP servers are absent. Ordinary happy-mode fakes are not used.

## Network instrumentation

The pinned CLI spawns its server with a fresh Node argv. An explicit fixture-only `NODE_OPTIONS=--import=/harness/lazurio-migration-network-guard.mjs` therefore carries the fetch guard into both processes and their Node descendants. The parent environment is still cleared, the archive is unchanged and all mounts/network namespaces and the syscall allowlist stay unchanged.

The guard returns empty synthetic JSON catalogs, without opening any socket, for exact bodyless GETs from `server/drivers/local-inject.ts`: `/v1/models` on loopback ports 8080, 11434, 52415, 1234 and 8888; `/v1/models/status` on 8080; `/api/ps` on 11434; and `/api/v0/models` on 1234. It forwards only `GET http://127.0.0.1:19971/api/health` to the real fixture, always with redirects refused. The exact bodyless GET to `https://registry.npmjs.org/@openai/codex/latest` in `server/drivers/codex-release.ts` receives a synthetic offline 503 response, not a latest-version claim; no package download is permitted. Every other fetch records a fixed denial and fails the run even if the application catches it. Native HTTP/socket bypasses remain visible to strace; no additional socket destination is allowed. This tests passive migration with model discovery instrumented, not real provider connectivity.

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
file changes fail. On the first start only, creation of a valid v4 `environment-id` and the four bounded metadata-only model catalogs (`codex`, `claude`, `claudeApi`, `cursor`) is permitted. Neither may change on the second start. Model cache shapes reject credential/prompt fields. Only the explicitly enumerated SQLite/lease/session operational files are exempt from byte equality. Second start must not change bot data again.
Database integrity and existing schema must remain valid; only the exact expected
notification table/index and message-ordering index may be added. A PASS also
requires a zero exit status from the isolation supervisor, both scenario results,
the worker completion marker and a nonempty network trace. Missing evidence,
cancellation and abnormal supervisor exit cannot inherit the worker's PASS.

`report.json` records the candidate, UTC time, input kind, transformations, scope,
scenario verdicts and unexpected connect count. Errors include fixed phase/category diagnostics, without raw exception text. Runtime-state polling waits at most five seconds for a concurrent SQLite startup lock; an unresolved lock still fails, never skips the check. Application logs and migrated
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

## Recorded synthetic qualification

On 2026-10-25 at 12:05:20 UTC, the pinned archive passed both 90-second
observations on Linux x64 / Node 24.21.0, using an entirely generated fixture
with two bots, four threads, 146 messages and one fictional attachment. The
first-start data/schema comparisons and second-start idempotence both passed;
the supervisor exited zero, the worker completion marker was present and the
connect trace contained zero destinations outside the unchanged allowlist.
The archive SHA-256 and GitHub attestation were verified separately. Original
fixture hashes remained unchanged. No production data, accounts or services
were used, copied or changed. The candidate archive was not patched.

This result uses the synthetic discovery instrumentation described above. It
does not qualify real providers, browser flows, actual accounts/permissions,
private snapshots, interruption recovery or production maintenance. Prior
failed attempts are retained as diagnostics; only a fresh final copy passed.
The harness corrections and remaining review context are tracked in
[issue #64](https://github.com/Lazurio/OpenMausBot/issues/64).
