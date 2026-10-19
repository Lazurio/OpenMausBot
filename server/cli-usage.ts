export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  openmausbot doctor                    check the server answers and an engine is ready
  openmausbot bots | channels | models  your bots, your rooms, the engines and their models
  openmausbot run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  openmausbot send BOT "text"           send one message and return at once
  openmausbot wait BOT                  wait on work already running
  openmausbot messages BOT              the latest messages of a conversation
  openmausbot interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  openmausbot export BOT --out DIR      write a job's transcripts, files and screens to DIR
  openmausbot events [--job THREAD]     the server's live events as JSON lines
  openmausbot team apply FILE           make the workspace match a team file (team export writes one)
  openmausbot routine list | show | create | update | delete | run   scheduled work for a bot or room
  openmausbot webhook list | create | delete | rotate   addresses other apps call to start a bot's work
  openmausbot bot list | show BOT       your bots, or one with its routines and webhooks
  openmausbot engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  openmausbot connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  openmausbot new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or OPENMAUSBOT_URL), --port N (or OMB_PORT), else this computer's.
  Token: OPENMAUSBOT_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). openmausbot help VERB for the details.`;

export const USAGE = `openmausbot — your team of AI bots, ready in a few steps

  openmausbot                         set up once, then open your workspace
  openmausbot setup [--data-dir DIR]
  openmausbot start [the same options as serve]
  openmausbot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
  openmausbot pair  [--label NAME] [--client] [--phone ios|android]
                    [--public-url https://host]
  openmausbot sessions [revoke ID]
  openmausbot status
  openmausbot access list | add EMAIL [--chat-only] | remove EMAIL
  openmausbot service install [--domain HOST | --tunnel | --tailscale] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  openmausbot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  openmausbot fleet init --domain HOST [--operator USER] | create NAME --admin EMAIL [--member EMAIL] [--brand FILE]
                    [--anthropic-key-file FILE] [--cap USD] [--license-key KEY] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as openmausbot: use your saved settings and open the workspace
serve   starts the server without prompts and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only)
sessions lists paired devices; "sessions revoke ID" signs one out
status  what the server says about itself
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Install the package
        permanently first (npm install -g openmausbot).
fleet   many client workspaces on one Linux server, each its own account,
        service, data folder, brand, sign-in list and keys at NAME.HOST
        behind the system Caddy. Plans are printed unless run as root;
        --dry-run always prints. Install the package permanently first.
        init --operator USER also installs the fleet agent, a root service
        on a Unix socket only USER may open, so the workspace running as
        USER manages the others from Settings → Installations.

--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--tunnel     serve at a fleet workspace's public https://c-… address through
             a Cloudflare tunnel (needs the fleet's OMB_INSTALLATION_CREDENTIAL)
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--no-open   do not open a browser window
--no-pair   skip phone setup and do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once with \`npm install -g openmausbot\`, then type \`openmausbot\`.
Or run without a global install: \`npx openmausbot\`. Node 24+ is required.
`;
