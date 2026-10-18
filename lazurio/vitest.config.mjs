// Vitest config of the Lazurio Fork CI: upstream's vite.config.ts, unchanged
// (its own duration sequencer splits `--shard`), without the upstream tests
// that exercise the source-available enterprise layer. Lazurio ships the
// open-source edition: `enterprise/` is not in this tree (its license forbids
// redistribution and hosting for third parties; LICENSING.md), so these files
// would only fail on its absence. Upstream's own "open-source edition builds
// without enterprise/" job skips them the same way. The release contract test
// checks that each one still reads enterprise/ and that every other test runs.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import upstream from "../vite.config.ts";

export const ENTERPRISE_LAYER_TESTS = [
  "scripts/testing/verification-docs.test.ts",
  "server/hosted-access.test.ts",
  "server/hosted-models-api.test.ts",
];

const root = fileURLToPath(new URL("..", import.meta.url));

export default mergeConfig(upstream, defineConfig({
  root,
  test: { exclude: [...configDefaults.exclude, ...ENTERPRISE_LAYER_TESTS] },
}));
