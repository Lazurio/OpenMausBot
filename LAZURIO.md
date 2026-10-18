# Lazurio OpenMausBot: fork contract

`Lazurio/OpenMausBot` is Lazurio's distribution of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0), the
runtime for the bot teams of Lazurio Environments (Lazurio decision 0169;
plans DEV-6632 and DEV-6673 in the Human and Machine Mission Control). It
follows the `Lazurio/t3code` model:

- **Upstream's product, the open-source edition.** Functionally upstream
  OpenMausBot, with upstream's look and branding, built without
  `enterprise/` (below). The only UI change is the slot of the Lazurio shell.
  Anything that could live upstream is written to be proposed upstream.
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
signed in from the Launchpad Settings. OpenMausBot's own **Connected apps**
(a Composio project key with its own Composio user) stay unconfigured: they
would hold a second, separate set of connections. Narrower access than the
Environment's means a separate Environment.

## What the overlay adds

- **The open-source edition.** Upstream's `enterprise/` folder is removed
  from the tree: it is under the OpenMausBot Enterprise License, which forbids
  redistribution and hosting for third parties (`LICENSING.md`, issue #35).
  The server reports `{"edition":"oss"}`. `lazurio/vitest.config.mjs` skips
  the three upstream tests that read the layer's source; CI, the contract
  test and the archive smoke fail if the folder comes back or is packed.
- **Release distribution**: this file, the runbook, the `lazurio-*`
  workflows, the archive script and the contract and CI-scope tests.
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
- **Steward team**: [`lazurio/teams/steward.openmaus.json`](lazurio/teams/steward.openmaus.json),
  a leader (Henry, Chief of Staff, delegating through `coordinate_bots`) and
  three workers who review pull requests on their exact head and publish only
  on an explicit instruction. Releases ship it at `package/lazurio/teams/`,
  so an Environment imports it from the installed release (Templates →
  Import, or `POST /api/teams/import`) and points `OMB_GITHUB_INTAKE_BOT` at
  the leader. Another persona imports the same file and renames the leader;
  nothing in the instructions names the persona. Steward teams run on
  **Full access, without a sandbox** (Organization Admin decision of
  2026-10-01, issue #3): the Environment, one Machine with one operator, is
  the boundary. Full is upstream's default level (#2808), so imported bots
  start on it and nothing needs setting; Full also survives an engine
  change. Questions and missing credentials still reach a person; GitHub
  rights and branch rules stay the limit.
- **The Lazurio shell slot** in `index.html` and the sidebar
  ([below](#the-lazurio-shell)); nothing renders outside Lazurio.

## The Lazurio shell

**Decided on 2026-10-03 (the Lazurio shell decisions); in the overlay since
issue #16.** The overlay adds only a slot for the Lazurio
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
  which stays with all its controls, in the Simple and the full sidebar
  alike (upstream #3008; 0179 point 6: upstream's look and brand stay).

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
