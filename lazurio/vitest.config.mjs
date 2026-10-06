// Vitest config of the Lazurio Fork CI shards: upstream's vite.config.ts,
// unchanged, with a sequencer that splits `--shard` by measured duration.
// Vitest's own split hashes the file path, which put three of the slowest
// files (about 9 of the suite's 45 minutes) into one shard.
//
// lazurio/vitest-durations.json holds, in seconds, the files that took 5 s
// or more on average in two Lazurio Fork CI runs on the test files of main at
// a57f8dc5 (runs 37476583884 and 37478790478), measured as the time between a
// shard's consecutive finished-file lines in the log; every other file weighs
// 0.7 s, their average. An outdated duration only unbalances the shards:
// every file still runs in exactly one of them. A listed file that no longer
// exists fails the run; rename or drop its entry, and re-measure the same way
// when the shards drift apart.
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";

import { readDurations, splitByDuration } from "../scripts/lazurio-ci-scope.mjs";
import upstream from "../vite.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const durations = readDurations(root);

class DurationSequencer extends BaseSequencer {
  async shard(specs) {
    const { index, count } = this.ctx.config.shard;
    const byFile = new Map(specs.map((spec) => [relative(root, spec.moduleId).split(sep).join("/"), spec]));
    if (byFile.size !== specs.length) throw new Error("a test file appears twice; the duration split expects one project");
    return splitByDuration([...byFile.keys()], durations, count)[index - 1].map((file) => byFile.get(file));
  }
}

export default mergeConfig(upstream, defineConfig({ root, test: { sequence: { sequencer: DurationSequencer } } }));
