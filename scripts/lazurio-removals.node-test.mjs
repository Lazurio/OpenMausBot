// Guards for the upstream features Lazurio removes from the code (issue #35,
// DEV-6673 M3). Each area is one manifest in lazurio/removals/:
//   files      upstream files deleted as a whole; CI allows exactly these deletions
//   forbidden  strings no shipped source, catalog or document may contain any more:
//              routes, CLI commands, agent tool names, config keys, env vars, UI entry points
//   routes     requests the running server must answer with 404
//              (server/lazurio-removals.e2e.test.ts)
// Run with: node --test scripts/lazurio-removals.node-test.mjs
import * as NodeAssert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as NodeTest from "node:test";

const DIR = "lazurio/removals";
const manifests = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => ({ file, ...JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) }));

// Everything an agent or a person reads to learn what MausBot can do, except
// tests (which may assert an absence) and the Lazurio files that record the removal.
const SEARCHED = [
  "server", "shared", "src", "scripts", "electron", "companion", "docs", "skills", "apps", "cloudflare",
  "*.md", "package.json", "index.html",
  ":!*.test.ts", ":!*.test.tsx", ":!*.test.mjs", ":!*.node-test.mjs", ":!**/testing/**",
  ":!scripts/lazurio-*", ":!LAZURIO.md", ":!docs/operations/lazurio-fork-release.md",
];

NodeTest.test("every removal manifest is well formed", () => {
  NodeAssert.ok(manifests.length > 0, `${DIR} holds the removal manifests`);
  for (const manifest of manifests) {
    NodeAssert.equal(typeof manifest.area, "string", manifest.file);
    NodeAssert.ok(Array.isArray(manifest.files) && Array.isArray(manifest.forbidden) && Array.isArray(manifest.routes), manifest.file);
    for (const file of manifest.files) NodeAssert.match(file, /^(?!.*\.\.)[\w@-][\w./@-]*[^/]$/, `${manifest.file}: ${file}`);
    for (const route of manifest.routes) {
      NodeAssert.match(route.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${manifest.file}: ${JSON.stringify(route)}`);
      NodeAssert.match(route.path, /^\/api\//, `${manifest.file}: ${JSON.stringify(route)}`);
    }
    for (const text of manifest.forbidden) NodeAssert.ok(typeof text === "string" && text.length >= 4, `${manifest.file}: ${text}`);
  }
});

for (const manifest of manifests) {
  NodeTest.test(`${manifest.area}: the removed files are gone`, () => {
    const left = manifest.files.filter((file) => existsSync(file));
    NodeAssert.deepEqual(left, [], `${manifest.file} lists files that exist`);
    if (manifest.files.length) {
      NodeAssert.equal(execFileSync("git", ["ls-files", "--", ...manifest.files], { encoding: "utf8" }), "");
    }
  });

  NodeTest.test(`${manifest.area}: no source, catalog or document offers it`, () => {
    const found = [];
    for (const text of manifest.forbidden) {
      const grep = spawnSync("git", ["grep", "-n", "-F", "-e", text, "--", ...SEARCHED], { encoding: "utf8", maxBuffer: 64 << 20 });
      NodeAssert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
      if (grep.status === 0) found.push(`${JSON.stringify(text)}:\n${grep.stdout.split("\n").slice(0, 5).join("\n")}`);
    }
    NodeAssert.deepEqual(found, [], `${manifest.file}: still present`);
  });
}
