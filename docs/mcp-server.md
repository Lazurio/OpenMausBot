# OpenMausBot MCP server

The OpenMausBot desktop app includes a local stdio MCP server. It lets another MCP client coordinate your
OpenMausBot team while the desktop app and its harness are running.

## What it can do

- list bots and channels, including their active task and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit bot profiles, channels, and separate task conversations;
- send work to a bot or channel, wait for either conversation to settle or need help, and interrupt its active turn;
- list configured model instances and switch an idle bot to an exact available model;
- list, read, create, change, pause, run and delete routines (scheduled work for a bot, or a goal for a room), and
  list, create, delete and rotate the secret of webhooks, as the app's Automations page does.

The server intentionally cannot approve requests, remember permission grants, delete bots, rooms or conversations,
import teams, change engine credentials, or control computer/VM lifecycle. Those actions stay in the human-facing app.

## From the openmausbot command

With the `openmausbot` npm package installed, the MCP client can run it
directly; it serves the same tools:

```json
{
  "mcpServers": {
    "openmausbot": { "command": "openmausbot", "args": ["mcp"], "env": { "OMB_PORT": "8799" } }
  }
}
```

The same operations are also commands of their own, for scripts and CI:
[docs/headless-cli.md](headless-cli.md).

## From a source checkout

Start OpenMausBot, then configure the MCP client to run:

```json
{
  "mcpServers": {
    "openmausbot": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/OpenMausBot", "mcp"]
    }
  }
}
```

Packaged desktop builds require a paired session for tools that create,
change, send, switch, interrupt, or run anything. Read-only tools work on
loopback without one. A hosted or shared server with service loopback trust
([self-hosting](self-hosting.md#loopback-trust-owner-or-service)) needs a
session for almost every tool, reads included. To authorize an external MCP
client:

1. In OpenMausBot, open **Settings → Phone → Set up a phone** and reveal the
   one-time pairing code.
2. Exchange it locally (remove spaces from the displayed code):

   ```sh
   curl -X POST http://127.0.0.1:8799/api/auth/pair \
     -H 'content-type: application/json' \
     --data '{"code":"YOUR-CODE","label":"Local MCP client"}'
   ```

   If the desktop selected a fallback port, replace `8799` with the port shown
   in Settings. Copy the returned `token`; the pairing code is single-use.
3. Pin that same port and token in the MCP configuration:

   ```json
   "env": {
     "ELECTRON_RUN_AS_NODE": "1",
     "OMB_PORT": "8799",
     "OPENMAUSBOT_TOKEN": "omb_sess_..."
   }
   ```

The paired client appears with phones under **Settings → Phone** and can be
revoked there. Do not share the token or commit it to a repository.

## From the installed desktop app

Release builds bundle `server/mcp-server.js` and can run it with Electron's embedded Node runtime, so users do
not need Node.js or pnpm installed.

macOS example:

```json
{
  "mcpServers": {
    "openmausbot": {
      "command": "/Applications/OpenMausBot.app/Contents/MacOS/OpenMausBot",
      "args": ["/Applications/OpenMausBot.app/Contents/Resources/server/mcp-server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

On Windows, use the installed `OpenMausBot.exe` as `command`, the adjacent
`resources\\server\\mcp-server.js` as the argument, and the same `ELECTRON_RUN_AS_NODE=1` environment value.
The usual per-user install is under `%LOCALAPPDATA%\\Programs\\OpenMausBot`.

On Ubuntu `.deb` installs, the executable is normally `/opt/OpenMausBot/openmausbot` and the script is
`/opt/OpenMausBot/resources/server/mcp-server.js`. Use the same environment value.

## Connection discovery

With no configuration, the MCP process probes OpenMausBot's three desktop ports (`8799`, `18799`, and `28799`)
and accepts only a health response that identifies itself as OpenMausBot. This handles the desktop's normal
fallback when another local process already owns port 8799.

Set `OMB_PORT` to force one local port, or `OPENMAUSBOT_URL` to use an explicit HTTP(S) origin. Cleartext remote
HTTP is rejected unless `ALLOW_INSECURE_HTTP=true`; HTTPS should be used outside loopback. An optional
`OPENMAUSBOT_TOKEN` is sent as a bearer token for authenticated reverse proxies. When a token is set, an
explicit `OPENMAUSBOT_URL` or `OMB_PORT` is required so the credential is never sent while probing unrelated
local ports. `OPENMAUSBOT_MCP_TIMEOUT_MS` can set an HTTP timeout between 1,000 and 120,000 milliseconds.
In packaged builds, `OPENMAUSBOT_TOKEN` is required for mutating tools as
described above; it is not a generic reverse-proxy secret.

## Tools

| Purpose | Tools |
|---|---|
| Inspect | `get_system_health`, `list_bots`, `list_channels`, `get_bot_messages`, `get_channel_messages`, `search_messages`, `list_available_models` |
| Create and organize | `create_bot`, `update_bot_profile`, `create_channel`, `update_channel`, `create_task`, `switch_task`, `rename_task` |
| Run work | `send_bot_message`, `send_channel_message`, `wait_for_conversation`, `interrupt_conversation`, `set_bot_model` |
| Automate | `list_routines`, `get_routine`, `create_routine`, `update_routine`, `delete_routine`, `run_routine`, `list_webhooks`, `create_webhook`, `delete_webhook`, `rotate_webhook_secret` |

`wait_for_conversation` returns `settled`, `needs-user`, `failed`, `stalled`, or `timed-out`, along with a
small redacted transcript tail. That `status` keeps its earlier meaning: `settled` says the conversation is
no longer working (`failed` and `stalled` say its engine died or went silent, or its dispatch failed). The
result also carries `state`, the job's own verdict (`completed`, `idle`, `needs-input`, `failed`, `stalled`
or `timed-out`: a lead whose work failed or was stopped is `failed` here even when `status` is `settled`),
and `job`: the conversation's job as the server computes it (`GET /api/threads/:id/job`), with
every piece of work it handed to a teammate (`coordinate_bots`, an assignment on the job runtime:
docs/runtime-contract.md §9), who is doing it, how it ended, and anyone it is waiting on. A conversation is
not settled while that work is outstanding; it settles once their results have resumed it and that turn has
ended. A teammate parked on a question or an approval card makes the wait end with `needs-user` at once.
Optional inputs: `scope` (`job`, the default, or `turn` for the conversation's own turn only), and
`since_ms` and `after_version` from an earlier result's `job`, to keep watching the same job past a state
already seen. The server holds each request until the job changes, so a wait is not a poll loop. MCP
cancellation is honored while a tool is waiting.

`send_bot_message` and `send_channel_message` take an optional `send_id` (16-80 letters, digits, `-` or
`_`): sending again with the same id returns the first send's receipt instead of a second message. They
return the stored message's `messageId` and `at`, or `queued: true` when the message waits behind the turn
running there.

## Routines and webhooks

A routine's schedule is flat fields beside its other arguments: `schedule` (`once`, `daily`, `weekly`, `cron` or
`interval`, which may be left out when the fields name one) with `at` for once; `time` and `weekdays` for daily and
weekly; `cron` and `time_zone` (IANA) for cron; and `every_minutes`, optionally `starts_at`, `weekdays`,
`window_start` and `window_end`, and `ends_at`, for an interval. Dates and times carry their offset
(`2026-11-02T09:00:00+01:00`); `time` and the window are the server computer's local time; days are names
(`"mon"`, `"monday"`), ranges (`"mon-fri"`, `"fri-mon"`), `"weekdays"`, `"weekend"` or `0` to `6` (`0` is Sunday).

```json
{ "bot_id": "…", "name": "Morning brief", "prompt": "Summarize the night.", "schedule": "weekly", "time": "08:30", "weekdays": ["mon-fri"] }
```

`channel_id` makes a routine a room's goal, led by `bot_id`, which must be a member. `update_routine` changes only
the fields given: `enabled: false` pauses, `true` resumes, and a schedule given replaces the whole schedule.
`timeout_minutes: null` removes the run limit and `channel_id: null` makes a room goal the bot's own routine
again. `list_routines` leaves prompts out; `get_routine` returns one in full with its recent runs.

A webhook's secret exists once, when `create_webhook` or `rotate_webhook_secret` makes it, and neither returns it
unless asked: `show_secret: true` puts it and the full address that carries it in the result, and
`secret_file` saves it to a file only you can read on the computer running this MCP server
(`replace_secret_file: true` replaces a file that exists). Each call needs one of the two; the file is checked
before the webhook changes. Callers send the secret as `Authorization: Bearer SECRET` to the webhook's
`endpointUrl`, or append it to that address.

The `openmausbot routine` and `openmausbot webhook` commands call these tools
([docs/headless-cli.md](headless-cli.md#routines-and-webhooks)).

## Safety and data scope

Transcript reads are paged and capped at 200 messages. Search is capped at 100 hits. Screenshot pixels and
permission grant keys are removed from MCP results. Tool schemas reject unknown fields and malformed values,
and model changes are refused while a bot is working.

The harness itself is local-first and normally binds to loopback. If you expose it through a reverse proxy,
authentication and TLS at that proxy are part of your deployment's security boundary.
