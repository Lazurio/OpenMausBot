// Contract for the Lazurio distribution files. Run with:
//   node --test scripts/lazurio-release-contract.node-test.mjs
import * as NodeAssert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";

const read = (path) => NodeFSP.readFile(path, "utf8");
const [release, archive, ci, script] = await Promise.all([
  read(".github/workflows/lazurio-release.yml"),
  read(".github/workflows/lazurio-archive.yml"),
  read(".github/workflows/lazurio-fork-ci.yml"),
  read("scripts/lazurio-release-archive.sh"),
]);

NodeTest.test("release is manual, gated, and never overwrites", () => {
  const triggers = release.slice(release.indexOf("\non:"), release.indexOf("\npermissions:"));
  NodeAssert.match(triggers, /workflow_dispatch:/);
  NodeAssert.doesNotMatch(triggers, /^ {2}(push|schedule|release|pull_request\w*):/m);
  NodeAssert.match(release, /^permissions:\n {2}contents: read\n {2}id-token: none/m);
  NodeAssert.match(release, /if: github\.repository == 'Lazurio\/OpenMausBot'/);
  NodeAssert.match(release, /environment: lazurio-openmausbot-release/);
  NodeAssert.match(release, /test "\$RELEASE_CONTROL" = "reviewed-v1"/);
  NodeAssert.match(release, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  NodeAssert.match(release, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-lazurio\\\.\[1-9\]/);
  NodeAssert.match(release, /RELEASE_TAG: v\$\{\{ inputs\.version \}\}/);
  NodeAssert.match(release, /test "\$\(git rev-parse refs\/remotes\/origin\/main\)" = "\$SOURCE_SHA"/);
  NodeAssert.match(release, /git rev-list --merges "\$UPSTREAM_SHA\.\.\$SOURCE_SHA" --count\)" = 0/);
  NodeAssert.match(release, /UPSTREAM_REPOSITORY: https:\/\/github\.com\/milind-soni\/OpenMausBot\.git/);
  // The channel is the newest release, so a release must be the highest version.
  NodeAssert.match(release, /is not newer than the published/);
  // A tag must never set off upstream's publishing workflows.
  NodeAssert.match(release, /Refuse while an upstream workflow is enabled/);
  // After approval: live main must still be the source, and only the release
  // App, whose key is an environment secret, creates the tag.
  NodeAssert.match(release, /main moved away from \$SOURCE_SHA since dispatch/);
  NodeAssert.match(release, /vars\.LAZURIO_RELEASE_APP_ID != ''/);
  NodeAssert.match(release, /secrets\.LAZURIO_RELEASE_APP_PRIVATE_KEY != ''/);
  NodeAssert.match(release, /owner: Lazurio\n {10}repositories: OpenMausBot\n/);
  NodeAssert.match(release, /GH_TOKEN: \$\{\{ steps\.release_app\.outputs\.token \}\}/);
  NodeAssert.match(release, /--method POST "repos\/\$GITHUB_REPOSITORY\/git\/refs"/);
  NodeAssert.doesNotMatch(release, /--force|--clobber|sshCommand/);
  NodeAssert.match(release, /--verify-tag/);
  NodeAssert.match(release, /uses: \.\/\.github\/workflows\/lazurio-archive\.yml/);
  NodeAssert.match(release, /needs: \[verify, archive\]/);
  NodeAssert.match(release, /sha256sum "openmausbot-\$VERSION-linux-x64\.tar\.gz" > SHA256SUMS/);
  NodeAssert.match(release, /subject-path: release-assets\/openmausbot-\$\{\{ inputs\.version \}\}-linux-x64\.tar\.gz/);
  NodeAssert.match(release, /schema_version: "openmausbot\.fork-release\.v1"/);
  NodeAssert.doesNotMatch(release, /npm publish|docker|ghcr\.io/);
});

NodeTest.test("the archive is upstream's npm package, stamped and smoke-tested", () => {
  NodeAssert.match(archive, /on:\n {2}workflow_call:/);
  NodeAssert.match(archive, /^permissions:\n {2}contents: read\n {2}id-token: none/m);
  NodeAssert.match(archive, /runs-on: ubuntu-24\.04/);
  NodeAssert.match(archive, /pnpm install --frozen-lockfile/);
  NodeAssert.match(archive, /node-version: 24\n/);
  NodeAssert.match(archive, /bash scripts\/lazurio-release-archive\.sh "\$VERSION" release-archive/);
  const stamp = script.indexOf("pkg.version = process.env.VERSION");
  NodeAssert.ok(stamp > 0 && stamp < script.indexOf("pnpm build:server"), "the version is stamped before the build");
  const steps = ["pnpm build:server", "pnpm exec vite build", "node scripts/build-npm-package.mjs", "npm pack --silent"];
  for (const [index, step] of steps.entries()) {
    NodeAssert.ok(script.includes(step), step);
    if (index) NodeAssert.ok(script.indexOf(step) > script.indexOf(steps[index - 1]), `${step} runs after ${steps[index - 1]}`);
  }
  NodeAssert.match(script, /ARCHIVE="openmausbot-\$VERSION-linux-x64\.tar\.gz"/);
  NodeAssert.match(script, /test ! -d "\$pkg\/node_modules"/);
  NodeAssert.match(script, /\/\.well-known\/openmausbot\/environment/);
  // The first bot of the packaged server starts in OMB_DEFAULT_BOT_CWD.
  NodeAssert.match(script, /OMB_DEFAULT_BOT_CWD="\$work\/folder"/);
  NodeAssert.match(script, /the first bot did not start in OMB_DEFAULT_BOT_CWD/);
  for (const source of [archive, release, ci]) {
    for (const [, action] of source.matchAll(/uses: ([^\s.][^\s]*)/g)) {
      NodeAssert.match(action, /@[0-9a-f]{40}$/, `${action} must be pinned by commit`);
    }
  }
});

NodeTest.test("the archive never packs the enterprise layer", () => {
  // Neither place core loads the layer from (server/enterprise.ts), checked
  // after npm pack, and the packaged server must report the open-source edition.
  NodeAssert.match(script, /for layer in enterprise dist-server\/enterprise; do/);
  NodeAssert.ok(script.indexOf("for layer in enterprise") > script.indexOf("npm pack --silent"), "checked on the packed archive");
  NodeAssert.match(script, /\/api\/edition"[^]*?e!=="oss"/);
  // CI refuses an overlay that keeps or changes anything under enterprise/.
  NodeAssert.match(ci, /if \[ -n "\$\(git ls-files -- enterprise\)" \]; then/);
  NodeAssert.match(ci, /removed_upstream_enterprise="\$\(git diff --name-only --diff-filter=D "\$UPSTREAM_SHA\.\.HEAD" -- enterprise\/\)"/);
});

NodeTest.test("CI is read-only and pins the exact upstream base", () => {
  NodeAssert.match(ci, /^permissions:\n {2}contents: read\n {2}id-token: none/m);
  NodeAssert.doesNotMatch(ci, /contents: write|packages: write|id-token: write/);
  const tag = /UPSTREAM_TAG: v(\d+\.\d+\.\d+)\n/.exec(ci)?.[1];
  NodeAssert.ok(tag, "CI pins UPSTREAM_TAG");
  NodeAssert.match(ci, /UPSTREAM_SHA: [0-9a-f]{40}\n/);
  NodeAssert.match(ci, new RegExp(`version: ${tag.replaceAll(".", "\\.")}-lazurio\\.0\\n`));
  NodeAssert.match(ci, /Upstream workflows stay disabled/);
});

NodeTest.test("the overlay may change only listed upstream files", () => {
  NodeAssert.match(ci, /git diff --name-only --diff-filter=MDRT "\$UPSTREAM_SHA\.\.HEAD"/);
  NodeAssert.match(ci, /grep -vxF -f <\(printf '%s\\n' "\$\{allowed_upstream_changes\[@\]\}" \$removed_upstream_enterprise\)/);
  NodeAssert.match(ci, /if \[ -n "\$unexpected" \]; then[^]*?exit 1/);
  const list = /allowed_upstream_changes=\(\n([^]*?)\n\s*\)\n/.exec(ci)?.[1];
  NodeAssert.ok(list, "the guard must declare allowed_upstream_changes");
  const lines = list.split("\n").map((line) => line.trim());
  NodeAssert.match(lines[0] ?? "", /^# \S/, "the allowlist must open with a reason");
  for (const entry of lines.filter((line) => line.length > 0 && !line.startsWith("#"))) {
    NodeAssert.match(entry, /^[\w./-]+\.[a-z]+$/, entry);
    NodeAssert.doesNotMatch(entry, /[*?[\]{}]|\.\.|\/$/, entry);
    NodeAssert.doesNotMatch(entry, /^\.github\/workflows\//, "upstream workflows stay unchanged; they are disabled in settings");
  }
});


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
