# Lazurio OpenMausBot: fork contract

`Lazurio/OpenMausBot` is Lazurio's distribution of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0), the
runtime for the bot teams of Lazurio Environments (Lazurio decision 0169;
plan DEV-6632 in the Human and Machine Mission Control). It follows the
`Lazurio/t3code` model:

- **Same product and look as upstream.** Functionally identical to vanilla
  OpenMausBot. Upstream's look and branding stay until upstream's stable
  releases; the only UI change is the slot of the Lazurio shell
  ([below](#the-lazurio-shell)). Anything that could live upstream is
  written to be proposed upstream.
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

In the app switch of an Environment (Chat · Apps · Automate) this product is
**Automate**, and we call it **MausBot**; it keeps upstream's look and
branding (the Lazurio shell decisions of 2026-10-03; earlier texts and the
code call it Lazurio MausBot). Machines install it as the user unit `mausbot.service` at `https://mausbot.<vm>.<org>.lazurio.io/`;
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
- **Live browser fixes** (issues #13, #14): the Browser panel clicks where
  the person points and waits while the bot is using the browser, instead
  of failing with an install hint. An upstream-ready commit carried until
  upstream takes it.
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

## The Lazurio shell

**Decided on 2026-10-03 (the Lazurio shell decisions); the slot is in the
overlay since issue #16.** The overlay adds only a slot for the Lazurio
shell: the rail on the left, the column head (the Environment picker, the
Settings gear and the switch Chat · Apps · Automate) at the top of MausBot's
own sidebar, and the floating Buddy bubble. The shell is Web Components with
Shadow DOM (`<lazurio-rail>`, `<lazurio-column-head>`, `<lazurio-buddy>`)
defined by `/.lazurio/shell.js`, which the Environment's Launchpad serves on
this origin behind the Environment's gateway, with its data in
`/.lazurio/shell.json` (LazurioPlatform decision F36). MausBot knows nothing
of Lazurio's data and fetches nothing itself, so a new rail, a new picker or
new data needs no release of this fork.

The slot is two upstream files, each its own line in
`allowed_upstream_changes`:

- `index.html`: `<script type="module" src="/.lazurio/shell.js" vite-ignore>`
  (Vite leaves the tag as it is and bundles nothing), `<lazurio-rail>` before
  `#root` and `<lazurio-buddy>` after it, and
  `#root { box-sizing: border-box; padding-left: var(--lazurio-rail-width, 0px); }`
  (padding, not margin, so the app never overflows past the right edge; the
  rail positions itself), and the shell's colour roles on `:root`
  ([below](#colours-of-the-shell)).
- `src/components/Sidebar.tsx`: `<lazurio-column-head active="automate">` as
  the first child of the sidebar's top bar, above upstream's own top row,
  which stays with all its controls (0179 point 6: upstream's look and brand
  stay).

The release contract test checks both, so a rebuild on a new upstream tag
that loses the slot fails CI. The switch and the rail are plain links to the
Environment's other origins, so MausBot's router does not change. Nothing
renders outside Lazurio: without `/.lazurio/shell.js` the elements stay
undefined, the rail's width is 0 and the app behaves as upstream (the browser
only logs the failed script). MausBot itself is not recoloured or renamed.

### Colours of the shell

**Decided on 2026-10-04.** The shell's elements take the colours of the app
they sit in, through colour roles: custom properties the host sets on its
document root, which the elements' shadow roots inherit. `index.html` sets
them from the active skin's own tokens, and a skin is the `data-skin`
attribute on `<html>`, so the roles follow every skin, live:

| Role | MausBot token |
| --- | --- |
| `--lazurio-surface` (the rail, the column behind the head) | `--color-panel`, the sidebar |
| `--lazurio-ink`, `--lazurio-overlay-ink` | `--color-ink` |
| `--lazurio-ink-muted` | `--color-ink-secondary` |
| `--lazurio-line` | `--color-hairline` at 40 % over the panel |
| `--lazurio-line-strong` | `--color-hairline` |
| `--lazurio-hover` | `--color-raised` at 40 % over the panel |
| `--lazurio-selected` | `--color-raised` at 70 % over the panel |
| `--lazurio-control` | `--color-inset` |
| `--lazurio-raised` | `--color-raised` |
| `--lazurio-overlay` | `--color-menu` |
| `--lazurio-focus` | `--color-focus` |

The mixes are the sidebar's own (`hover:bg-raised/40`, `bg-raised/70`,
`border-hairline/40`). The rail is the sidebar's panel, so the two read as
one surface with no line between them; the sidebar has no left border. The
skins and the skin picker stay upstream's; one theme across Lazurio's apps
is a later mechanism, not part of this fork. Nothing in MausBot reads the
roles, so outside Lazurio it looks exactly as upstream. The release contract
test checks the roles and that every token they read is still declared by
the skins, so a rebuild on an upstream tag that renames a token fails CI.

How to release, rebuild on a new upstream tag, what the overlay contains and
how Machines consume a release:
[`docs/operations/lazurio-fork-release.md`](docs/operations/lazurio-fork-release.md).

Agents working in this repository follow upstream's `AGENTS.md` for code and
verification, and this contract for branches, releases and the overlay.
Code, commits and pull requests are in English. Pull requests go to
`Lazurio/OpenMausBot`, never to `milind-soni/OpenMausBot` unless a change
is deliberately proposed upstream.
