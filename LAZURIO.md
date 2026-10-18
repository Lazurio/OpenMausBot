# Lazurio OpenMausBot: fork contract

`Lazurio/OpenMausBot` is Lazurio's distribution of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0), the
runtime for the bot teams of Lazurio Environments (Lazurio decision 0169;
plans DEV-6632 and DEV-6673 in the Human and Machine Mission Control). It
follows the `Lazurio/t3code` model:

- **Exact upstream base.** `main` is an exact upstream stable tag
  (`vX.Y.Z`) plus a short, meaningful Lazurio overlay of linear commits. It
  never follows upstream `main`, and never contains a merge commit.
- **Rolling patch-stack.** A new upstream tag is taken by rebuilding the
  overlay on it by intent in a candidate branch; only the Organization Admin
  replaces `main`, with an exact `--force-with-lease`, after green candidate
  CI and after the old `main` is captured by an immutable release
  (Organization policy: HumanAndMachine-ai_GEN3 `AGENTS.md` and
  `ARCHITECTURE.md` §7).
- **Own releases.** `vX.Y.Z-lazurio.N`, published only by
  `lazurio-release.yml` after approval in the `lazurio-openmausbot-release`
  environment. Lazurio Machines install the linux-x64 archive of a release.
- **Upstream automation stays off.** Upstream workflow files are kept
  unchanged but disabled in this repository's Actions settings; only the
  `lazurio-*` workflows run.
- **Rebase merges only** into `main`; every change to an upstream file is
  listed in `allowed_upstream_changes` of `lazurio-fork-ci.yml`.

## In a Lazurio Environment

In the app switch of an Environment (Chat · Apps · Automate) this product is
**Automate**, and we call it **MausBot**; it keeps upstream's look and
branding. Machines install it as the user unit `mausbot.service` at
`https://mausbot.<vm>.<org>.lazurio.io/`; only the names this repository and
upstream own keep `openmausbot` (the release assets, the npm package and its
`openmausbot` CLI, the `OMB_*` variables and the data directory
`~/.openmausbot`).

Bots use the Environment's sign-ins like every other agent there (Lazurio
decisions 0162 and 0172), Composio included: they work in the Lazurio
Folder, read its agent instructions and call the `composio` CLI the operator

## What the overlay adds

- **The open-source edition.** Upstream's `enterprise/` folder is removed
  from the tree: it is under the OpenMausBot Enterprise License, which forbids
  redistribution and hosting for third parties (`LICENSING.md`, issue #35).
  The server reports `{"edition":"oss"}`. `lazurio/vitest.config.mjs` skips
  the three upstream tests that read the layer's source; CI, the contract
  test and the archive smoke fail if the folder comes back or is packed.
- `OMB_DEFAULT_BOT_CWD`: new bots start in the Lazurio Folder, whichever
  path creates them (New bot and `POST /api/bots`, the first bot on an empty
  server, a Chief's `create_bot` and team setup, imports). A request that
  names a folder, or explicitly none, decides for itself. Upstream's
  `newBotDefaults.profile.cwd` covers only New bot. `server/default-bot-cwd.ts`
  plus small hooks in the Store's two creation points; see
  [`docs/self-hosting.md`](docs/self-hosting.md#where-new-bots-work).
- **GitHub intake**: model-free polling under the Environment's signed-in
  `gh` that hands a bot only real pull request work, a review on a new head
  or an explicitly activated assignment handoff, through the webhook queue
  ([`docs/lazurio-github-intake.md`](docs/lazurio-github-intake.md)). Off
  unless `OMB_GITHUB_INTAKE=1`. Wired through the route module
  `server/routes/github-intake.ts`.

How to release, rebuild on a new upstream tag, what the overlay contains and
how Machines consume a release:
[`docs/operations/lazurio-fork-release.md`](docs/operations/lazurio-fork-release.md).

Agents working in this repository follow upstream's `AGENTS.md` for code and
verification, and this contract for branches, releases and the overlay.
Code, commits and pull requests are in English. Pull requests go to
`Lazurio/OpenMausBot`, never to `milind-soni/OpenMausBot` unless a change
is deliberately proposed upstream.