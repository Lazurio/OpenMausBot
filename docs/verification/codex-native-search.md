# Codex native search

Process-local overrides disable Codex's bundled desktop-only browser/computer plugins in Codex bot processes; they do not uninstall plugins, change the user's Codex configuration, or disable native web search.

## Regression checks

```sh
pnpm exec vitest run server/drivers/codex.test.ts scripts/testing/native-search-evidence.test.ts
pnpm exec tsc --noEmit -p tsconfig.server.json
```

## Optional real-model acceptance

This check spends real model quota. The script launches a temporary server and bot; never point it at a live workspace. Provide absolute paths through these environment variables:

- `OMB_VERIFY_CODEX_CLI`: installed Codex executable.
- `OMB_VERIFY_CODEX_AUTH`: existing Codex sign-in file. Copied into the temporary fixture only, removed on cleanup, never included in the report.
- `OMB_VERIFY_OUTPUT`: local evidence directory; do not commit raw transcripts or screenshots containing private data.
- `OMB_VERIFY_MODELS`: optional comma-separated models (default `gpt-5.6-luna`).

Run:

```sh
node --experimental-strip-types scripts/verify-codex-search-acceptance.ts
```

The search check requires successful native search and openPage records, and the answer must cite the same official URL returned by that page fetch. Missing actions, other actions, failed fetches, and unrelated citations do not pass. Report-writing failures still run fixture cleanup.

Inspect `acceptance.json` including failures and final responses. Website redirects, network errors and model variability remain possible; do not replace a failed run's evidence with a later success.
