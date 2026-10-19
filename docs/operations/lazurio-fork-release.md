# Lazurio OpenMausBot: releases

Runbook for the owner of Lazurio OpenMausBot releases (the Organization
Steward, today Pablo, `agentrozjedemeai`). The Steward prepares, tests and
dispatches a release; the Organization Admin (Matěj, `immakermatty`) only
approves it in the GitHub environment. Plans: DEV-6632 and DEV-6673 in the
Human and Machine Mission Control; direction: Lazurio decision 0169.

`Lazurio/OpenMausBot` distributes upstream OpenMausBot's open-source edition
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
(`cli.js`, `dist-server/`, `dist/`, `skills/`, `lazurio/teams/`,
`package.json`, `LICENSE`, `README.md`), no `node_modules`, run with Node 24
or newer. The differences from the upstream npm tarball are the version in
`package/package.json` (the release version), the Lazurio overlay in the
code, `lazurio/teams/` with the Steward team file
(`package/lazurio/teams/steward.openmaus.json`), which an Environment imports
from the installed release, and no `enterprise/` layer: this fork ships the
open-source edition, because the Enterprise License forbids redistribution
and hosting for third parties. The same bytes also install with
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
Mind SemVer: `0.1.130-lazurio.1` is lower than `0.1.130`. Nothing in Lazurio
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
   `~/.local/share/lazurio/mausbot/versions/<version>/`, with
   `--strip-components=1`. Every member is a regular file or directory under
   `package/`; refuse anything else. Check that `package.json` reports
   `<version>`. Node 24 or newer comes from the Machine toolchain.
4. **Run.** One user unit, `mausbot.service`, running
   `node <versions>/<version>/cli.js serve --no-pair --port 4102 --data-dir <home>/.openmausbot`
   with:
   - `OMB_WEBHOOK_PORT` set explicitly. The webhook listener otherwise takes
     `port + 1` (4103), which Machines has not reserved.
   - `OMB_DEFAULT_BOT_CWD` set to the Lazurio Folder of the Machine
     operator, so new bots start there (see Overlay).
   - `PATH` including `~/.local/bin`, so the server finds the signed-in
     `codex` and `claude` CLIs of the same user, as T3 does, and its bots
     find `lazurio` and `agent-browser`.
   - the user unit's own `XDG_RUNTIME_DIR` and `HOME`, where the bots'
     strips (`$XDG_RUNTIME_DIR/lazurio-browser/holders/bot-<id>.json`) and
     the Platform's CLI (`~/.local/bin/lazurio`) are. Never
     `AGENT_BROWSER_CONFIG`, `AGENT_BROWSER_SOCKET_DIR` or
     `AGENT_BROWSER_NAMESPACE`: the bots' sessions must meet the Platform's
     hub and idle limit (contract C7).
   - optionally `OMB_ENVIRONMENT_LABEL` (`<Organization> / <machine>`).
   - optionally the GitHub intake (`OMB_GITHUB_INTAKE=1`,
     `OMB_GITHUB_INTAKE_BOT` and its scope settings), with `gh` signed in
     as the same user; see
     [`docs/lazurio-github-intake.md`](../lazurio-github-intake.md).

   The server always listens on `127.0.0.1` only. The gateway serves it at
   `https://mausbot.<vm>.<org>.lazurio.io/` and must require the
   workspace sign-in before proxying: OpenMausBot trusts a loopback request
   without forwarding headers as its owner. A browser, even one on the same
   Machine, is never the owner by itself (upstream #2930); it pairs.
5. **Update.** OpenMausBot has no in-app updater for this channel
   (`selfUpdate: "operator"`). A Machine moves to a new release when its pin
   in Machines moves; stop the unit, install the new version directory,
   point the unit at it and start it. Keep the data directory. Pins only
   move forward. OpenMausBot migrates `~/.openmausbot` in place and an older
   build cannot read it afterwards, so back the data directory up before the
   first start on a new upstream base.

## Overlay

`main` is an exact upstream stable tag and on top of it only these commits:

| Commit                                                            | Why Lazurio needs it                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lazurio: ship the open-source edition, without enterprise/` | `enterprise/` is under the OpenMausBot Enterprise License, which forbids redistribution and hosting for third parties (issue #35). Removes the folder; `lazurio/vitest.config.mjs` skips the three upstream tests that read its source. Lazurio-only. |
| `release: Lazurio distribution on upstream v0.1.130` | This runbook, `LAZURIO.md`, `scripts/lazurio-release-archive.sh`, the contract and CI-scope tests and the workflows `lazurio-fork-ci.yml`, `lazurio-archive.yml` and `lazurio-release.yml`. |
| `lazurio: agents read how Lazurio shapes MausBot first` | The principles in [`LAZURIO.md`](../../LAZURIO.md#how-lazurio-shapes-mausbot) (one Environment is one computer, Full access for every bot, shared sign-ins, bots in their own tabs of the Environment browser) are what every Lazurio change here serves. A pointer at the top of upstream's `AGENTS.md` and a Lazurio `CLAUDE.md` that loads it, so Codex and Claude Code agents read them before upstream's notes. Lazurio-only; never proposed upstream. |
| `server: OMB_DEFAULT_BOT_CWD on every path that creates a bot` | Bots in a Lazurio Environment start in the Lazurio Folder, read its `AGENTS.md` and work in its worktrees (decision 0169). Applies to every creation path, through the Store's `createBot` and `applyTeamSetup`; a request that names a folder, or explicitly none, decides for itself; an unusable value stops the server at start. Unset keeps upstream behaviour. Upstream-friendly; propose it upstream. |
| `server: GitHub intake, model-free pull request triggers for a bot` | Lazurio Environments hand GitHub review and publication work to a bot team without a model polling (decision 0169). Off unless `OMB_GITHUB_INTAKE=1`. Lazurio-only files, `WebhookManager.deliver()` and a route module that `server/index.ts` builds, pushes into `ROUTES`, starts and stops; see [`docs/lazurio-github-intake.md`](../lazurio-github-intake.md). Upstream-friendly apart from the Lazurio publish marker. |
| `lazurio: Steward team for the GitHub intake` | The team Lazurio Organizations run behind the intake: leader Henry (Chief of Staff, delegating through `coordinate_bots`) and three workers with exact-head review and explicit-publication rules, as a portable team file (`lazurio/teams/steward.openmaus.json`) the archive ships. Lazurio-only; never proposed upstream. |
| `lazurio: the Lazurio shell slot, rail, column head, Buddy and colour roles` | The Lazurio shell's rail, column head and Buddy in an Environment (the Lazurio shell decisions of 2026-10-03), in the colours of the active skin (2026-10-04): `index.html` and one element in `src/components/Sidebar.tsx`; see [`LAZURIO.md`](../../LAZURIO.md#the-lazurio-shell). Outside Lazurio nothing renders and nothing reads the colour roles. Lazurio-only; never proposed upstream. |
| `lazurio: the Environment skin follows the Environment theme (0208)` | One colour theme per Environment, which Chat, Apps and Automate follow (root decision 0208). One more skin, added the way upstream adds a skin (its block in `src/styles.css`, its line in `src/lib/skins.ts`), names the theme's tokens that the shell declares, with Midnight's values as fallbacks. It is the default and offered only where the shell marks the Environment theme on the document (a Platform with decision 0208), each browser there moves to it once, and `index.html` lets the theme's dark values follow the device. Upstream's checks that measure a skin's values leave it out. See [`LAZURIO.md`](../../LAZURIO.md#the-environment-skin). Outside Lazurio nothing changes. Lazurio-only; never proposed upstream. |
| `lazurio: guards for the upstream features removed from the code` and the `lazurio: remove …` commits after it (DEV-6673 M3) | What contradicts the Lazurio model is removed from the code, not hidden (issue #35): MausBot's own integrations, sign-ins, computers, MausBot Cloud purchase and account, and telemetry to upstream, plus the browser build's decorative window dots. One manifest per area in `lazurio/removals/` names the upstream files it deletes and changes and what must stay gone; see [`LAZURIO.md`](../../LAZURIO.md#what-the-overlay-removes). Lazurio-only; never proposed upstream. |
| `lazurio: a signed-out engine sends the person to the Environment settings` and the `lazurio: remove …` sign-in commits after it (DEV-6673) | Engines sign in only through the Environment's own CLI logins, connected in the Launchpad's Environment settings, as for T3 Code (Organization Admin, 2026-10-19). A signed-out engine's card links to Getting started of the current Environment's Launchpad (from the shell's document) and checks the login again; the ChatGPT plan and Antigravity engines and added Claude accounts, MausBot's last own sign-ins, are removed. See [`LAZURIO.md`](../../LAZURIO.md#engine-sign-in). Outside Lazurio the card is upstream's. Lazurio-only; never proposed upstream. |
| `server: routines and webhooks from the openmausbot command and its MCP server` and the two DEV-6676 commits after it (`lazurio: agents and Buddy manage automations …`, `docs: call the page … Automations`) | Buddy and the other agents of an Environment manage MausBot's automations as a person does on its Automations page, from the command line of every Environment they reach (the Environment is the boundary, Lazurio decision 0172; the server trusts a caller on its computer as its owner): `openmausbot routine`, `webhook` and `bot list\|show`, each calling the same operation as a new MCP tool, which uses the app's own `/api/routines` and `/api/webhooks`. A webhook's secret is printed only with `--show-secret`, or saved to a `0600` file. `scripts/mcp-server.ts` only lists and dispatches the tools of `scripts/mcp-automations.ts`. See [`LAZURIO.md`](../../LAZURIO.md#what-the-overlay-adds). Upstream-friendly; propose it upstream. |
| `lazurio: a hosted server runs every bot at Full like any other` and the three commits after it (DEV-6673) | Every bot runs at Full by default and nothing gates it, as T3 Code runs `full-access` (root decision 0172 with its addendum of 2026-10-19): no hosted Ask default or operator flag for Full, the levels are T3 Code's four (Custom and the desktop grant are removed), no warning before Auto, and no approval before a bot contacts another. Saved values load and drop; writes naming them are refused. Manifest `lazurio/removals/e-full-access.json`; see [`LAZURIO.md`](../../LAZURIO.md#access-levels). Lazurio-only; never proposed upstream. |
| `lazurio: every bot gets the Environment's tools; per-bot tool selection is removed` and the two commits after it (DEV-6673) | Access is shared, never split per bot (issue #47; root decision 0172 with its addendum of 2026-10-19): `toolScope`, Settings → Tools and every engine path that narrowed the tools offered to one bot are removed, so every bot gets the native and MCP tools the Environment provides. A bot's peers stay. Saved selections load and drop, a team file's `tools` is ignored with a warning, and writes naming `toolScope` are refused. Manifest `lazurio/removals/e-tool-scope.json`; see [`LAZURIO.md`](../../LAZURIO.md#what-the-overlay-removes). Lazurio-only; never proposed upstream. |
| `lazurio: vendor the Environment browser contract …`, `lazurio: each bot's strip holds its own tabs …`, `lazurio: bots work in the Environment browser; remove MausBot's own browser …` and the `lazurio: remove …` browser commits after them (DEV-6673 M4a) | A Lazurio Environment has one browser, and a bot works in it like a T3 Code thread (root decision 0191 points 34 and 41–43): its own session `bot-<id>`, its own window from `lazurio browser window`, Lazurio's `agent-browser` from its shell. The server keeps each bot's strip (`holders/bot-<id>.json`) with the Platform's vendored contract module (`lazurio/browser-contract/`, below) and lets the tabs go when a bot is archived or deleted. MausBot's own browser (agent-browser daemons with their own Chrome, the `chrome` engine, My Chrome, profiles, saved sign-ins, the live view, egress, browser tools, the browser CLI and UI) is removed; `lazurio/removals/e-browser*.json`. See [`LAZURIO.md`](../../LAZURIO.md#the-environment-browser). Lazurio-only; never proposed upstream. |

Drop a commit as soon as upstream offers an equivalent. Upstream files the
overlay changes are listed in `allowed_upstream_changes` in
`lazurio-fork-ci.yml`; each entry is a reviewed decision, and CI fails on a
change to any other upstream file. New Lazurio files need no entry. Versions
are stamped only at build time by `scripts/lazurio-release-archive.sh` and
never committed.

New bots start on Full access, upstream's default (#2808); the overlay keeps
it on every server and removes upstream's gates before it
([`LAZURIO.md`](../../LAZURIO.md#access-levels)).

### The Environment browser contract

`lazurio/browser-contract/` is the Environment browser's contract module of
one LazurioPlatform release (decision F50 there), vendored by digest:
`node scripts/lazurio-vendor-browser-contract.mjs <tag>` downloads that
release's shell artifact and attestation bundle, verifies the attestation
against the Platform's release workflow at that tag and the repository's and
owner's immutable ids, checks `artifact.json` and every digest, and writes the
contract's files with their MIT `LICENSE`, the release's `NOTICE` and
`provenance.json`. The server bundle inlines the module, so the release
archive ships its `LICENSE` and `NOTICE` as
`package/LICENSES/lazurio-browser-contract/` (listed in the package's
`files`), and the archive check compares them with the vendored ones. A bump
is a reviewed pull request made by that command;
nothing there is edited by hand. `scripts/lazurio-browser-contract.node-test.mjs`
checks the bytes against `provenance.json` and runs every vector of the
release on each CI run. `BROWSER_CONTRACT_RELEASE` in
`server/lazurio-environment-browser.ts` names the same release (a test
checks it). Bump it when a new Platform release changes the contract, and
release MausBot only after that Platform release runs on every Environment
with a browser (F50 point 7).

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
   changes; add a file only as a reviewed decision with its reason. Re-apply
   each removal in `lazurio/removals/` by intent on the new tag and refresh
   its `files` and `changes`; its `forbidden` strings and `routes` say what
   must stay gone, so new upstream code for a removed feature fails the
   removals contract test.
4. Open a pull request and wait for a green `Lazurio Fork CI`. A rebuild
   never contains the old `main`, so GitHub reports the pull request as
   conflicting and starts no `pull_request` workflow for it. Dispatch the
   check on the candidate branch instead; its run reports on the exact head:

   ```bash
   gh workflow run lazurio-fork-ci.yml --repo Lazurio/OpenMausBot --ref <candidate branch>
   ```

   Hand the Admin the exact old `main` (`expected_old_main`), the exact new
   head (`candidate_head`) and the link to the green run.
5. Before `main` moves, the current `main` must be captured by a published
   **immutable** `v…-lazurio.N` release; no other tag counts:

   ```bash
   expected_old_main="$(git ls-remote https://github.com/Lazurio/OpenMausBot.git refs/heads/main | cut -f1)"
   capture="$(gh release view --repo Lazurio/OpenMausBot --json tagName --jq .tagName)"   # the latest release
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

6. Release `X.Y.Z-lazurio.1` from the new `main` as below. Back up
   `~/.openmausbot` on each Ring 0 Machine before it starts the new base:
   upstream migrates it in place, with no way back to an older build.

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
8. **First release** `0.1.91-lazurio.1`, dispatched by the Steward. Right after it, cancel the `npm-package.yml` run its tag starts and disable the workflow (Automation boundary). Done on 2026-09-30. `sync-published-release.yml` stays latent; see Automation boundary.

## Testing before a release

1. **CI.** `Lazurio Fork CI` must be green on the pull request and on `main`:
   - the overlay guard (exact upstream tag, no merge commits, only
     allowlisted upstream files changed), upstream workflows disabled, the
     release contract test, `pnpm typecheck` and `pnpm lint`;
   - upstream's own vitest suite in four shards on Linux, split by upstream's
     duration sequencer, without the three tests of the enterprise layer
     (`lazurio/vitest.config.mjs`), plus `pnpm broker:test` and
     `pnpm test:electron`;
   - `Archive`: the release archive built and smoke-tested under
     `<upstream>-lazurio.0`.

   `main`, a manual run (the dispatched check of a rebuild) and a pull
   request that changes upstream code (any upstream file other than Markdown
   and tests), CI, the upstream pin, the test runner, dependencies or shared
   test helpers run the whole vitest suite: upstream's end-to-end tests start
   the server as a child process and load the app through a Vite dev server,
   which vitest's import graph cannot see. Any other pull request (Lazurio
   files, documentation, tests) runs the overlay's own tests and what
   `vitest related` relates to its diff: the changed test files and every
   test that imports a changed file (`scripts/lazurio-ci-scope.mjs`). A test
   that reads a Lazurio file from disk can still miss a pull request and fail
   on `main` after the merge; repair it forward. To see what a pull request
   runs:
   `UPSTREAM_SHA=<pin> node scripts/lazurio-ci-scope.mjs <base> <head>`.
2. **Local archive** (optional, useful when debugging the build). In a clean
   checkout with Node 24+ and pnpm:

   ```bash
   pnpm install --frozen-lockfile
   bash scripts/lazurio-release-archive.sh 0.1.130-lazurio.0 /tmp/omb-release
   ```

   The script stamps the version (and restores `package.json`), builds,
   packs, unpacks into a temporary directory, checks that neither
   `node_modules` nor the enterprise layer is packed, starts `serve` with a
   temporary home, data directory and `OMB_DEFAULT_BOT_CWD`, and checks the
   health endpoint, the reported version, the open-source edition and that
   the first bot starts in that folder.
3. **Canary.** After publishing, move the pins of
   [Ring 0](#ring-0-lazurioexampleorganization) first, open OpenMausBot from
   Launchpad and check the version. Where the Environment has AI, also check
   one bot turn and that the bot works in the Lazurio Folder. Without AI,
   the browser acceptance of Ring 0 below is enough. Only then move other
   Machines.

## Ring 0: LazurioExampleOrganization

Every release goes first to the Environments of LazurioExampleOrganization
(GitHub id 325048785), the public reference Organization with fictional data
and no tailnet, that run OpenMausBot. Lazurio decision 0204 point 7 sets this
([HumanAndMachines/Lazurio `manual/decision-register.md`](https://github.com/HumanAndMachines/Lazurio/blob/main/manual/decision-register.md),
row 0204).

- **No consent or window:** pin moves, restarts, reinstalls and redeploys
  there need neither the consent of the people who use those Environments nor
  a window. The Agent does them as part of the release, on the instruction of
  its Operator, who holds the live Admin role in that Organization, and
  within the Operator's rights. The Agent gains no authority of its own.
- **What stays:** the Operator's instruction, source review, the Machines
  gates for each pin move, the Admin's approval of the release
  ([Approval](#approval)), no secrets in Git, and every other Organization's
  own consent.
- **The next wave** moves only after browser acceptance on that
  Organization's Environments (decision 0178): OpenMausBot opens in the
  Environment browser and, once the Organization has AI, a bot team runs a
  harmless task.
- **Outside Ring 0:** tailnet entry, which that Organization does not have,
  is first proven by the next wave.

## Dispatching a release

Only from `main`, and only from the commit at its tip:

```bash
VERSION=0.1.130-lazurio.1
SOURCE_SHA="$(git ls-remote https://github.com/Lazurio/OpenMausBot.git refs/heads/main | cut -f1)"
UPSTREAM_TAG=v0.1.130
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
VERSION=0.1.130-lazurio.1
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
  App creates the tag, and App-created tags start workflows, so its first run
  starts on that tag. Right after the first release, cancel that run and run
  the disable command above. On `0.1.91-lazurio.1` (2026-09-30) the run had
  already built and saved its npm tarball as an Actions artifact when the
  cancellation took effect; its `publish to npm` and `update GitHub release`
  jobs were cancelled before they started, so nothing reached npm and the
  release kept its assets. The workflow is now disabled; later releases do
  not start it.
- `sync-published-release.yml` (release published) does **not** register with
  our releases. The release workflow publishes with `GITHUB_TOKEN`, and
  GitHub starts no workflow for events that token causes. It stays latent until
  a release is published another way, for example by hand in the UI or with a
  personal token. After any such publication, run the disable command at once.
  Once registered, the release workflow's pre-tag check refuses it while it is
  enabled.

A rebuild is a triggering event too, because it changes upstream files that
upstream's path filters watch. Its pull request is conflicting and triggers
nothing, but replacing `main` does. The rebuild to `v0.1.95` registered
`docs.yml` and `release.yml` (both disabled since). The rebuilds to `v0.1.115`
and `v0.1.130` bring no new upstream workflow file. The rebuild to `v0.1.130`
changes `ci.yml`, `docker.yml`, `npm-package.yml`, `package-win.yml`,
`prepare-release.yml` and `release.yml`; replacing `main` can start any of them
that is not yet disabled, and any upstream workflow the push registers is
disabled the same way.

GitHub cannot disable a workflow before it registers. Right after the push,
cancel whichever run is still going and run the disable command above;
until then `Lazurio Fork CI` on `main` and the release refuse to proceed.

After the first release, check that only the three `lazurio-*` workflows are
active. Also check that `sync-published-release.yml` is either absent from the
list or disabled. Issue #6 stays open until it is registered and disabled, or
the upstream publish jobs get a reviewed repository guard.