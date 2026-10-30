# WhatsApp intake (Lazurio MausBot)

The WhatsApp intake lets one bot of an ordinary MausBot server answer in
WhatsApp groups. Plain code receives the Environment's WhatsApp messages from
[wacli](https://github.com/openclaw/wacli), keeps only the groups the operator
mapped, and wakes the bot only when someone mentions the account, replies to
it, or leaves a question unanswered in a group that went quiet. The bot answers
with JSON; the intake alone decides whether that text goes to the group or, as
a draft, to the operator. No model runs while nothing asks for one.

It is a standard feature of Lazurio MausBot, not tied to one persona or
provider: the group map, the client notes and the bot's instructions are the
operator's content and live outside this repository.

## Turning it on

The intake is off unless the server starts with `OMB_WHATSAPP_INTAKE=1`.
Unset, the server behaves exactly as upstream OpenMausBot.

| Variable | Meaning |
| --- | --- |
| `OMB_WHATSAPP_INTAKE` | `1` turns the intake on. Unset, empty, `0` or `false`: off. |
| `OMB_WHATSAPP_INTAKE_BOT` | Required. The id, or the exact name (case-insensitive), of the bot that answers. |
| `OMB_WHATSAPP_INTAKE_GROUPS` | Required. Absolute path of the group map (below). |
| `OMB_WHATSAPP_INTAKE_OPERATOR` | Required. The operator's direct chat with the account, a user chat id such as `15550000002@s.whatsapp.net`: commands come in there, and drafts, escalations, reports and the digest go out there. |
| `OMB_WHATSAPP_INTAKE_BUNDLE` | Required. Absolute path of the folder the bot may read. A run that touched anything else has its reply drafted. |
| `OMB_WHATSAPP_INTAKE_WACLI` | The `wacli` executable; default `wacli` on `PATH`. |
| `OMB_WHATSAPP_INTAKE_STORE` | wacli's store directory (`--store`); default wacli's own. The intake also reads edit times from `<store>/wacli.db` ([below](#wacli)); without this setting it cannot, and every change to an edited message of the operator's counts as a new edit. |
| `OMB_WHATSAPP_INTAKE_MAX_DB_SIZE` | Cap of wacli's message database (`--max-db-size`), default `2GB`. |
| `OMB_WHATSAPP_INTAKE_SELF_IDS` | Comma-separated extra ids of the account for mentions, such as its LID digits, beyond the phone number `wacli auth status` reports. |

An unusable value, or a group map that does not load, stops the server at
start with the reason. wacli must be installed and paired (in a Lazurio
Environment: Apps → Integrace → WhatsApp) as the server's own user; the intake
never pairs, signs in or out.

```sh
OMB_WHATSAPP_INTAKE=1 \
OMB_WHATSAPP_INTAKE_BOT=Support \
OMB_WHATSAPP_INTAKE_GROUPS=$HOME/support/groups.json \
OMB_WHATSAPP_INTAKE_OPERATOR=15550000002@s.whatsapp.net \
OMB_WHATSAPP_INTAKE_BUNDLE=$HOME/support/bundle \
openmausbot serve
```

### The group map

A JSON file, read at start and again at each catch-up when it changed (a map
that no longer loads is reported and the previous one stays). A chat that is
not in it is never handed to a bot.

```json
{
  "version": 1,
  "team": ["15550000003@s.whatsapp.net"],
  "allowedLinks": ["https://github.com/example-provider/handbook"],
  "environmentDomains": ["lazurio.io"],
  "groups": {
    "120363000000000001@g.us": {
      "key": "a",
      "name": "Group A",
      "mode": "auto",
      "note": "notes/a.md",
      "address": "vy",
      "clientNames": ["Contoso"],
      "owners": ["contoso-labs"]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `groups` | Group chat id (`…@g.us`) → its settings. |
| `key` | Short lowercase key for `STOP <key>`, the webhook's name and the ledger. |
| `name` | The group's name for the operator and the bot. |
| `mode` | `observe`: classify and record only, no model. `draft`: every reply goes to the operator as a draft. `auto`: a reply to a mention or to a reply to the account is sent to the group, unless a guard stops it; an unasked reply is always a draft. |
| `note` | The client note, a file inside the map's folder, put into this group's runs only. Up to 8,000 characters. |
| `address` | `vy` (default) or `ty`: how the bot addresses the client. |
| `clientNames`, `owners` | This group's client names and GitHub owner logins, for the cross-client guard only: it keeps them out of every other group's replies, and no run is given them. |
| `team` | Chat ids of the people who answer for the provider. The operator counts as one too. |
| `allowedLinks` | URL prefixes a reply may link to although they are repository or Environment links. |
| `environmentDomains` | Domains whose subdomains are Environment links; default `lazurio.io`. |

## What happens to a message

1. wacli's follower (`sync --follow`, which the intake starts and restarts)
   stores each live message and posts it, signed with a secret the intake
   chose, to a receiver on `127.0.0.1` at a port the OS picks. An unsigned or
   wrongly signed body is refused before it is parsed.
2. The intake keeps only the operator's chat and the mapped groups. A direct
   message from anyone else gets no reply; the operator gets a short report
   (at most one per chat in 30 minutes). A message in an unmapped group is
   listed in the status and nothing else.
3. The account's own messages and the team's mark the group as handled.
   Reactions, edits, revokes, polls and calls are never questions.
4. A mention of the account (`@<its number>` in the text), or a reply to it
   or to a message the intake sent, asks for a run now, unless it is more than
   an hour old: then the operator is told and the bot stays silent. A team
   member who tags the bot asks for a run too.
5. Every other client message waits in its group's batch, which runs after 10
   quiet minutes or at 20 messages, but not while a team member wrote in the
   group in the last 15 minutes.
6. One group runs at a time; whatever asks meanwhile runs right after, with the
   newer messages. The intake reads that group's last 40 messages with
   `wacli --read-only messages list --chat <group>` and hands them to the
   group's own webhook, **WhatsApp · \<key\>**, which it creates for the bot
   and keeps in step with the map and the note.

### The catch-up

The follower's webhook is best effort: wacli posts each live message once,
drops what its queue of 512 cannot hold and never posts history. Every 5
minutes, before each reply, and on `POST /api/whatsapp-intake/catch-up`, the
intake therefore reads wacli's change journal (`messages changes`), which
records every message the store takes in or changes, in store order and
without text. It reads from the checkpoint where the previous catch-up stopped,
200 entries at a time and up to 1,000 per catch-up; when more wait, the next
tick goes on 5 seconds later.
A message of the operator's chat or a mapped group that the intake has not
handled is read with `messages show` and handled as if it had arrived live, so
a message or a STOP the webhook dropped is handled once, however many messages
came after it or in the same second.

- The checkpoint moves past a page only once every entry on it is handled.
  After a failure or a restart the page is read again, and what was handled
  is skipped by its id.
- The intake keeps the ids of the messages it handled since the last complete
  catch-up, and at least the newest 500 per chat; its own sends count as
  handled. wacli's journal records a change to a message (an edit, which wacli
  stores over the message it edits, or a sender id it normalized) as `upsert`,
  exactly like the message's arrival, so the journal cannot tell a new message
  from a changed one:
  - In the operator's chat every entry for an id the intake no longer keeps is
    read and handled, so no command there is ever skipped, and the chat
    forgets no id before the next complete catch-up. A change to one of the
    operator's messages it keeps is read again too, and so is a change to one
    from before the first start, since either may be an edit; the account's
    own messages are never read again. What a command read again, or an edit,
    can do is under [the commands](#the-operators-commands).
  - A mapped group keeps at most 5,000 ids. An entry for a message at or
    before the newest time it no longer keeps counts as a change to a message
    it handled, not a new one. A dropped message that wacli stored late, at or
    before that time, therefore gets no answer. That rule cannot skip a
    command, and it keeps wacli's rewrites of old messages from waking the bot
    again: at a follower's start, wacli rewrites the sender of every stored
    message of a member once it learns the phone number behind their LID.
- **The follower runs only from a checkpoint.** At the first start, and when
  wacli no longer holds the journal from the checkpoint on, the intake takes
  the journal's present position while the follower is stopped, and only then
  starts the follower. History from before it is never handled, nor is a
  later change to a message from before it, except an edit in the operator's
  chat. Until a checkpoint can be taken nothing is collected or sent: the
  status says `checkpoint_failed`, the operator is told once, and the intake
  tries again after 1 s, 5 s, 30 s, 2 min, then every 5 min.
- **A reply waits for the journal.** A finished run's reply is neither sent nor
  drafted until a catch-up has read the journal to its end, so every STOP
  stored before then applies first, however many entries come before it.
- **A reply looks once more.** Right before a reply goes to wacli, after its 3
  to 8 second spacing, the intake reads the journal again and asks the pause
  again, so a STOP stored during the spacing applies even when its webhook
  drops. While that read finds more than one catch-up reads, the reply waits
  for the next tick; a journal that cannot be read, or no longer reaches the
  checkpoint, makes it a draft.
- **It fails closed.** When the journal cannot be read (a wacli without it, a
  failing read), a dropped STOP could go unseen: the operator is told once, the
  status says `catch_up_failed`, and every reply goes to the operator as a
  draft until a catch-up succeeds. When wacli no longer holds the journal from
  the checkpoint on (it keeps 30 days and at most 100,000 entries, and a new
  store starts a new journal), what the webhook dropped meanwhile is lost:
  sending pauses as after a STOP, and the operator is asked to send START.

## What the bot receives

The delivery takes the same path as an HTTP webhook delivery: the same queue
behind a busy bot, delivery receipts, the pending-run limit (2 per group) and
rate limit, the attempt log, and a new conversation per run. The webhook's
instructions, which the intake writes, name the group, the address form and the
mode, explain the event and the output contract, and end with the client note.
They carry no client name, owner login or chat id (the delivery id is
`wa:<key>:<message id>`): only the guards read those.

The intake is the one writer of these instructions. It writes them again
whenever they differ from what the map and the note give, so an edit made in
MausBot lasts only until the group's next run. Everything that belongs to one
persona or one provider (who the bot is, its tone, what it may promise, when it
speaks) goes into the bot's own instructions, its SOUL, which the intake never
touches.

The event follows in the `UNTRUSTED WEBHOOK EVENT DATA` block:

```json
{
  "source": "lazurio-whatsapp-intake",
  "group": "Group A",
  "trigger": "mention",
  "trigger_message_ids": ["3EB0…"],
  "messages": [
    { "id": "3EB0…", "at": "2026-11-02T08:00:00.000Z", "from": "client", "name": "Client One", "text": "@15550000001 …", "new": true }
  ]
}
```

`from` is `client`, `team` or `you` (this account); the senders' chat ids are
not passed, only their WhatsApp names. A text is cut at 1,000 characters.
`trigger` is `mention`, `reply` or `batch`.

The bot answers with one JSON object (a code fence or text around it is
tolerated):

```json
{
  "action": "none | reply | escalate | reply_and_escalate",
  "reply": "text for this group, or empty",
  "reply_to": "the id of the input message it answers",
  "escalation": { "urgency": "low | normal | high", "summary": "…", "next_step": "…" },
  "commitment": false,
  "confidence": "high | medium | low",
  "sources": ["path in the bundle"],
  "digest_line": "one line for the operator's digest"
}
```

`reply` is empty for `none` and `escalate` and at most 1,200 characters
otherwise, `escalation` is `null` unless the action escalates, and
`digest_line` is one line; the instructions say so. Anything that is not this
object, a field outside the contract (a recipient, say) included, is invalid:
nothing goes to the group and the operator is told. `reply_to` that is not an
input message of this run is replaced by the message that asked. A missing or
unknown `confidence` counts as `low`, and a `commitment` that is missing or
anything but `false` as a commitment. The intake sends the reply as text only,
quoting `reply_to`, without a link preview, and only to the group the run
judged; it never takes a recipient from the bot.

## The guards

A reply that would be sent becomes a draft in the operator's chat, with the
reasons, when any of these holds:

- **Paused**: the operator's latest command for this group is a `STOP`
  ([below](#the-operators-commands)).
- **No catch-up**: the last catch-up could not read wacli's journal, or take
  a checkpoint in it ([above](#the-catch-up)).
- **The bot is unsure or committed**: `confidence` is `low`, or `commitment` is set.
- **Commercial language**: a price or an amount of money, a discount, a
  contract or order, an invoice, a deadline or guarantee, an SLA or uptime, in
  Czech or English. The patterns are a coarse net that errs towards a draft.
- **Another client**: the reply names another mapped group, one of its client
  names or owner logins (without case or diacritics, as whole words), unless
  this group shares it.
- **A foreign link**: a repository link (GitHub, GitLab, Bitbucket) or an
  Environment link (a subdomain of an Environment domain) that no
  `allowedLinks` prefix covers.
- **The run's tools**: the run used a shell (`gh` and `wacli` are named), any
  tool other than reading files (`Read`, `Grep`, `Glob`, `LS`), or read outside
  the bundle; a search without a path counts as the bot's working folder. A
  path counts where it really leads, so a link in the bundle to a file or
  folder outside it is a read outside, and a link that leads nowhere, a missing
  file or a file with a second hard link cannot be vouched for. A search below
  a folder counts as inside only while every link in the bundle leads back into
  it and no file in it has a second hard link. The guard checks the files as
  they are when the run ends. The intake reads the run's tool calls from the
  server's runtime events, which the Claude and Codex engines report for every
  call. A run on another engine, a run whose start the intake did not see
  (after a restart), or a call whose path it cannot read, counts as a hit. On
  Codex every file read is a shell command, so its replies are always drafts;
  use Claude.
- **Rate**: 6 sends an hour or 30 a day in this group, or 80 a day in all
  groups.
- **Length**: a reply over 1,200 characters.

A reply in a `draft` group and any reply to an unasked batch is a draft too.
A send that fails is drafted. Sends (drafts and reports included) go out one
at a time, a random 3 to 8 seconds apart, and the follower paces them again
(`--send-spacing 3s-8s`).

An `escalate` goes to the operator as
`[Group A · 14:32] Eskalace, naléhavost vysoká: <summary>` with the bot's next
step.

## The operator's commands

In the operator's chat, exactly, in any case:

- `STOP`: no reply goes to any group; replies come to the operator as drafts.
- `STOP <key>`: the same for one group.
- `START`: every group sends again. `START <key>`: that group sends again.

A command counts from when the operator sent it (WhatsApp's time), not from
when it arrived, since a command the webhook dropped comes with the catch-up,
after newer ones:

- For each group the latest command decides, whether it names the group or
  all groups. `START` after `STOP b` sends to b again; `START b` after `STOP`
  sends to b while the other groups stay paused.
- A `STOP` and a `START` of the same second leave sending paused, whatever
  order they came in or wacli stored them in: a command the catch-up reads
  again carries the store sequence of a later change, so that order proves
  nothing.
- A command that changes nothing because a later one stands, such as a dropped
  `START` found after a newer `STOP`, gets one line back:
  `Příkaz START z 10:02 nic nemění, platí STOP z 10:05.`
- A command the catch-up reads again once the intake no longer keeps its id
  (wacli changed the message) also counts by its own time, so it never undoes
  a newer one: the command still in force says nothing, and an older one gets
  the line above.
- A `START` counts only in a message as the operator sent it, never in an edit
  (wacli stores it over the edited message, with that message's time), a
  deleted message or a reaction. A `STOP` counts in any of them.
- A `STOP` in an edit counts from when the intake reads the edit, never from
  the time of the message it edits, so a `START` sent before the edit does not
  override it. The intake reads every edit in wacli's journal, whether its
  webhook arrived or not (the webhook's copy only starts a catch-up), also
  when the edited message is one it still keeps or one from before its first
  start. An edit turns the command in force into another one: a `START`
  edited into `STOP` pauses.
- An edit counts once, by wacli's own time of the edit. wacli also rewrites a
  stored message with no new edit (a sender it normalized, a chat it moved),
  and its journal shows that just like an edit, but the time of the message's
  latest edit stays: only a new edit moves it on. No wacli command prints that
  time, so the intake reads it from wacli's store ([below](#wacli)), before
  and after it reads the text, and judges the text only with a time both reads
  agree on: wacli moves that time on only for an edit of a later second, so
  the text is of an edit of that time. An edit stored between the reads moves
  it, and the text is read again, three reads at most. For each of the
  operator's last 1,000 edited messages the intake keeps the edit time it
  judged last, never the text, also across a restart: a change with that time
  is a rewrite and changes nothing, so it never undoes a later `START`, and a
  change with any other time is a new edit. `STOP`, an edit to anything else,
  then back to `STOP` pauses again, also when one catch-up reads both edits. A
  rewrite of an edited message the intake forgot or never judged, one edited
  before its first start say, counts as a new edit: a `STOP` in it pauses once
  more, the operator is told, and `START` resumes.
- While wacli's store cannot tell the edit time (it cannot be read, it is not
  wacli v0.25.1's, or no store is set), every change to an edited message
  counts as a new edit, so a `STOP` in one pauses even after a later `START`,
  and the operator is told once:
  `Čas úpravy zprávy nejde v úložišti wacli přečíst (…). Dokud nepůjde, každá změna upravené zprávy se bere jako nová úprava: STOP v ní pozastaví odesílání i po zprávě START. Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.`
  Once the store tells again, a rewrite of an edit with the time the intake
  remembers is a rewrite; when it cannot tell once more, the operator is told
  again.
- When the edit time moves at all three reads, edits keep coming while the
  intake reads, and the text may be another edit's: the change counts as a
  `STOP` for all groups, whatever its text. The operator is told once, until
  the store gives one time again:
  `Čas úpravy zprávy byl v úložišti wacli při každém čtení jiný nebo nešel přečíst, takže nejde poznat, ke které úpravě patří její text. Proto se taková změna bere jako STOP pro všechny skupiny. Až čas zase půjde přečíst, může takový STOP pozastavit odesílání ještě jednou, i po zprávě START, pokud z úložiště nepůjde poznat, že už platil.`
- When the reads tie the text to no time, as in the two cases above, the
  intake remembers the newest time any read gave, the one before the first
  text included; when none gave one, it keeps the time it had. The change
  judged covers the edit of that time, as its text was read after that time
  or the change counted as a `STOP` for all groups. So that edit, read again
  once the store tells, is a rewrite and never undoes a later `START`, while a
  new edit has a later time and a `STOP` in it pauses. An edit whose time no
  read gave, one wacli stored after the last read that gave a time, may be the
  one judged or a new one, and the store cannot show which: a `STOP` in it
  pauses once more, even after a `START`, since pausing is the safe side. Both
  notices above say so.
- What the edit time cannot show: wacli keeps it in whole seconds, so an edit
  within the second of the edit whose text the intake read, stored after that
  read, counts as that edit and is not read. That never undoes a `START`,
  since a rewrite changes nothing, and it cannot hide a `STOP` behind a
  `START` while this machine's clock and WhatsApp's agree: a `START` overrides
  an edited `STOP` only when it is later than the read that applied it, so any
  edit after that `START` has a later second. And wacli's journal records a
  change only when something other than that time changes, so an edit of an
  edited message that keeps its text exactly as it was is not in the journal,
  and the intake does not read it. A `STOP` sent as a new message always
  counts.

The intake confirms each command, naming the groups whose own later command
still decides. The commands are part of the intake's state, so a restart keeps
them. Nothing else in that chat is a command, and no other chat can give one.

A command takes effect as it arrives, also while a reply waits for its turn to
be sent: each reply reads the journal and checks the pause again right before
it goes to wacli, and a paused one comes to the operator as a draft. A reply
already handed to wacli, which paces sends again, is not recalled. A STOP the
webhook dropped takes effect at the next catch-up, within 5 minutes, and before
any reply goes out. If no confirmation comes, send it again.

## The digest

On workdays (Monday to Friday) from 17:00 Europe/Prague, once a day, the
operator gets a digest built from the ledger and the group state alone: per
group, the replies sent, drafts, escalations and how many are still open (no
team message since), the client messages without any reaction for more than 2
hours with their times, and the bot's digest lines; then the follower's state,
the last message, the runs that did not finish, a pause and unmapped groups. A
digest that cannot be sent is tried again every 15 minutes that evening.

## wacli

Checked against wacli **v0.25.1** (commit `b7603b69`). The intake runs:

| Command | Use |
| --- | --- |
| `sync --follow --events --webhook <loopback> --webhook-secret <secret> --webhook-allow-private --send-spacing 3s-8s --max-db-size <cap>` | the follower, restarted after an exit (1 s, 5 s, 30 s, 2 min, then every 5 min) |
| `--read-only --json messages list --chat <id> --limit 40` | the run's input |
| `--json messages changes --checkpoint` | the catch-up's checkpoint, taken while the follower is stopped; a writable open, so it migrates a store no writable wacli has opened since it got the journal |
| `--read-only --json messages changes --since <checkpoint> --limit 200` | the catch-up |
| `--read-only --json messages show --chat <id> --id <id>` | a message the catch-up has not handled, or a changed message of the operator's, between two reads of its edit time |
| `--json --timeout 60s send text --to <id> --message <text> --no-preview [--reply-to <id>]` | every send; delegated to the running follower |
| `--read-only --json auth status` | the account's own number, for mentions |

One thing the intake reads from wacli's store itself, since no command prints
it: the time of the latest edit of a message in the operator's chat,
`messages.edited_ts` of that one row in `<store>/wacli.db`, where `<store>` is
`OMB_WHATSAPP_INTAKE_STORE` (`server/whatsapp-intake-wacli-store.ts`). It
opens the file read-only, never `immutable` (the store runs in WAL mode, and
recent rows live in the -wal file), reads the row and closes it at once; a
reader of a WAL store does not wait for wacli's writer, nor wacli for it. It
reads the time before and after `messages show` reads the text, and the two
must agree (`readEdit`). It reads only a store whose newest migration is
v0.25.1's (33, `ordered chat auto-unarchive`). Any other store, one it cannot
read, or no store set gives no edit time, and the intake fails closed on that
([the commands](#the-operators-commands)). This ties the intake to wacli's
internal schema at v0.25.1: a later wacli has to be checked again, and once
wacli prints the edit time, that takes this read's place.

Read in the source and not assumed:

- The webhook's body is wacli's `ParsedMessage` with Go field names; receipts
  and presence carry `EventType`, messages do not. It is signed
  `X-Wacli-Signature: sha256=<hex HMAC-SHA256 of the body>`, posted with a 5 s
  timeout and never retried. A loopback URL needs `--webhook-allow-private`.
- Chat ids in payloads are the store's: a known LID is resolved to the phone
  number's id, an unknown one stays a LID.
- The follower stores a live message before it posts it, posts only live
  messages, never history, and drops what its webhook queue of 512 cannot
  hold.
- `messages list`, `messages show` and `messages changes` do not take the
  store lock, so they read while the follower runs. The rows of `list` and
  `show` are the store's `Message` (`ChatJID`, `MsgID`, `quoted_msg_id`, …);
  `show` returns a deleted message too, and for one the store no longer holds
  it fails with SQL's `no rows in result set`. With `--json` a failure prints
  the same `{success, data, error}` envelope on stderr.
- `messages changes` reads the store's change journal in store order: entries
  `upsert`, `delete` and `identity_move` with a sequence, the chat, the message
  id and the message's time, no text. `--checkpoint` prints the present
  position; `--since` reads after a checkpoint and gives `has_more` and the
  `next_checkpoint` to keep once the entries are handled. It keeps 30 days and
  at most 100,000 entries, refuses a checkpoint past that or of another store
  (`expired checkpoint`, `checkpoint belongs to another store`), and refuses a
  read-only open of a store no writable wacli has migrated yet; any writable
  open migrates it, the intake's checkpoint included. wacli's docs warn
  against paging `messages list` by moving `--after` one second on, since
  messages share timestamps.
- The journal does not tell a new message from a changed one: both are
  `upsert`. An edit is stored over the message it edits, which keeps its id
  and time; at each `sync` start, wacli rewrites the sender of every stored
  message of a member whose LID it can now resolve to a phone number. Moving a
  LID chat's messages to the phone number's chat is recorded as
  `identity_move` with the new chat only, since the message id stays.
  Deleting a message, for everyone or for the account, clears its `Edited`.
- What time an edit carries: the webhook posts it with the edited message's id
  and the edit's own time (`Edited` set). The journal entry and `messages show`
  give the edited message's time (the row's `Edited` is set). The store keeps
  the time of the latest edit in `edited_ts`, in whole seconds, which only a
  later edit moves on (an edit of the same second keeps it and takes the newer
  text) and a delete clears; no command prints it, and wacli's docs call it
  the internal edit-order timestamp. The journal records an update of a row
  only when a column other than `edited_ts` changes (the docs: identical
  stored values produce no entry). Each journal entry also has the time this
  machine recorded it, which the intake does not use.
- `send text --to` with an `@` is parsed as a chat id, never resolved by name;
  while the follower runs, the send is delegated to it and paced.
- `auth status` reports `linked_jid` and `phone`, not the LID.
- The follower's `--events` are NDJSON lines on stderr; the intake reads
  `connected`, `disconnected`, `reconnecting`, `stale`, `stream_replaced`,
  `logged_out`, `warning` (its `code` only) and `error`, whose texts
  `sync storage limit reached`, `not authenticated` and `store locked` become
  the states `store_full`, `logged_out` and `store_locked`.

Assumed, to verify on a test group before any client group:

1. WhatsApp writes a mention into the text as `@` and the account's phone
   number; the payload has no list of mentioned ids. Where a mention shows the
   account's LID digits instead, set `OMB_WHATSAPP_INTAKE_SELF_IDS`.
2. The quoting client fills the quoted message's id and sender, so a reply to
   the account is recognised.
3. Team members appear by their phone number's id; one who appears only by an
   unknown LID counts as a client until the map lists that id too.
4. A message this linked device sends is not posted back as a live event. The
   intake does not depend on it: it ignores its own messages either way.
5. An edit arrives as an edit, with `Edited` set: in a group it is not judged
   again, and in the operator's chat a STOP in it counts.
6. `--reply-to` shows as a quote to every member of a group.
7. WhatsApp's own limits for a linked device are unknown; the intake's rate
   and spacing are deliberately low.
8. wacli is installed at a version this table was checked against: the
   Environment's tool catalog installs the latest release, unpinned. The store
   of a later version gives no edit time, so until the intake is checked
   against it, every change to an edited message of the operator's counts as
   a new edit and the operator is told.

## State, ledger and retention

`<data>/whatsapp-intake.json` (mode 0600) holds the first start's time, the
group webhooks, the operator's latest command for all groups and for each
group, the catch-up's checkpoint in wacli's journal, per chat the ids and times
of the messages handled (and which are the account's own), for the operator's
chat the ids of its last 1,000 edited messages with wacli's time of the edit
judged last, the time of the last team message and the client
messages still waiting, the ids of sent messages, the runs in flight, the
ledger and the digest's pending lines. The
ledger keeps 30 days of ids, times and actions; the bot's digest lines wait
only until the next digest is sent. Neither the state nor the server log
(`[whatsapp-intake]` lines) holds message text. Every write claims the server's
maintenance gate, like the GitHub intake's.

MausBot itself keeps what every webhook delivery keeps: each run's conversation
(the event with the messages and the bot's answer) under its usual retention,
and a short preview of each event in the webhook's attempt log.

## Status

`GET /api/whatsapp-intake` returns `{enabled: false}` or the state (`starting`,
`connecting`, `ok`, `no_target`, `checkpoint_failed`, `catch_up_failed`,
`down`, `logged_out`, `store_full`, `store_locked`, `wacli_missing`, `error`),
the account, the
target bot, the follower (state, restarts, webhook failures), the operator's
chat, the bundle, each group (mode, pause, webhook, run in flight, batch,
waiting client messages, last message and team message), the pause (`stopped`:
whether the latest command for all groups is `STOP`, and the groups their own
`STOP` pauses), the limits, the last catch-up and why it failed, the last
digest, unmapped groups, the last error and the 50 most recent ledger entries.
`POST /api/whatsapp-intake/catch-up` reads the journal now and returns the
summary (`changes` read, `messages` handled, `errors`, `more` waiting) with the
status. Both need the admin scope (the owner on loopback).

## Security notes

- **The Environment is the boundary.** The support bot is an ordinary bot with
  the Environment's full access: a shell, `gh` and the wacli store. The intake
  narrows what reaches a group (one group's messages per run, a fixed
  destination, the guards, the pause), not what the bot can do. A client
  message that talks the bot into reading another group or a repository is
  caught only by the guards; keep the bot's instructions explicit and the
  operator in every group. A separate Environment is the way to narrower
  rights.
- **Loopback is the owner.** Any process of the Environment's user can read
  the status, trigger a catch-up, read wacli's store or drive the bots. The
  webhook secret and each sent text are in wacli's process arguments, which
  that user can read; wacli has no other way to take them.
- **Messages are data.** Texts, names, quotes and forwards reach the bot only
  inside the untrusted block. The intake acts on WhatsApp facts (chat ids,
  senders, quoted ids, times), never on free text, except the operator's exact
  commands in the operator's own chat.
- **Publication.** A reply sent to a client group is a Publication of the
  operator; the mapping (`mode: auto`) and the pause are how the operator
  grants and withdraws it.

## Contract and verification

`server/whatsapp-intake.test.ts` drives routing, batching, one run per group,
every guard, STOP and START (in the order they were sent, across live and
recovered commands, for all groups and single ones, within one second, and in
an edit of a message the intake keeps, forgot or has from before its first
start, delivered or dropped, judged once by wacli's edit time however often
wacli rewrites it, also across a restart, also for two edits one catch-up
reads together, for an edit stored between the two reads of an edit's time,
before or after its text is read, which pauses once and never undoes a later
`START`, for a time that moves at every read, which pauses as a `STOP`, for
reads of the time that fail by turns or after the first, which remember the
newest time read, so that `STOP` never undoes a later `START` while a new edit
to `STOP` pauses, and every change counted as an edit while the store cannot
tell its time), a STOP
stored while a reply waits for its
spacing, the digest, the ledger, the catch-up and a restart through a real
WebhookManager with a fake wacli and its change journal. The catch-up tests
cover a STOP dropped after 260 messages of
the same second, after messages of its second whose ids the intake no longer
keeps, and after more than 5,000 of them; a command read again; a backlog
larger than the ids the intake keeps; a reply held until the journal is read to
its end, also by its last look; what is read back and what never is; a failure
and a restart in the middle of a backlog; a first checkpoint that fails; a
journal that cannot be read and one that no longer reaches the checkpoint. One
test holds the whole promise: an operator's STOP stored by wacli is never lost
and applies before any later group send, whatever the webhook dropped, the
intake forgot or the journal pages.
`server/whatsapp-intake-guards.test.ts` and
`server/whatsapp-intake-wacli.test.ts` cover the guards and the adapter: the
exact commands, both message shapes, the journal, an edit's time read before
and after its text and the newest time the reads gave, the follower's events,
the signed receiver and the real
spawn against a fake `wacli`.
`server/whatsapp-intake-wacli-store.test.ts` reads edit times from stores built
from wacli v0.25.1's own schema with synthetic rows: in ms, also while wacli
holds a write open, and none from a store that is missing, set nowhere, not a
database, another version's, without its migrations or without `edited_ts`.
`server/whatsapp-intake.e2e.test.ts` runs the isolated real server with a fake
`wacli` follower and the fake engine through the real Claude driver: a mention
answered in its group only, the cross-client and tool guards, a link out of the
bundle, STOP and START, and a dropped message recovered from the journal after
a later one arrived live, the only message the catch-up reads back besides the
operator's two commands. These
fixtures prove no real WhatsApp delivery; that evidence belongs to each
Environment's own pilot.

A verification fixture (`scripts/control-omb.ts`) runs the intake only when its
caller hands over a fake wacli and test files, all under the temporary folder,
and never passes a store; the launcher's own `OMB_WHATSAPP_INTAKE*` settings,
which on a configured Environment are the live ones, never reach it
(`server/testing/whatsapp-intake-fixture.ts`).
