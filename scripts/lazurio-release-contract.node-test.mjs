// Contract for the Lazurio distribution files. Run with:
//   node --test scripts/lazurio-release-contract.node-test.mjs
import * as NodeAssert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";

const read = (path) => NodeFSP.readFile(path, "utf8");

NodeTest.test("the distribution is the open-source edition: no enterprise/ in the tree", async () => {
  // enterprise/ is under the OpenMausBot Enterprise License, which forbids
  // redistribution and hosting for third parties (LICENSING.md).
  NodeAssert.equal(existsSync("enterprise"), false, "enterprise/ must not exist");
  NodeAssert.equal(execFileSync("git", ["ls-files", "--", "enterprise"], { encoding: "utf8" }), "", "enterprise/ must not be tracked");
  // No document links into the removed folder, and the ones that describe it say so.
  const links = spawnSync("git", ["grep", "-n", "-E", "\\]\\((\\.\\./)*enterprise/", "--", "*.md"], { encoding: "utf8" });
  NodeAssert.equal(links.status, 1, `links into the removed enterprise/:\n${links.stdout}`);
  for (const doc of ["LICENSING.md", "docs/verification/enterprise-license.md", "docs/verification/hosted-workspaces.md"]) {
    NodeAssert.match(await read(doc), /Lazurio's distribution\**\s+\(`Lazurio\/OpenMausBot`\)/, `${doc} labels the enterprise guidance as upstream's`);
  }
  // Upstream's shard weights must not name a test file that no longer exists.
  NodeAssert.doesNotMatch(await read("scripts/testing/vitest-shard-weights.json"), /"enterprise\//);
  // The CI config skips only the upstream tests that read the layer itself.
  const config = await read("lazurio/vitest.config.mjs");
  const list = /export const ENTERPRISE_LAYER_TESTS = \[\n([^\]]*)\];/.exec(config)?.[1];
  NodeAssert.ok(list, "lazurio/vitest.config.mjs lists ENTERPRISE_LAYER_TESTS");
  NodeAssert.match(config, /exclude: \[\.\.\.configDefaults\.exclude, \.\.\.ENTERPRISE_LAYER_TESTS\]/);
  const skipped = [...list.matchAll(/"([^"]+)"/g)].map(([, file]) => file);
  NodeAssert.ok(skipped.length > 0);
  for (const file of skipped) {
    NodeAssert.match(await read(file), /enterprise[/"', ]+server[/"', ]+workspace-access\.ts/, `${file} reads the enterprise layer`);
  }
});
