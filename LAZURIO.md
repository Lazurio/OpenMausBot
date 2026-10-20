# Lazurio OpenMausBot: fork contract

`Lazurio/OpenMausBot` is Lazurio's distribution of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0), the
runtime for the bot teams of Lazurio Environments (Lazurio decision 0169;
plans DEV-6632 and DEV-6673 in the Human and Machine Mission Control). It
follows the `Lazurio/t3code` model:

- **Upstream's core, shaped by Lazurio's model.** Bots, roles, teams,
  planning, routines and chat stay upstream's, with upstream's look and
  branding, built without `enterprise/` (below). Where upstream assumes
  something Lazurio's model contradicts (a computer, browser, sign-in or
  access level per bot), the overlay changes it and removes upstream's way
  from the code ([principles](#how-lazurio-shapes-mausbot)). Anything that
  could live upstream is written to be proposed upstream.
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

## How Lazurio shapes MausBot

Read this before you change behaviour here. MausBot is one of the three apps
of a Lazurio Environment: Chat (Lazurio's T3 Code), Apps (the Launchpad) and
Automate (MausBot). The Environment, not MausBot, owns the computer, its
programs, the browser, the sign-ins and the integrations. Where upstream
assumes otherwise, the overlay follows these principles. They come from the
root decisions of `HumanAndMachines/Lazurio` (`manual/decision-register.md`:
0162, 0169, 0172 with its addendum of 2026-10-19, 0181, 0191 with points 34
and 41–43, 0195, 0209) and `manual/environment-browser.md`; plan DEV-6673
builds them.

1. **One Environment is one computer.** Bots, T3 Code threads, other agents
   and Buddy work in the same Environment: the same files, programs, browser
   and sign-ins. A bot is to MausBot what a thread is to T3 Code, a way to
   run an agent there, never a computer of its own: no VMs, cloud computers,
   lent, shared or team computers, and no sandbox per bot.
2. **Full access by default, for every bot.** Every bot runs at Full, as
   T3 Code runs `full-access`, without anyone turning it on: no default Ask,
   no approval before contacting another bot, no warning gate before Full.
   A person may choose to supervise a piece of work, as T3 Code allows;
   nothing chooses it for them. Narrower rights mean a separate Environment.
   Full access is not consent to publish: merges, releases and writes to
   connected apps keep their own gates.
3. **Access is shared, never split per bot.** Wherever the Environment is
   signed in, every bot reaches: the Environment browser, the tools and
   Integrations of the Launchpad Settings (an app's own tool, Executor,
   Composio) and the CLI logins (`gh`, `codex`, `claude`). MausBot has no app
   switches, MCP registries, keys, saved logins or accounts per bot, and holds
   no credentials of its own. Engines use the Environment's CLI logins; a
   signed-out engine links to the Launchpad Settings
   ([Engine sign-in](#engine-sign-in)). AI accounts come from there too
   (the Organization's AI pool, 0181 and 0209).
4. **One browser; a bot works in its own tabs.** The Environment has one
   browser (one Chromium with one profile, DevTools on `127.0.0.1:9222`).
   A bot opens its own tabs in it through Lazurio's `agent-browser`, as a T3
   Code thread does, with the session `bot-<id>`. The bot's strip holds its
   tabs in its holder file (`bot-<id>.json`), which MausBot's server writes;
   deleting or archiving the bot removes its tabs there and ends the bot's
   `agent-browser` session, so its daemon holds nothing, and the Platform's
   hub ends a tab nothing holds. A person sees a bot's tab
   and works in it at the same time as the bot, in MausBot's right panel,
   through the Platform's view (`browser.<…>/t/<id>`) and New tab: the same
   view as in T3 Code and the Launchpad, from the Platform's vendored browser
   contract. MausBot builds no browser, viewer, profile manager, egress proxy
   or `agent-browser` configuration of its own.
5. **Programs run on the Environment's screen.** Programs installed in the
   Environment (Blender, for example) run on its one screen. Bots use them
   through Computer Use on the Environment desktop, taking turns with other
   agents, since there is one mouse and keyboard; the browser keeps running
   beside it. The desktop is the second wave of the Environment browser plan
   (DEV-6646); until then bots work in the shell and the browser.
6. **Everything starts in the Lazurio Folder.** Bots start in the Folder,
   read its `AGENTS.md` and guides, and create worktrees as those guides say.
7. **Results reach people through Chat.** A bot hands a result worth
   reporting to a T3 Code thread, which tells the person (Lazurio/LazurioPlatform#182).
   T3 Code agents, and later Buddy, create and manage bots through MausBot's
   CLI and MCP.
8. **Remove, don't hide.** What contradicts these principles leaves the
   code, the API, the CLI, the agents' tools, the UI and the documentation,
   so no agent finds it; the manifests in `lazurio/removals/` keep it gone
   ([below](#what-the-overlay-removes)). No compatibility or migration code:
   MausBot does not run on customer Environments yet.
9. **Like Lazurio's T3 Code wherever both do the same thing.** The right
   panel, the model picker, engine sign-in, access level and the words people
   read follow Lazurio's T3 Code rather than upstream MausBot (0191 point 34).
   To people a Lazurio Environment is "Prostředí", a browser tab is "karta",
   and Czech addresses them formally (vykání).
10. **A fork that rebuilds.** The overlay stays a short linear patch stack on
    an exact upstream tag, Lazurio-only code lives in Lazurio-named modules,
    and each change says which principle it serves.

**Today against the principles (2026-10-19).**
- **Done:** removed MausBot's own computers, integrations, sign-ins, Cloud
  and telemetry (1, 3 and 8); per-bot tool selection, so every bot gets the
  Environment's tools (3); engine sign-in through the Launchpad (3); every
  bot at Full on every server, with T3 Code's four levels and no gate before
  Full, before Auto or before contacting another bot (2,
  [Access levels](#access-levels)); the Folder as every bot's start (6).
- **Not yet:** bots run their own `agent-browser` daemons with their own
  headless Chrome, and MausBot shows its own live view in the "Computer"
  panel (4). There is no Computer Use on the Environment desktop (5) and no
  report to Chat (7).

Until a gap is closed the sections below describe the code as it is; plan
DEV-6673 tracks each gap.

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
signed in from the Launchpad Settings, and reach MCP servers such as Executor
through the Folder's `.mcp.json` and `~/.codex/config.toml`. MausBot's own
connected apps, computers and sign-ins are removed from the code
([below](#what-the-overlay-removes)). Narrower access than the Environment's
means a separate Environment.

### Engine sign-in

**Decided on 2026-10-19 (the Organization Admin): as in Lazurio's T3 Code.**
Engines use the Environment's own CLI login, which the person connects in
the Environment settings of the Environment's Launchpad (Getting started,
`/settings/start`). MausBot keeps no sign-in of its own: it only reads each
engine's login status. The Launchpad signs in Codex (`~/.codex`) and Claude
(`~/.claude`), the engines of LazurioPlatform's `src/launchpad/ai-sign-in.ts`.
When one of them is signed out, its card says that the account is connected
in the Environment settings and offers two things: **Otevřít Nastavení
Prostředí**, a link to Getting started of this Environment's Launchpad opened
in a new tab (as T3 Code's "Open Getting started"), and **Zkontrolovat
znovu**, which reads the machine login again. It shows no terminal command
and starts no device, OAuth or pasted-code flow. The chat's line for a turn
Codex or Claude refused signed out says the same. Every other engine the
Launchpad cannot sign in (Cursor and the other subscription CLIs) keeps
upstream's card with its own CLI command, run on the Environment's machine;
ACP's native `authenticate` for them is that same CLI login, not a
credential MausBot holds.

The person's language comes from the shell's document, `lazurio.shell.v1` at
`/.lazurio/shell.json` on this origin (`locale`; Czech unless the profile is
English). The link is shown only when everything binds to this Environment:
the page is `mausbot.<base>.lazurio.io`, the document's `current` is `<base>`,
that Environment's `apps.apps` is exactly `launchpad.<base>.lazurio.io` with
the page's scheme, and the document came from this origin without a
redirect. Otherwise the card names the Environment settings without a link.
This is the one thing MausBot reads of the shell's data. Outside Lazurio the
shell's script does not run, so `<html>` carries no `data-lazurio-theme`,
nothing is read and upstream's card, with the engine's own sign-in command,
stays. The Lazurio side is one module,
`src/components/LazurioEngineSignIn.tsx`, with one hook in
`src/components/EngineSetup.tsx` and one in `src/components/ChatView.tsx`;
`src/components/LazurioEngineSignIn.test.ts` covers Codex and Claude under
the shell, the English profile, a foreign Launchpad origin, a mismatched
`current`, a redirected or foreign-origin document, an unreadable document,
Cursor keeping upstream's card, and the card outside Lazurio.

### Access levels

**Decided on 2026-10-19 (the Organization Admin; root decision 0172 with its
addendum of 2026-10-19).** Every bot runs at **Full access** by default, as
Lazurio's T3 Code runs `full-access`, on every server, a hosted company
workspace included, and nothing turns it on, lowers it or asks first. A
person may choose to supervise a bot or a conversation with the levels of
T3 Code: Ask for approval (`approval-required`), Auto-accept edits
(`auto-accept-edits`) and Approve for me (`auto`), on a bot, a thread, at
creation or as the new-bot default; nothing chooses one for them. A level
the bot's engine does not run (Auto-accept edits on Codex) is refused when
the bot is created, as on a thread. Bots contact, delegate to and post in rooms without a person's
approval. Real questions a bot needs answered, and missing sign-ins, still
reach a person, and under a supervised level OpenMausBot's own proposals
(profile, routine, team setup, skill) keep their review cards. Full access is
not consent to publish: merges, releases and writes to connected apps keep
their own gates (the Steward team's rules, GitHub rights and branch rules).
Narrower rights mean a separate Environment. What upstream had beyond this
is removed ([below](#what-the-overlay-removes)), and
`server/lazurio-full-access.e2e.test.ts` checks it on a real server.

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
- **Automations from the command line**: `openmausbot routine`, `webhook`
  and `bot list|show`, and the same routine and webhook operations as tools
  of `openmausbot mcp`
  ([`docs/headless-cli.md`](docs/headless-cli.md#routines-and-webhooks)).
  Agents and Buddy manage MausBot's automations through this CLI, as a person
  does on its Automations page, in every Environment they reach: the Environment
  is the boundary (Lazurio decision 0172), and the server trusts a caller on
  its own computer as its owner, named by the port of the Machine's MausBot
  (`--port` or `OMB_PORT`). On an Environment the command is the release's
  `cli.js` under `~/.local/share/lazurio/mausbot/current/`, run with the
  Environment's `node`. A webhook's secret is printed only with
  `--show-secret`, or saved to a file only its owner can read. Each command
  calls its MCP tool (`scripts/mcp-automations.ts`), which uses the app's own
  routes. Upstream-friendly; propose it upstream.
- **The Lazurio shell slot** in `index.html` and the sidebar
  ([below](#the-lazurio-shell)); nothing renders outside Lazurio.

## What the overlay removes

**Decided on 2026-10-18 (issue #35, DEV-6673 M3).** What contradicts the
Lazurio model is removed from the code, not hidden: agents read the source,
the CLI and the API, and must not find tools Lazurio does not want them to
use. One Environment is one computer; its bots and agents share it and its
signed-in accounts, and integrations come from the Environment.

- **Own integrations**: Composio (key, managed broker and its Worker,
  connector tools, per-bot app switches, the Apps panel and its sidebar
  button), HighLevel, Whop, the tool directory for big apps, the per-bot MCP
  server registry, and the first-run import of other apps' settings, skills
  and MCP servers. Claude bots still read the Folder's `.mcp.json` (and, with
  "Also use my Claude Code MCP servers", the person's own setup); Codex bots
  read `~/.codex/config.toml`.
- **Own sign-ins**: saved logins (`fill_login`), 1Password and the in-app
  Claude, Codex and Grok sign-in flows, the ChatGPT plan engine with its own
  OpenAI sign-in (the Codex engine already reads the Environment's ChatGPT
  login), the Antigravity engine with its own Google sign-in and runtime (the
  Launchpad has no Antigravity sign-in), and added Claude accounts with their
  own configuration folders, and with them the server's sign-in sessions and
  the `/api/instances/:id/auth/*` routes. Engines use the computer's own
  logins (`codex login`, `claude auth login`, done in the Environment
  settings) and MausBot only reads their status
  ([above](#engine-sign-in)). A saved `config.json` that still has a removed
  engine or account loads and drops it; a bot that used one shows its engine
  unavailable until another is picked.
- **Own computers**: Local VMs (Cua containers), the Boat cloud computer, VPS
  computers, lent, shared and team computers, "Works on" and
  `select_computer`. Bots work on the host and in the browser.
- **MausBot Cloud**: purchase and upsell, the Pro plan, Cloud credit, moving
  to and syncing with Cloud, and the OpenMausBot account sign-in
  (`openmausbot login`). The cloud-home server mode itself, upstream's own
  hosting, stays for now: it is woven into owner and guest checks.
- **Gates before full access**: a hosted workspace's Ask default and its
  refusal of Full without the operator flag `OMB_SHARED_WORKSPACE_FULL_ACCESS`;
  the Custom (`config.toml`) level with the desktop's private two-phase grant
  (Electron's approval coordinator, its IPC channel and the server's grant
  journal); the warning before Auto (`acknowledgeLocalAuto`); and the
  per-bot switch that made a bot ask a person before contacting another bot
  (`approvePeerComms`) with its approval cards. A saved Custom level, grant
  marker or switch loads and drops; a write that names one, or the removed
  confirmation, is refused with 400 ([Access levels](#access-levels)).
- **Per-bot tool selection** (decided by the Organization Admin on
  2026-10-20, issue #47; root decision 0172 with its addendum of 2026-10-19):
  `toolScope` with its allow and deny selectors (`native:NAME`,
  `mcp:SERVER:NAME`), Settings → Tools, and every engine path that narrowed
  the native or MCP tools offered to one bot (Claude, Codex, the ACP engines
  with Grok, Pi, the API models), with their verification scripts. Every bot
  gets the tools the Environment provides; narrower access means a separate
  Environment. A bot's peers (who it may contact) stay: that is the team's
  shape, not access. A saved selection, in `bots.json`, the new-bot defaults
  or a team backup, loads and drops; a team file's `tools` is ignored with a
  warning; a write that names `toolScope` is refused with 400.
- **Telemetry to upstream**: upstream's PostHog analytics and the welcome
  tour's name and e-mail form. `src/lib/analytics.ts` keeps upstream's
  function names as no-ops, so nothing is collected, stored or sent.

A write that names a removed setting (`PUT /api/config` with `box`, `vps`,
`localVm`, `composio`, `mcpServers`, `features.sharedComputers` or a removed
new-bot default, `approvePeerComms`, `toolScope` and the Custom level included) is refused
with 400 as a whole, never half-applied; a saved `config.json` that still has
one loads and drops it. So is every bot and thread write (`POST`, `PUT` or
`PATCH` under `/api/bots`) whose body names `acknowledgeLocalAuto`,
`approvePeerComms`, `approvalGrant`, `toolScope` or the Custom level, at its top or in its
`settings`: the route table reads such a body through
`refusingRemovedBotSettings` (`server/lazurio-removed-config.ts`), which
answers 400 before any route changes anything.

Each area has a manifest in [`lazurio/removals/`](lazurio/removals): the
upstream files it deletes and changes (CI allows exactly those), the strings
no shipped source, catalog or document may contain any more
(`scripts/lazurio-removals.node-test.mjs`) and the API routes that must answer
404 on the running server (`server/lazurio-removals.e2e.test.ts`). A rebuild
on a new upstream tag re-applies each area by intent; the manifests say what
must stay gone. The Electron desktop app is not part of the distribution, so
its own Cloud and desktop-viewer code is left as upstream has it.

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
of Lazurio's data and fetches nothing itself, apart from the Launchpad's
address and the language for a signed-out engine's card
([Engine sign-in](#engine-sign-in)), so a new rail, a new picker or new data
needs no release of this fork.

The slot is two upstream files, each its own line in
`allowed_upstream_changes`:

- `index.html`: `<script type="module" src="/.lazurio/shell.js" vite-ignore>`
  (Vite leaves the tag as it is and bundles nothing), `<lazurio-rail>` before
  `#root` and `<lazurio-buddy>` after it, and
  `body > #root { box-sizing: border-box; padding-left: calc(var(--lazurio-rail-width, 0px) + env(safe-area-inset-left, 0px)); }`
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
only logs the failed script). MausBot itself is not renamed, and only the
Environment skin recolours it ([below](#the-environment-skin)).

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
