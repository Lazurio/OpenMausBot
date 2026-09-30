# Lazurio OpenMausBot: releases

Runbook for the owner of Lazurio OpenMausBot releases (the Organization
Steward, today Pablo, `agentrozjedemeai`). The Steward prepares, tests and
dispatches a release; the Organization Admin (Matěj, `immakermatty`) only
approves it in the GitHub environment. Plan: DEV-6632 in the Human and
Machine Mission Control; direction: Lazurio decision 0169.

`Lazurio/OpenMausBot` distributes vanilla upstream OpenMausBot
(`milind-soni/OpenMausBot`, Apache-2.0) as the headless server and web app
Lazurio Machines run for bot teams. It is released the way `Lazurio/t3code`
is: our own releases, the same functionality as upstream, a small Lazurio
overlay on an exact upstream stable tag. The fork contract is in
[`LAZURIO.md`](../../LAZURIO.md).

## Release channel

GitHub Releases of this repository are the channel Lazurio Machines install
OpenMausBot from. Each release contains:

| Asset                                   | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `openmausbot-<version>-linux-x64.tar.gz` | the server and web app for headless Linux x64 Machines           |
| `SHA256SUMS`                            | `sha256sum` over the final archive bytes                          |
| `release-evidence.json`                 | source commit, upstream base, archive sha256 and size, attestation |

The archive is **upstream's own npm package**, built from this source by
upstream's `scripts/build-npm-package.mjs` exactly as upstream's
`npm-package.yml` builds `openmausbot` for npm, and packed with `npm pack`.
Its layout is therefore the npm layout: everything under `package/`
(`cli.js`, `dist-server/`, `dist/`, `skills/`, `enterprise/`,
`lazurio/teams/`, `package.json`, `LICENSE`, `README.md`), no `node_modules`,
run with Node 24 or newer. The only differences from the upstream npm tarball
are the version in `package/package.json` (the release version), the Lazurio
overlay in the code, and `lazurio/teams/` with the Steward team file
(`package/lazurio/teams/steward.openmaus.json`), which an Environment imports
from the installed release. The same bytes also install with
`npm install -g ./openmausbot-<version>-linux-x64.tar.gz`.

The JavaScript is platform independent; `linux-x64` names the platform the
release is built and smoke-tested on and the only one Lazurio supports.

`release-evidence.json` (`schema_version: openmausbot.fork-release.v1`)
carries `source.commit`, `source.version`, `source.upstream_release`,
`source.upstream_base`, `artifact.archive.{name, sha256, size}` and the
archive attestation URL.

### Versions

The version is `X.Y.Z-lazurio.N`, tag `vX.Y.Z-lazurio.N`. `X.Y.Z` is the
upstream stable tag `main` stands on. `N` starts at 1 and grows with each
release on the same upstream base; a new upstream base starts again at `.1`.
`X.Y.Z-lazurio.0` is never released; only CI uses it.

The workflow refuses a version that is not higher than every published
Lazurio release, so the newest release is always the highest version.
Mind SemVer: `0.1.91-lazurio.1` is lower than `0.1.91`. Nothing in Lazurio
compares our versions with upstream's; do not install upstream npm releases
on Machines next to ours.

## How Machines consume a release

Machines (`HumanAndMachine-ai/Machines`, `workloads/workspace-vm`) installs a
pinned release the way it pins a `Lazurio/t3code` release. The Machines
change itself is a separate step of DEV-6632 M1; this is the contract the
release offers it.

1. **Pin.** `{version, sha256, size, source_commit}`: `version` is
   `X.Y.Z-lazurio.N`, `sha256` and `size` are those of
   `openmausbot-<version>-linux-x64.tar.gz` as listed in `SHA256SUMS` and
   `release-evidence.json`, `source_commit` is `source.commit`.
2. **Fetch and verify.** Download
   `https://github.com/Lazurio/OpenMausBot/releases/download/v<version>/openmausbot-<version>-linux-x64.tar.gz`
   on the operator side, check sha256 and size against the pin (optionally
   `gh attestation verify <archive> --repo Lazurio/OpenMausBot`), and transfer
   it to the Machine as the T3 archive is transferred.
3. **Install.** Unpack into a versioned directory, for example
   `~/.openmausbot/runtime/versions/<version>/`, with
   `--strip-components=1`. Every member is a regular file or directory under
   `package/`; refuse anything else. Check that `package.json` reports
   `<version>`. Node 24 or newer comes from the Machine toolchain.
4. **Run.** One user unit, for example `openmausbot.service`, running
   `node <versions>/<version>/cli.js serve --no-pair --port 4102 --data-dir <home>/.openmausbot`
   with:
   - `OMB_WEBHOOK_PORT` set explicitly. The webhook listener otherwise takes
     `port + 1` (4103), which Machines has not reserved.
   - `OMB_DEFAULT_BOT_CWD` set to the Lazurio Folder of the Machine
     operator, so new bots start there (see Overlay).
   - `PATH` including `~/.local/bin`, so the server finds the signed-in
     `codex` and `claude` CLIs of the same user, as T3 does.
   - optionally `OMB_ENVIRONMENT_LABEL` (`<Organization> / <machine>`).
   - optionally the GitHub intake (`OMB_GITHUB_INTAKE=1`,
     `OMB_GITHUB_INTAKE_BOT` and its scope settings), with `gh` signed in
     as the same user; see
     [`docs/lazurio-github-intake.md`](../lazurio-github-intake.md).

   The server always listens on `127.0.0.1` only. The gateway serves it at
   `https://openmausbot.<vm>.<org>.lazurio.io/` and must require the
   workspace sign-in before proxying: OpenMausBot trusts every loopback
   request as its owner.
5. **Update.** OpenMausBot has no in-app updater for this channel
   (`selfUpdate: "operator"`). A Machine moves to a new release when its pin
   in Machines moves; stop the unit, install the new version directory,
   point the unit at it and start it. Keep the data directory. Pins only
   move forward.

## Overlay

`main` is an exact upstream stable tag and on top of it only these commits:

| Commit                                                            | Why Lazurio needs it                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server: OMB_DEFAULT_BOT_CWD, a default working folder for new bots` | Bots in a Lazurio Environment start in the Lazurio Folder, read its `AGENTS.md` and work in its worktrees (decision 0169). Unset keeps upstream behaviour: a new bot works in its private `<data>/task-workspaces/...`. Upstream-friendly; propose it upstream. |
| `release: Lazurio distribution`                                   | This runbook, `LAZURIO.md`, `scripts/lazurio-release-archive.sh`, the contract test and the workflows `lazurio-fork-ci.yml`, `lazurio-archive.yml` and `lazurio-release.yml`.                                                                           |
| `server: GitHub intake, model-free pull request triggers for a bot` | Lazurio Environments hand GitHub review and publication work to a bot team without a model polling (decision 0169). Off unless `OMB_GITHUB_INTAKE=1`. New files plus `WebhookManager.deliver()` and its wiring; see [`docs/lazurio-github-intake.md`](../lazurio-github-intake.md). Upstream-friendly apart from the Lazurio publish marker. |
| `lazurio: Steward team for the GitHub intake`                     | The team Lazurio Organizations run behind the intake: leader Henry (Chief of Staff) and three workers with exact-head review and explicit-publication rules, as a portable team file (`lazurio/teams/steward.openmaus.json`). Lazurio-only; never proposed upstream. |

`OMB_DEFAULT_BOT_CWD` applies wherever a bot is created: New bot, the first
bot on an empty server, a Chief's reviewed team setup and imports. A
request that names a folder, or explicitly none, decides for itself;
existing bots keep theirs. The value is validated like a bot's own folder,
and an unusable one stops the server at start. Known limit: the New bot
dialog still shows its private-folder placeholder, because the dialog does
not know the server default; the created bot does start in the folder. A
UI change is left for the UI milestone.

Drop a commit as soon as upstream offers an equivalent. Upstream files the
overlay changes are listed in `allowed_upstream_changes` in
`lazurio-fork-ci.yml`; each entry is a reviewed decision, and CI fails on a
change to any other upstream file. New Lazurio files need no entry. Versions
are stamped only at build time by `scripts/lazurio-release-archive.sh` and
never committed.

Deliberately not in the overlay (DEV-6632 M2 and later): approval levels
(`full` and `custom` stay desktop-only, as upstream), the Environment preset
that installs and configures the Steward team, and any UI change.

## When to release

- **New upstream stable** (`milind-soni/OpenMausBot` tagged `vX.Y.Z` with a
  GitHub Release that is not a pre-release): rebuild the overlay on the new
  tag (next section) and release `X.Y.Z-lazurio.1`.
- **A fix or change of the overlay** on the same base: after it lands on
  `main`, release the next `-lazurio.N`.
- Never release upstream's `main`, a pre-release or anything other than
  `main`.
- Pull requests into `main` merge by rebase only, without a merge commit;
  release and CI refuse a merge commit above the upstream tag.

Upstream tags its releases on a release branch, so an upstream tag is often
not an ancestor of upstream `main`. That is expected: the distribution
follows the tag, never upstream `main`.

## Rebuilding on a new upstream tag

`main` is a rolling distribution patch-stack, like `Lazurio/t3code`. The old
`main` is never merged or replayed wholesale. The Steward prepares the
candidate branch, checks and exact SHAs; only the Organization Admin, or
their Task Agent on an explicit instruction bound to both SHAs, replaces
`main`, using the `OrganizationAdmin` bypass of the main ruleset. Everyone
else stays blocked by `non_fast_forward`.

1. Create a candidate branch from the exact upstream stable tag. Carry each
   overlay commit over by intent (`git cherry-pick`, or by hand) and shrink
   the overlay by whatever upstream now covers.
2. In `lazurio-fork-ci.yml`, update `UPSTREAM_TAG`, `UPSTREAM_SHA` and the
   `X.Y.Z-lazurio.0` version of the `archive` job. The contract test checks
   that they agree.
3. Review `allowed_upstream_changes`: remove files the overlay no longer
   changes; add a file only as a reviewed decision with its reason.
4. Open a pull request and wait for a green `Lazurio Fork CI`. Hand the
   Admin the exact old `main` (`expected_old_main`), the exact new head
   (`candidate_head`) and the link to the green run.
5. Before `main` moves, the current `main` must be captured by a published
   **immutable** `v…-lazurio.N` release; no other tag counts:

   ```bash
   expected_old_main="$(git ls-remote https://github.com/Lazurio/OpenMausBot.git refs/heads/main | cut -f1)"
   capture=v0.1.91-lazurio.3   # the latest release
   test "$(gh api "repos/Lazurio/OpenMausBot/git/ref/tags/$capture" --jq .object.sha)" = "$expected_old_main"
   test "$(gh api "repos/Lazurio/OpenMausBot/releases/tags/$capture" --jq .immutable)" = true
   ```

   If the latest release does not point at the current `main`, release it
   first. Then the Admin replaces `main`:

   ```bash
   git push --force-with-lease="refs/heads/main:$expected_old_main" \
     https://github.com/Lazurio/OpenMausBot.git "$candidate_head:refs/heads/main"
   ```

   A failed lease means a concurrent change. Never retry it automatically.

6. Release `X.Y.Z-lazurio.1` from the new `main` as below.

## One-time setup of the fork (before the first release)

The fork was created on 2026-09-29 as an exact copy of upstream `main`, with
no Lazurio commit, tag, release, ruleset or environment. The first overlay
comes in as a candidate branch on `v0.1.91`, exactly like a rebuild. Only the
Organization Admin can do these steps; the order matters.

1. **Allow the patch-stack for this repository.** The Human and Machine
   `AGENTS.md` names `Lazurio/t3code` as the only repository whose `main` may
   be replaced. Extend that exception to `Lazurio/OpenMausBot` (a reviewed
   change of that `AGENTS.md`) before step 4.
2. **Actions.** Enable Actions on the fork (Actions tab: GitHub keeps fork
   workflows off until then), then immediately disable every upstream
   workflow; see Automation boundary. Until they are disabled, a push to
   `main` or a tag would let upstream's `docker.yml` publish
   `ghcr.io/lazurio/openmausbot`.
3. **Candidate CI.** `Lazurio Fork CI` must be green on the candidate pull
   request (re-run it after step 2).
4. **Replace `main`.** The old `main` needs no release capture this one
   time: it carries no Lazurio commit, it is upstream's own commit
   `415bdb684dc66fd37165bef38c9e6122921b41fd`, which stays in upstream's
   public history. Prove that instead, then swap:

   ```bash
   expected_old_main=415bdb684dc66fd37165bef38c9e6122921b41fd
   candidate_head=<exact head of the candidate pull request>
   test "$(git ls-remote https://github.com/Lazurio/OpenMausBot.git refs/heads/main | cut -f1)" = "$expected_old_main"
   git fetch https://github.com/milind-soni/OpenMausBot.git refs/heads/main
   git merge-base --is-ancestor "$expected_old_main" FETCH_HEAD
   git push --force-with-lease="refs/heads/main:$expected_old_main" \
     https://github.com/Lazurio/OpenMausBot.git "$candidate_head:refs/heads/main"
   ```

   GitHub then shows the candidate pull request as merged.
5. **Protect `main`.** A branch ruleset on `main`: pull request required,
   merge method `rebase` only, `required_linear_history`, `non_fast_forward`
   with bypass only for `OrganizationAdmin`, required check
   `Overlay, typecheck and lint`. Allow only rebase merging in the repository
   settings.
6. **Release App and tag protection.** Create the GitHub App
   "Lazurio OpenMausBot Release" (contents write, metadata read), installed
   only on `Lazurio/OpenMausBot`. A tag ruleset "Protect Lazurio channel
   tags" on `refs/tags/v*-lazurio.*` (creation, update, deletion) with that
   App as the only bypass actor. Turn on immutable releases for the
   repository.
7. **Environment.** `lazurio-openmausbot-release`: required reviewer Matěj,
   `prevent_self_review`, deployments from `main` only, variable
   `LAZURIO_OPENMAUSBOT_RELEASE_CONTROL=reviewed-v1`, variable
   `LAZURIO_RELEASE_APP_ID`, secret `LAZURIO_RELEASE_APP_PRIVATE_KEY`.
8. **First release** `0.1.91-lazurio.1`, dispatched by the Steward. Right after it, disable `npm-package.yml`, which the release registers (Automation boundary). `sync-published-release.yml` stays latent; see Automation boundary.

## Testing before a release

1. **CI.** `Lazurio Fork CI` must be green on the pull request and on `main`:
   - the overlay guard (exact upstream tag, no merge commits, only
     allowlisted upstream files changed), upstream workflows disabled, the
     release contract test, `pnpm typecheck` and `pnpm lint`;
   - upstream's own vitest suite in four shards on Linux, plus
     `pnpm broker:test` and `pnpm test:electron`;
   - `Archive`: the release archive built and smoke-tested under
     `<upstream>-lazurio.0`.
2. **Local archive** (optional, useful when debugging the build). In a clean
   checkout with Node 24+ and pnpm:

   ```bash
   pnpm install --frozen-lockfile
   bash scripts/lazurio-release-archive.sh 0.1.91-lazurio.0 /tmp/omb-release
   ```

   The script stamps the version (and restores `package.json`), builds,
   packs, unpacks into a temporary directory without `node_modules`, starts
   `serve` with a temporary home, data directory and `OMB_DEFAULT_BOT_CWD`,
   and checks the health endpoint, the reported version and that the first
   bot starts in that folder.
3. **Canary.** After publishing, move the canary Machine's pin first (the
   Spectoda VM101 or Matěj's work VM), open OpenMausBot from Launchpad,
   check the version, one bot turn and that the bot works in the Lazurio
   Folder. Only then move other Machines.

## Dispatching a release

Only from `main`, and only from the commit at its tip:

```bash
VERSION=0.1.91-lazurio.1
SOURCE_SHA="$(git ls-remote https://github.com/Lazurio/OpenMausBot.git refs/heads/main | cut -f1)"
UPSTREAM_TAG=v0.1.91
UPSTREAM_SHA="$(git ls-remote https://github.com/milind-soni/OpenMausBot.git "refs/tags/$UPSTREAM_TAG" | cut -f1)"
# Upstream tags are lightweight: the tag SHA is the commit (the workflow checks it).

gh workflow run lazurio-release.yml --repo Lazurio/OpenMausBot --ref main \
  -f version="$VERSION" \
  -f source_sha="$SOURCE_SHA" \
  -f upstream_tag="$UPSTREAM_TAG" \
  -f upstream_sha="$UPSTREAM_SHA"
gh run list --repo Lazurio/OpenMausBot --workflow lazurio-release.yml --limit 1
```

`Lazurio OpenMausBot Release` then:

1. **Verify source and version** checks the inputs, that `source_sha` is the
   tip of `main`, stands on the exact upstream tag and has no merge commits,
   that no upstream workflow is enabled, that neither tag nor release exists
   and that the version is the highest.
2. **Archive** builds and smoke-tests the archive as CI does.
3. **Publish release** waits for approval in `lazurio-openmausbot-release`.
   After approval it:
   - checks again, before any write, that `source_sha` is still the tip of
     `main`; if `main` moved, it stops and publishes nothing (dispatch again
     from the new tip);
   - writes `SHA256SUMS` and attests the archive;
   - creates the tag `v<version>` on `source_sha` with the release App token
     (the API refuses an existing tag);
   - publishes the GitHub Release as `latest` with the archive,
     `SHA256SUMS` and `release-evidence.json`.

   It never overwrites a tag, release or asset.

## Approval

When the first two jobs are green, ask Matěj to approve and send him the
run link. He approves in GitHub (run → Review deployments →
`lazurio-openmausbot-release` → Approve). The environment has
`prevent_self_review`, so the Steward dispatches and the Admin approves. If
the release should not go out, Matěj rejects it and nothing is published.

## Verifying a published release

```bash
VERSION=0.1.91-lazurio.1
mkdir -p "/tmp/omb-$VERSION" && cd "/tmp/omb-$VERSION"
gh release download "v$VERSION" --repo Lazurio/OpenMausBot
sha256sum --check SHA256SUMS            # macOS: shasum -a 256 --check SHA256SUMS
gh attestation verify "openmausbot-$VERSION-linux-x64.tar.gz" --repo Lazurio/OpenMausBot
jq '.source, .artifact.archive' release-evidence.json
```

## No rollback: repair forward

Lazurio has no rollback (decision 0166). A broken release is repaired
forward: fix or revert the commit on `main`, release the next, higher
`-lazurio.N` and move the Machine pins. A Machine that is broken meanwhile
goes to Recovery: an agent repairs it forward, or an issue records
everything needed for the fix. Do not pin a Machine back to an older
release; OpenMausBot migrates its data directory forward, and an older build
is not guaranteed to read what a newer one wrote.

## Do not

- Delete or rewrite a published release, its assets or its tag. A wrong
  release is replaced by a higher version.
- Publish by hand (`gh release create`). Only the workflow fills the channel;
  the tag ruleset keeps `v*-lazurio.*` for the release App.
- Use the release App outside the workflow or copy its private key.
- Force-push `main` outside "Rebuilding on a new upstream tag" and the
  one-time setup.
- Enable or run upstream workflows.

## Automation boundary

Upstream workflow files stay in the tree unchanged, so a rebuild on a new tag
brings no workflow diff, but they are **disabled** in this repository's
Actions settings. They publish to npm (`npm-package.yml`), GHCR
(`docker.yml`), mirror releases (`sync-published-release.yml`), cut
upstream releases (`release.yml`, `prepare-release.yml`) and run upstream's
CI. Enabled here, a push to `main` or a `v*` tag would publish under the
`Lazurio` organization or fail on missing upstream secrets. `Lazurio Fork
CI` and the release both fail while any of them is enabled. When a rebuild
brings a new upstream workflow, disable it too:

```bash
gh workflow list --repo Lazurio/OpenMausBot --all --json id,path,state \
  | jq -r '.[] | select(.path | test("lazurio-") | not) | select(.state == "active") | .id' \
  | xargs -n1 gh workflow disable --repo Lazurio/OpenMausBot
```

Only `lazurio-fork-ci.yml` (read-only; required check), `lazurio-archive.yml`
(called by both others) and the manually dispatched `lazurio-release.yml`
stay active.

GitHub registers a workflow only at its first triggering event, and only a
registered workflow can be disabled. After the one-time bootstrap (2026-09-30)
`docker.yml` and `ci-stop-closed.yml` registered and are disabled. `docker.yml`
fired on the bootstrap push and ended in `startup_failure`, because Actions
allow only GitHub-owned actions plus `pnpm/action-setup`.

Two publishers are still unregistered, and neither can publish from this fork:
npm does not trust this repository for `openmausbot`, and the mirror needs
`RELEASES_PAT`, which the fork does not have.

- `npm-package.yml` (tag `v*`) registers with the first release. The release
  App creates the tag, and App-created tags start workflows. Right after the
  first release, run the disable command above.
- `sync-published-release.yml` (release published) does **not** register with
  our releases. The release workflow publishes with `GITHUB_TOKEN`, and
  GitHub starts no workflow for events that token causes. It stays latent until
  a release is published another way, for example by hand in the UI or with a
  personal token. After any such publication, run the disable command at once.
  Once registered, the release workflow's pre-tag check refuses it while it is
  enabled.

After the first release, check that only the three `lazurio-*` workflows are
active. Also check that `sync-published-release.yml` is either absent from the
list or disabled. Issue #6 stays open until it is registered and disabled, or
the upstream publish jobs get a reviewed repository guard.
