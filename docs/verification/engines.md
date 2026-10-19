# Engines and Doctor

## Sub-features

- Confirm the endpoint identifies itself as OpenMausBot.
- List configured provider instances without exposing executable paths.
- Distinguish available and unavailable engines.

## User path

Open a bot's model picker or Settings → Engines.

## Driving it

```sh
pnpm control:omb doctor --url http://127.0.0.1:PORT
pnpm control:omb models --url http://127.0.0.1:PORT
```

`doctor.ok` is true only when the endpoint is OpenMausBot and at least one
engine is available. The isolated fixture should expose `claude`.

## Claude login

Claude bots use this computer's one Claude Code login: `~/.claude`, or the
directory `CLAUDE_CONFIG_DIR` names for the OpenMausBot process. OpenMausBot
keeps no Claude accounts or configuration directories of its own. Run the
offline regressions:

```sh
pnpm exec vitest run server/claude-account-removal.test.ts server/claude-sign-in.test.ts server/drivers/claude-accounts.test.ts
```

They check that a saved configuration with added Claude accounts loads without
them, that the copyable sign-in command signs in where the bots read, and that
only company models keep a directory of their own. No real provider login is
required.

## Gotchas

- Doctor proves server/engine readiness, not authentication against a real
  provider.
- Model-picker rendering is Electron UI and remains outside this first map.

## Groq API setup

```sh
pnpm exec vitest run server/drivers/groq.test.ts server/provider-key-check.test.ts server/config.test.ts server/openai-tools.e2e.test.ts src/components/ApiKeys.test.ts src/state/store.test.ts
```

These fixtures use disposable data and local HTTP providers. They check the
preset endpoint, write-only key status, model discovery, selection, streaming
usage, tool approval/denial/cancellation, and clearing the key. They never call
Groq or verify a real account's quota, model access, or inference.

For a renderer check, use an isolated server with a synthetic Groq endpoint.
Open **Settings → API keys**, paste its fixture key, and check that **Test**
reports catalog reachability without claiming chat authentication. Select a
Groq model in the bot's picker, send a fixture turn, then clear the key and
confirm the engine is unavailable. Never use the live app or a real key for
this recipe.

## Meta Muse: Model API and Muse Code

```sh
pnpm exec vitest run server/drivers/meta.test.ts server/drivers/muse-code.test.ts server/provider-key-check.test.ts server/config.test.ts server/openai-tools.e2e.test.ts src/components/ApiKeys.test.ts src/state/store.test.ts
```

The Meta Model API fixtures use a local HTTP provider: preset endpoint,
write-only key, the account's own model list (Muse Wonder becomes the default
once listed), streaming usage and tool approval. They never call Meta.

Muse Code has a live check against the real CLI, signed in on this machine
with `muse login`. It spends that account's Muse usage, so it runs only when
asked:

```sh
OMB_LIVE_MUSE=1 pnpm exec vitest run server/drivers/muse-code.live.test.ts
```

It lists the account's models (Muse Wonder 1.0), answers on Muse Wonder, runs
a shell command as a tool step, and resumes the session on a fresh instance
after the first one is gone, the way an app restart does.
