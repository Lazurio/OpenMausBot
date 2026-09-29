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

## What the overlay adds

- `OMB_DEFAULT_BOT_CWD`: new bots start in the Lazurio Folder
  ([`docs/self-hosting.md`](docs/self-hosting.md)).
- **GitHub intake**: model-free polling under the Environment's signed-in
  `gh` that hands a bot only real pull request work, a review on a new head
  or an explicit `/lazurio publish` instruction, through the webhook queue
  ([`docs/lazurio-github-intake.md`](docs/lazurio-github-intake.md)). Off
  unless `OMB_GITHUB_INTAKE=1`.

How to release, rebuild on a new upstream tag, what the overlay contains and
how Machines consume a release:
[`docs/operations/lazurio-fork-release.md`](docs/operations/lazurio-fork-release.md).

Agents working in this repository follow upstream's `AGENTS.md` for code and
verification, and this contract for branches, releases and the overlay.
Code, commits and pull requests are in English. Pull requests go to
`Lazurio/OpenMausBot`, never to `milind-soni/OpenMausBot` unless a change
is deliberately proposed upstream.
