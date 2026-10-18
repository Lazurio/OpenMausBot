# Desktop server connection

Run the real Settings connection component in disposable Electron windows:

```sh
node scripts/verify-server-connection.mjs
```

Use the repository's installed dependencies, including the Electron binary.
Linux needs a graphical session (or run the command through `xvfb-run -a`).
The script creates its own loopback Vite preview, temporary HOME and Electron
profile. It accepts no server URL and blocks requests outside that preview
and the isolated fake-engine server it starts.
It never opens the operator's app, server list, credentials or browser profile.

The smoke mounts `RemoteComputerSection`, `ConnectedWorkspacesSettings`, and
`DesktopWorkspaceSwitcher` with the real styles and `electron/preload.cjs`.
It also opens the real app shell against a disposable fake-engine server.
It checks:

- A full custom HTTPS pairing link, including its 12-character code, reaches
  `environments:add-from-link` unchanged and never calls companion pairing.
- Duplicate submissions are blocked while a response is pending.
- Cancellation, rejection and retry restore a usable form; Electron's error
  wrapper is removed from the visible message.
- Desktop companion mode still sends a normalized six-digit code through
  `desktop-remote:pair`.
- The 390px layout has no horizontal document overflow.
- The hosted-workspace form accepts a hostname/address or pairing link and an
  optional name. Cancellation retains input; confirmed connections preserve
  the existing list and exclude the pairing code from saved connection data.
- The production native menu's Connect item requests Settings; its saved
  workspace items dispatch fixed IDs. Settings can switch connections and
  cancel or confirm forgetting just one saved connection.
- The local app opens Servers as a top-level Settings page, even
  before local provider onboarding. Native requests also clear stale Settings
  searches, so the requested page actually becomes visible.
- A page outside the declared local origin receives no saved-list/mutation
  bridge or Node access. Its workspace bridge contains only `state` (current
  name, not the list) and `menu` (the user selects in Electron's native menu).
- A real pairing exchange sets Chromium's HttpOnly session cookie. It is never
  copied into renderer JavaScript.

The printed evidence directory retains `receipt.json`, `electron.log`, and
desktop/narrow/in-app screenshots. Successful cleanup removes only the
temporary home, profile and server data. Expected fake IPC rejection messages
appear in the log.

This verifies actual renderer/preload dispatch, with fixture IPC handlers
substituting native confirmation, server persistence and navigation. It does
not prove public DNS/TLS or a live computer-control session. The native
connector portion does prove a real pairing exchange and cookie-authenticated
registration; filesystem and MCP execution are covered below.
Native menu items are selected programmatically; this is not a physical
mouse/keyboard test of the operating system's popup.
The existing production handler still performs native confirmation and opens
the server's pairing page; its URL/state helpers are checked separately with
`node --test electron/environments.node-test.mjs`. Do not report this offline
smoke as an authenticated connection to a customer's server.

## User flow

In a desktop build with this feature, choose the server dropdown above the
sidebar search → **Connect to a server…**, or open **Settings →
Servers**. Enter the server's HTTPS address or full pairing link and an
optional name. Confirm the host in the native dialog, then complete pairing or
email sign-in on that server. To generate an owner link without the CLI's
phone wizard, run `npx openmausbot pair --label "My desktop"` on the server.
Treat this link as a secret. Existing limited-access links retain their limits.

Select **This computer** or a saved hosted workspace to switch. Each origin
keeps its own session, bots, chats, provider credentials and settings. **Forget**
signs this desktop out and removes its saved connection, not the server's bots
or data. The server must remain running independently.

The dropdown renders in the server's own UI, so both desktop and hosted UI
need the update for the in-page control. When connecting to an older hosted
version, the native **Server** menu remains available to switch back or open
local connection Settings. Remote pages cannot enumerate the desktop's saved
connections or directly invoke switching, forgetting, or host-only controls.
