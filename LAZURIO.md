# Lazurio OpenMausBot: fork contract

`Lazurio/OpenMausBot` is Lazurio's distribution of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0), the
runtime for the bot teams of Lazurio Environments (Lazurio decision 0169;
plan DEV-6632 in the Human and Machine Mission Control). It follows the
`Lazurio/t3code` model:

- **Same product as upstream.** Functionally identical to vanilla
  OpenMausBot; the UI is at most lightly adjusted. Anything that could live
  upstream is written to be proposed upstream.
- **Exact upstream base.** `main` is an exact upstream stable tag
  (`vX.Y.Z`) plus a short, meaningful Lazurio overlay of linear commits. It
  never follows upstream `main`, and never contains a merge commit.
- **Rolling patch-stack.** A new upstream tag is taken by rebuilding the
  overlay on it in a candidate branch; only the Organization Admin replaces
  `main`, with an exact `--force-with-lease`, after green candidate CI and
  after the old `main` is captured by an immutable release. The only
  exception is the one-time bootstrap from upstream commit
  `415bdb684dc66fd37165bef38c9e6122921b41fd`: it needs no release because that
  state stays in upstream's public history, its ancestry is checked against a
  freshly fetched upstream `main` right before the lease, and the relief ends
  with the bootstrap (Organization policy: HumanAndMachine-ai_GEN3
  `AGENTS.md` and `ARCHITECTURE.md` §7).
- **Own releases.** `vX.Y.Z-lazurio.N`, published only by
  `lazurio-release.yml` after approval in the `lazurio-openmausbot-release`
  environment. Lazurio Machines install the linux-x64 archive of a release.
- **Upstream automation stays off.** Upstream workflow files are kept
  unchanged but disabled in this repository's Actions settings; only the
  `lazurio-*` workflows run.
- **Rebase merges only** into `main`; every change to an upstream file is
  listed in `allowed_upstream_changes` of `lazurio-fork-ci.yml`.

`OMB_DEFAULT_BOT_CWD` changes one default only: a bot created without a
folder starts in that folder instead of its private task workspace. An
explicit empty or null folder still gives the private workspace, on every
create path including a Chief's `create_bot`. The tool's upstream description
stays unchanged on purpose, so the tool catalog sent to the model on every
turn stays byte-identical to upstream.

## In a Lazurio Environment

Lazurio calls this product **Lazurio MausBot**. Machines install it as the
user unit `mausbot.service` at `https://mausbot.<vm>.<org>.lazurio.io/`;
only the names this repository and upstream own keep `openmausbot` (the
release assets, the npm package and its `openmausbot` CLI, the `OMB_*`
variables and the data directory `~/.openmausbot`).

Bots use the Environment's sign-ins like every other agent there (Lazurio
decisions 0162 and 0172), and that includes Composio. They work in the
Lazurio Folder, read its agent instructions and call the `composio` CLI the
operator enabled and signed in from the Launchpad Settings. Every bot
therefore reaches the Environment's Composio connections by default, without
any fork change. OpenMausBot's own **Connected apps** (a Composio project key
with its own Composio user) stay unconfigured: they would hold a second,
separate set of connections. Its per-bot tool grants apply only to that mode,
so a bot cannot be limited to fewer apps than its Environment; narrower
access means a separate Environment.

## What the overlay adds

- `OMB_DEFAULT_BOT_CWD`: new bots start in the Lazurio Folder
  ([`docs/self-hosting.md`](docs/self-hosting.md)).
- **GitHub intake**: model-free polling under the Environment's signed-in
  `gh` that hands a bot only real pull request work, a review on a new head
  or an explicit `/lazurio publish` instruction, through the webhook queue
  ([`docs/lazurio-github-intake.md`](docs/lazurio-github-intake.md)). Off
  unless `OMB_GITHUB_INTAKE=1`.
- `OMB_HEADLESS_FULL_ACCESS`: the operator's opt-in at server start that
  lets the owner on loopback set a bot to Full access through the ordinary
  bot settings API, which upstream allows only in the desktop app. Only
  Full is unlocked, never Custom
  ([`docs/self-hosting.md`](docs/self-hosting.md)). Off unless
  `OMB_HEADLESS_FULL_ACCESS=1`.
- **Steward team**: [`lazurio/teams/steward.openmaus.json`](lazurio/teams/steward.openmaus.json),
  a leader (Henry, Chief of Staff) and three workers who review pull
  requests on their exact head and publish only on an explicit instruction.
  Releases ship it inside the archive at `package/lazurio/teams/`, so an
  Environment imports it from the installed release. Import it (Templates →
  Import, or `POST /api/teams/import`) and point
  `OMB_GITHUB_INTAKE_BOT` at the leader. Another persona (Pablo) imports the
  same file and renames the leader; nothing in the instructions names the
  persona. Imported bots start on Ask, which would leave unattended work
  waiting for an approval nobody gives. Steward teams run on **Full access,
  without a sandbox** (Organization Admin decision of 2026-10-01, issue #3;
  it supersedes the earlier decision for Auto): the Environment, one Machine
  with one operator, is the boundary. Right after the import the operator
  sets each bot's engine, Codex or Claude (both are supported, as the
  Environment's own signed-in CLIs), and then sets all four bots to Full, in
  that order: changing the engine of a Full bot needs Ask first. Full needs
  the operator to start the service with `OMB_HEADLESS_FULL_ACCESS=1`; the
  app's level selector offers Full only in the desktop app, so the operator
  sets it through the local API
  ([`docs/self-hosting.md`](docs/self-hosting.md)). Machines never sets the
  opt-in. Full is upstream's Full: Codex runs with `never` approvals in the
  `danger-full-access` sandbox, Claude with `bypassPermissions`, and the work
  the leader (a Chief of Staff with Full) delegates runs Full too. Questions
  and missing credentials still reach a person; GitHub rights and branch
  rules stay the limit.

How to release, rebuild on a new upstream tag, what the overlay contains and
how Machines consume a release:
[`docs/operations/lazurio-fork-release.md`](docs/operations/lazurio-fork-release.md).

Agents working in this repository follow upstream's `AGENTS.md` for code and
verification, and this contract for branches, releases and the overlay.
Code, commits and pull requests are in English. Pull requests go to
`Lazurio/OpenMausBot`, never to `milind-soni/OpenMausBot` unless a change
is deliberately proposed upstream.
