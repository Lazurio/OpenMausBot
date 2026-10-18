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

  a saved config). Since v0.1.130 also treg research and the X card with
  their keys, the phone's apps as bot tools, app-event Automations (app
  triggers, `list_trigger_events`), MCP app connections, a team's shared
  connections, apps a bot inherits from its Chief and the suggestion to add
  a helper-model key. Every Claude bot gets the Environment's user-scope MCP
  own configuration folders, the Cursor sign-in for a Grok Bot import (the
  paste import stays), and with them the server's sign-in sessions and
- **Own computers**: Local VMs (Cua containers) with their image updates, the
  Boat cloud computer, VPS computers and a bot's VPS alias, lent, shared and
  team computers with the team map's computer screens, "Works on" and
  `select_computer`, and lending this computer to My Cloud ("Let your bots use
  this Mac", lent folders, drives and terminal), in the server, the web app
  and the desktop app. Bots work on the host and in the browser.
- **MausBot Cloud**: purchase and upsell, the Pro plan and its pop-up, Cloud
  credit, the usage meter and plan cards, sleep and wake, a Cloud's first
  hour, what a Cloud's bots say to connect and the keys it holds, the Team
  Cloud dashboard, the Cloud's included decision and extraction relay, moving
  to and syncing with Cloud (Send everything, Keep up to date, Keep here, a
  bot's move into a team, Cloud files sync in the desktop app), and the
  OpenMausBot account sign-in (`openmausbot login`). The cloud-home and Team
  Cloud server modes themselves, upstream's own hosting, stay for now: they
  are woven into owner and guest checks and do nothing on an Environment.
- **Published pages**: publishing a bot's page to upstream's `*.mausbot.page`
  host with a MausBot account (`publish_page`, `unpublish_page`, Share on a
  page's card, the published-page card). A page shows in the chat from the
  bot's folder, as before.
  (`approvePeerComms`) with its approval cards; since v0.1.130 also the "Send
  on your behalf?" hold on a bot's outbound messages, the Ask a new bot was
  started on, and the "Allow once?" before a bot used this computer. A saved
  Custom level, grant
- **Telemetry to upstream**: upstream's PostHog analytics, the welcome
  tour's name and e-mail form, the `@devs` bug report to the MausBot team
  (`report_bug`) with the recent log it attached, and the "Product updates by
  email" question in the web and desktop apps. `src/lib/analytics.ts` keeps upstream's
`localVm`, `composio`, `treg`, `mcpServers`, `features.sharedComputers`,
`browser`, `browserProfile`, `recordBrowserSteps`, `vpsAlias`,
`appsFromCreator`, `xResearch` or `phoneApps`. Every bot and thread
its own Cloud, desktop-viewer and Cua driver code is left as upstream has it,
apart from what the server no longer answers (lending, Cloud files sync, the
product-updates question, published pages and the X research token); the
forbidden strings leave its own Cloud files (`electron/cloud-*`) out of the
scan.
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

The slot is two upstream files, each its own line in
`allowed_upstream_changes`:

- `index.html`: `<script type="module" src="/.lazurio/shell.js" vite-ignore>`
  `body > #root { box-sizing: border-box; padding-left: calc(var(--lazurio-rail-width, 0px) + env(safe-area-inset-left, 0px)); }`
  (padding, not margin, so the app never overflows past the right edge; the
- `src/components/Sidebar.tsx`: `<lazurio-column-head active="automate">` as
  the first child of the sidebar's top bar, above upstream's own top row,
  which stays with all its controls, in the Simple and the full sidebar
  alike (upstream #3008; 0179 point 6: upstream's look and brand stay).

The release contract test checks both, so a rebuild on a new upstream tag
that loses the slot fails CI. The switch and the rail are plain links to the
Environment's other origins, so MausBot's router does not change. Nothing
renders outside Lazurio: without `/.lazurio/shell.js` the elements stay

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
roles follow the Environment skin like any other skin. Nothing in MausBot
reads the roles, so outside Lazurio it looks exactly as upstream. The
release contract test checks the roles and that every token they read is
still declared by the skins, so a rebuild on an upstream tag that renames a
token fails CI.

### The Environment skin

**Decided on 2026-10-18 (root decision 0208).** A Lazurio Environment has
one colour theme, the Environment theme, chosen in Apps → Settings; Chat,
Apps and Automate follow it. The Environment's shell declares it in this
document as the design system's tokens (`--lz-*`, only names interface v1
promises): the light values, and the dark ones where the theme has them,
each with its `--lazurio-color-scheme`. MausBot follows it through one more
skin, **Environment**, added the way upstream adds a skin: one block in
`src/styles.css` and one line in `SKINS` (`src/lib/skins.ts`). The block
only names the tokens, in the roles Chat gives them, and every value falls
back to Midnight's, so without the shell the skin is Midnight:

| MausBot token | Environment theme token |
| --- | --- |
| `--color-app`, `--color-menu`, `--color-composer` | `--lz-surface` |
| `--color-panel`, the sidebar and so the rail | `--lz-paper` |
| `--color-card` | `--lz-gray-50` |
| `--color-raised`, `--color-inset`, `--color-control` | `--lz-gray-100` |
| `--color-raised-hover`, `--color-bubble-user`, `--color-hairline`, `--color-composer-ring`, `--color-scrollbar` | `--lz-line` |
| `--color-ink`, `--color-bubble-user-ink`, `--color-focus` | `--lz-ink` |
| `--color-ink-secondary`, `--color-ink-tertiary`, `--color-maus-line` | `--lz-ink-muted` |
| `--color-accent`, the solid controls | `--lz-accent-button` |
| `--color-accent-border` | `--lz-accent-button-hover` |
| `--color-accent-text`, the links | `--lz-accent` |
| `--color-accent-ink`, `--color-danger-ink`, `--color-success-ink` | `--lz-on-accent` |
| `--color-success`, `--color-danger`, `--color-warning` | `--lz-success`, `--lz-danger`, `--lz-warning` |
| `--code-color-scheme` | `--lazurio-color-scheme`, dark without it |

The type and corners stay Midnight's: the Environment theme is a colour
theme. Bots' name colours (`--identity-*`) follow the thread they sit on:
Midnight's in the block, like every fallback; with the theme's light values
Meadow's, the tones upstream fits to a white thread; and where the theme's
dark values apply (a dark device), Midnight's again. Two short rules after
the block set them, keyed on the theme's marks.

- **The default on an Environment.** When the shell declares the
  Environment theme it marks `<html data-lazurio-environment-theme>`: with
  the theme its origin remembers as soon as it runs (`index.html` loads it
  ahead of MausBot's own module), and on a browser's first visit once it read
  its document, announced as `lazurio-theme`. Where the mark is, the
  Environment skin is the default and the picker offers it as its first
  card. A browser that ran MausBot there before moves to it once, on its
  first load with the mark or on that announcement: `omb-skin` was written
  on every boot, so a stored skin cannot tell a pick from the default.
  `omb-skin-environment-moved` records the move, and a skin picked after it
  sticks. A Platform before decision 0208 marks only its tokens
  (`data-lazurio-theme`), without the theme's colour scheme; there nothing
  changes.
- **The picker is a personal override.** Another skin applies in this
  browser only, and the Environment card is the way back. A new Environment
  theme resets nobody's pick; the Environment skin shows it as soon as the
  shell declares it.
- **Light and dark.** MausBot has no light and dark of its own:
  `index.html` marks `<html data-lazurio-appearance="device">`, so where the
  theme has dark values, they follow the device. The Lazurio theme, the
  design system's, is light only for now, and so is the Environment skin on
  it.
- **Outside Lazurio** nothing marks the document: the Environment skin is
  neither the default nor offered, and MausBot looks as upstream. A stored
  Environment skin, from a backup or a load while the Launchpad is down,
  renders as Midnight and follows the theme again once the shell is back.

Its colours exist only at runtime, so upstream's checks that measure a
skin's values leave it out (`src/lib/faded-text.test.ts`,
`src/lib/bot-identity.test.ts`, `src/lib/user-bubble-tone.test.ts`,
`electron/skin-overlay.test.mjs`, `pnpm check:contrast`). The release
contract test checks that the block reads only promised names, each with
Midnight's value as its fallback, that nothing else in `src/styles.css`
reads the theme, and the mark in `index.html`;
`src/lib/environment-skin.test.ts` tests the default, the one-time move (also
on a first visit's announcement), a Platform that marks only its tokens and
the picker. Known limit: a Mermaid diagram already on screen keeps the
light or dark it was drawn in until it is drawn again, because upstream
redraws diagrams on a change of skin only. The Platform release that
declares the Environment theme goes out first (decision 0200), on Ring 0
first (decision 0204); a fork release before it changes nothing, since
without the theme's mark the skin is neither the default nor offered.

How to release, rebuild on a new upstream tag, what the overlay contains and
how Machines consume a release:
[`docs/operations/lazurio-fork-release.md`](docs/operations/lazurio-fork-release.md).

Agents working in this repository follow upstream's `AGENTS.md` for code and
verification, and this contract for branches, releases and the overlay.
Code, commits and pull requests are in English. Pull requests go to
`Lazurio/OpenMausBot`, never to `milind-soni/OpenMausBot` unless a change
is deliberately proposed upstream.