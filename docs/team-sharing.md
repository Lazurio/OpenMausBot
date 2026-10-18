# Sharing a whole department

The sidebar groups bots into departments. **Share department…** saves one department as a single file (`<team>-<version>.openmaus.json`).
Someone else adds it in **Templates → Import**, or an organization uploads it
in Admin → Packages and its desktops add it from **Templates → From
{Organization}** ([org-library.md](org-library.md)). Open it from the department's menu in the sidebar (right-click
the department name), or from **Templates → Share**.

## What goes in the file

- **Bots.** Each bot's name, title and description, its standing instructions,
  its colour and mascot, and its picture (downscaled to at most 256 × 256 and
  64 KB; the dialog stops adding pictures after about 2 MB of them).
- **Skills.** All skills on the team's bots by default, or the ones you tick.
  Only the `SKILL.md` text travels, never scripts or other files. A file
  holds at most 30 skills per bot and 60 per team, and one skill per name.
  When you have not chosen, the dialog puts in what fits (switched-on skills
  first) and lists the rest under **Left out**, including a name two bots
  hold with different content. The skill boxes then start ticked on what
  went in, less any skill a bot had to leave out over its 30 (even when
  another bot's copy went in), so unticking any box is always a choice that
  fits. When you tick more than fits, it says why and keeps every skill box
  so you can change the choice.
- **Playbooks**, **group chats** (members and who answers by default) and the
  team's **shared instructions**.
- **Routines**, including group chat goals. They always arrive paused.
- **The Chief of Staff.**
- **Starter notes.** Each bot's `MEMORY.md` and topic notes. **Include
  starter notes** is ticked, because a team is shared whole; untick it if the
  notes hold private details about you. Daily logs never go in.
- **Your New bot defaults as a preset**, only when you tick **Include my New
  bot defaults as a preset**: their name, look, standing instructions, skills
  and (with starter notes) notes, never their model, folder, computer or
  approval level. See [presets.md](presets.md).

## What never goes in the file

Chat history, keys and passwords, model choices, computers, and who can see
each bot. The file format has no field for any of them. Routine attachments
are left out.

Text can still contain a secret someone typed into it. Before the file is
written, every text part is checked with the same detectors the app uses for
its logs. Anything that looks like a key or password is replaced with a
marker, and the dialog lists which parts were changed. The Admin upload runs
the same check again and refuses a file that still contains one.

The dialog shows, before you save, exactly what the file holds (counted by the
server from the same export), and afterwards what was removed or left out.
There is no confirmation step: **Save file** is the decision.

## Versions and identity

The first time a team is shared it gets a package id (from its name) and each
bot, group chat and routine gets a key. Later shares of the same team reuse
them, even after renaming the team or anything in it, and suggest the next
version (1.0.0, then 1.0.1, …). A team first added from a shared file keeps
that file's package id and bot keys, so "import the published release, edit,
share again" produces the next release of the same package. The record lives
in `published-teams.json` in the data folder.

## Adding a shared team

Import is additive: everything becomes new records in a new team (numbered if
the name is taken). Nothing in the file can change a bot, group chat or team
you already have.

- Bots start at the default approval level, **Full access** (Ask on a hosted
  company workspace), with the installation's default model. A suggested approval level in the file is recorded, never
  applied.
- Skills arrive **switched off**; routines arrive **paused**.
- Starter notes are written once, through the normal memory writer.
- Preset bots in a file appear in **New bot** under **Imported presets**; a
  bot made from one gets the preset's skills switched off
  ([presets.md](presets.md)).
- A preset file (skills and presets, no bots) adds its presets to New bot and
  nothing else. A file with only skills has nothing to add here and is
  refused with a pointer to the organization shelf (**Templates → From
  {Organization}**, see [org-library.md](org-library.md)).

If any step fails, everything the import created is removed again.

## From Grok Bot

A shared Grok Bot link (`https://x.ai/bot/<id>`) can become a Maus bot from
**Templates → Import → From Grok Bot**. Pasting the link into the GitHub box,
or opening `openmausbot://install?url=https://x.ai/bot/<id>`, does the same.
The same Grok Bot import is on **Settings → Import** (next to Backups, with
**From your AI apps**: the welcome tour's skills and MCP tools import from
Claude Code, Codex, Cursor, Claude Desktop and Gemini) and as an optional
"Have a Grok Bot? Paste its link" row in the welcome tour's import step.

1. Paste the link. Maus reads the public page and shows a card with the
   bot's name, creator and description. That is all the public page holds:
   its instructions, skills and routines are visible only inside Grok Bot.
2. Press **Copy export prompt**, paste it into your own Grok Bot (the one you
   added from the link, or made yourself), and paste its reply into the box.
   The reply is one JSON block (`"format": "openmaus.grok/1"`).
   [pi-grokbot-import](https://github.com/Shixuuu/pi-grokbot-import)'s
   `grokbot-bundle/v1` files work too, pasted or dropped as a `.json` file.
3. The usual preview opens. **Add** imports it like any shared team.

What comes over: the name and description, the full standing instructions
(cut at 24,000 bytes, with a note), skills (switched off), routines with a
cron or a plain time such as "weekdays at 9am" (paused), the apps it used as
connector requirements, and memories when you asked for them. Routines that
start on an event (a Slack message, a GitHub event, an email) or whose
schedule cannot be read are listed under **Left out** with their original
text, so you can set them up by hand. The model, the computer, logins and MCP
servers never come over; the bot uses your own engine and apps.

Without Grok Bot, **Start from description** makes a bot from the public name
and description alone, credited "Based on x.ai/bot/<id>".

After **Add**, when the bot has apps to connect or something was left out,
the panel offers **Have your Chief of Staff finish the setup** (or the
imported bot itself, without a Chief). It opens that chat with a message
ready, never sent: which bot came from which link, the apps to connect (with
their Composio names), Grok Bot tools with no match, and the left-out
routines with their original text.

Maus reads `https://x.ai/bot/<id>` (redirects must stay on x.ai, 20 s,
2 MB) through `POST /api/team-library/grok`, an admin route. Maus never
opens `grokbot://` links. The mapping lives in `shared/grok-import.ts`.

## The file format

`openmaus.package` version 2, defined in `shared/package-format.ts`, the one
module the app, the import preview and Admin all validate with. It still
reads version 1 files (JSON and the BotMRR Markdown playbook). Older apps
refuse version 2 files with their existing "not supported" message; Admin can
produce a version 1 download for them. A file is at most 4 MB. Example files
and their expected hashes live in `shared/package-fixtures/`.

The HTTP route is `POST /api/teams/export` with
`{"format":"package","version":2,"team":"Sales desk"}` (admin scope). Optional
fields: `name`, `tagline`, `summary`, `release`, `notes`, `skills` (`"all"` or
names), `includeMemory` (default `false` over the API), `avatars` (data URLs
by bot id) and `dryRun` (count without recording keys). The response is
`{document, filename, redacted, skipped, summary, choices}`. With
`skills: "all"` the export puts in the skills that fit and lists the rest in
`skipped`; a list of names is shared exactly or refused. Every `400` from a
version 2 body also carries `choices: {skills}` (every skill name on the
team's bots), so a client can offer a different choice. `includeDefaultsPreset:
true` adds the New bot defaults preset, and `kind: "library"` (instead of
`team`) saves a preset file; both are described in [presets.md](presets.md).
A body without `version: 2` keeps the original whole-installation Markdown
export.
