# Ubuntu Desktop

OpenMausBot has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime.

## What works

- The native Electron window and embedded OpenMausBot server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- External documentation and OAuth links in the default browser.
- An explicit, view-only local screen preview on GNOME Xorg and GNOME Wayland. The Wayland path uses the
  native portal chooser and keeps the selected PipeWire stream open until the user stops sharing.
- Explicit opt-in local computer control on GNOME Xorg using the bundled, pinned Cua Driver without its
  decorative full-screen cursor overlay.
- A fail-closed local-control state on GNOME Wayland while its separate real-seat input-safety gate in issue #345
  is resolved.

The local preview does **not** give the bot control of this computer by itself. On Xorg, local control requires both
the global **Enable local control** choice and assigning a bot to **This computer**; every action still enters the
approval flow. On Wayland, local control is disabled and legacy opt-ins are cleared automatically. Automatic Wayland
helper installation, Linux dictation, and ARM64 remain unavailable and fail closed; follow their
progress in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29) and the safety hold in
[issue #345](https://github.com/milind-soni/OpenMausBot/issues/345). Bundled
CUA supply-chain work is tracked in [issue #113](https://github.com/milind-soni/OpenMausBot/issues/113). Xorg is tracked in
[issue #79](https://github.com/milind-soni/OpenMausBot/issues/79), and guarded GNOME/Wayland support in
[issue #109](https://github.com/milind-soni/OpenMausBot/issues/109).

## Download packages

Choose one Ubuntu 24.04 x86_64 package from the latest release:

- [Debian package (`OpenMausBot-amd64.deb`)](https://github.com/milind-soni/OpenMausBot/releases/latest/download/OpenMausBot-amd64.deb) — recommended; APT installs its desktop dependencies and configures the bundled bot browser's sandbox.
- [Portable AppImage (`OpenMausBot.AppImage`)](https://github.com/milind-soni/OpenMausBot/releases/latest/download/OpenMausBot.AppImage) — does not install system files.
- [SHA-256 checksums](https://github.com/milind-soni/OpenMausBot/releases/latest/download/SHA256SUMS-ubuntu-x64.txt)

Versioned packages and previous releases remain available on the
[releases page](https://github.com/milind-soni/OpenMausBot/releases).

## Build packages

Requirements for building from source:

- Ubuntu 24.04 LTS x86_64
- Node.js 24 or newer
- pnpm 10.33.0 (Corepack can install the version declared by the project)

```sh
git clone https://github.com/milind-soni/OpenMausBot.git
cd OpenMausBot
corepack enable
pnpm install --frozen-lockfile
pnpm package:linux
```

The build creates:

- `release/OpenMausBot-<version>-amd64.deb`
- `release/OpenMausBot-<version>-x86_64.AppImage`

The AppImage uses a static runtime and does not require the legacy `libfuse2` package.

## Install and run

Install a downloaded Debian package with APT so its desktop dependencies are resolved:

```sh
sudo apt install ./OpenMausBot-amd64.deb
```

Then open **OpenMausBot** from the GNOME application launcher. To remove it:

```sh
sudo apt remove openmausbot
```

The portable AppImage does not install system files:

```sh
chmod +x release/OpenMausBot-*-x86_64.AppImage
./release/OpenMausBot-*-x86_64.AppImage
```

For a downloaded release AppImage, use `OpenMausBot.AppImage` in place of the versioned path above.

### Updating

The app checks for updates in the background and downloads them by itself. Nothing restarts until you click
**Restart to update**.

- **Debian package.** The click asks for your password once, in the system's own prompt, installs the update with
  `apt-get` (so new dependencies are resolved) and reopens OpenMausBot. The downloaded file is copied to a
  root-only folder and checked against the checksum in the update feed first; a file that does not match is
  refused and nothing is installed. Closing the prompt leaves the update ready to try again. If the session cannot
  show a prompt (SSH, no desktop, no `pkexec`), the app falls back to copying the `sudo apt-get install` command
  and opening a terminal, and says why. Set `OMB_UPDATE_INSTALL=terminal` to always use the terminal.
- **AppImage.** The update replaces the AppImage when you restart; no password is needed.
- **rpm and pacman packages** still use the terminal hand-off.

### Bundled bot browser on Ubuntu 24.04

The desktop packages include the browser engine and browser runtime; no separate browser download is needed.
Use the **`.deb` package** for browser-ready installation on Ubuntu 24.04. Its installer secures the browser's
package-owned files and loads an AppArmor rule for that exact executable. The browser sandbox stays enabled,
and the machine-wide user-namespace restriction is unchanged. Upgrades refresh the same rule; uninstalling
the package removes it. Enabling a bot's browser and approving its actions remain explicit choices.

An AppImage is portable and cannot install privileged system policy. On hosts restricting unprivileged
user namespaces, its bundled browser can still report `No usable sandbox`. Install the `.deb` instead;
do not add `--no-sandbox`, disable AppArmor globally, or allowlist arbitrary executables under your home
directory. See [Chromium's explanation of the Ubuntu restriction](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

Application data remains local in `~/.openmausbot`. Electron browser data and window state use the normal XDG
configuration directory (`~/.config/openmausbot` unless the environment overrides it).

## Develop the desktop shell

Development mode uses three processes. Keep each command running in its own terminal:

```sh
pnpm dev:server
pnpm dev
pnpm dev:desktop
```

For a package-shaped build without creating `.deb` or AppImage artifacts:

```sh
pnpm package:linux:dir
./release/linux-unpacked/openmausbot
```

## Agent CLI discovery

Applications launched from GNOME do not inherit the same interactive shell `PATH` as a terminal. OpenMausBot
keeps the inherited path and adds existing common locations such as:

- `~/.local/bin`
- `~/.claude/local`
- `~/.volta/bin`
- `~/.bun/bin`
- `~/.asdf/shims`
- `~/.deno/bin`
- `~/.nvm/versions/node/*/bin`
- `/usr/local/bin`

It also probes the login shell in the background. If a CLI still is not detected, set an explicit additional
path before launching the app from a terminal and verify it there:

```sh
OMB_EXTRA_PATH=/your/custom/bin ./release/OpenMausBot-*-x86_64.AppImage
```

Restart OpenMausBot after installing or signing in to a CLI.

## Xorg and Wayland

The shell and chat work in both GNOME session types.

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm build:cua:linux          # networked, checksum-pinned staging
dbus-run-session -- xvfb-run -a pnpm smoke:cua-x11-input
pnpm package:linux:offline    # CUA staging is offline; builder caches must already be available
node scripts/verify-linux-package.mjs
pnpm smoke:linux-package
```

The verifier checks `.deb` metadata, desktop identity, the exact dormant Cua resource tree and provenance,
SquashFS/DEB directory modes, runtime path policy, and matching binary hashes across all artifacts. The local smoke
launches the unpacked app and AppImage without `--no-sandbox`; CI first reproduces a `0.1.7` in-place DEB upgrade and
then runs the same smoke against `/opt/OpenMausBot/openmausbot`. These lanes prove the embedded server and UI are
no Cua executable starts on Xorg or simulated Wayland. Low-level runtime tests retain the future private-daemon
contract without activating it in a packaged app. Only a real-seat acceptance matrix can authorize re-enablement.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart OpenMausBot. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Choose **Cloud** (Boat) and add a Boat token in App Settings, or use Local VM. Linux **This computer** remains disabled
on Wayland. On Xorg, enable it from the **Local control** card first.

### Local control is not ready

On Xorg, press **Try again** and use the reason shown in the card. The bundled package requires no manual driver
installation or `chmod`; an upgraded DEB repairs its exact package-owned directory modes automatically. On Wayland,
the card directs you to Ubuntu on Xorg and intentionally offers no enable button.

### Screen preview does not start

On Xorg, confirm the session has an active display with `echo "$XDG_SESSION_TYPE"`; it should print `x11`.
On Wayland, confirm `xdg-desktop-portal` and the GNOME portal backend are running, then click **Try again** to
open a new chooser. Cancelling or stopping sharing never causes an automatic second prompt.

### The AppImage does not start

Confirm the executable bit and architecture:

```sh
chmod +x OpenMausBot-*-x86_64.AppImage
file OpenMausBot-*-x86_64.AppImage
```

Run it from a terminal once to collect the startup output. Do not install `libfuse2` just for this AppImage; the
package is built with the static runtime.
