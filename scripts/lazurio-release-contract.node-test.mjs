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

NodeTest.test("the archive ships the Steward team file an Environment imports (issue #4)", async () => {
  const team = "lazurio/teams/steward.openmaus.json";
  JSON.parse(await read(team));
  // Copied into the generated package and its files list between the upstream
  // build and npm pack; upstream's build script and package.json stay as they are.
  const build = script.indexOf("node scripts/build-npm-package.mjs");
  const copy = script.indexOf("cp -R lazurio/teams release/npm/lazurio/teams");
  const files = script.indexOf('pkg.files.push("lazurio")');
  const pack = script.indexOf("npm pack --silent");
  NodeAssert.ok(build > 0 && build < copy && copy < files && files < pack, "team copied and listed after the build, before npm pack");
  NodeAssert.match(script, /const path = "release\/npm\/package\.json";/);
  const upstreamBuild = await read("scripts/build-npm-package.mjs");
  NodeAssert.doesNotMatch(upstreamBuild, /lazurio\/teams/, "upstream's build script stays untouched");
  NodeAssert.doesNotMatch(await read("package.json"), /lazurio\/teams/, "the source package.json stays untouched");
  // The smoke test requires the file inside the package and parses it.
  NodeAssert.match(script, /for required in [^\n]*lazurio\/teams\/steward\.openmaus\.json/);
  NodeAssert.match(script, /JSON\.parse\(require\("node:fs"\)\.readFileSync\(process\.argv\[1\], "utf8"\)\)' "\$pkg\/lazurio\/teams\/steward\.openmaus\.json"/);
});

NodeTest.test("the archive never packs the enterprise layer", () => {
  // Neither place core loads the layer from (server/enterprise.ts), checked
  // after npm pack, and the packaged server must report the open-source edition.
  NodeAssert.match(script, /for layer in enterprise dist-server\/enterprise; do/);
  NodeAssert.ok(script.indexOf("for layer in enterprise") > script.indexOf("npm pack --silent"), "checked on the packed archive");
  NodeAssert.match(script, /\/api\/edition"[^]*?e!=="oss"/);
  // CI refuses an overlay that keeps or changes anything under enterprise/.
  NodeAssert.match(ci, /if \[ -n "\$\(git ls-files -- enterprise\)" \]; then/);
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

NodeTest.test("the Lazurio shell slot survives a rebuild on a new upstream tag", async () => {
  const [page, sidebar] = await Promise.all([read("index.html"), read("src/components/Sidebar.tsx")]);
  // Same-origin loader that Vite leaves alone; the Environment's Launchpad serves it.
  NodeAssert.match(page, /<script type="module" src="\/\.lazurio\/shell\.js" vite-ignore><\/script>/);
  // Padding, not margin: #root is full width under an overflow-hidden body.
  // The column head is the first thing in the sidebar's top bar, above the upstream top row.
  NodeAssert.match(sidebar, /<GlassBar edge="top">\n(?:\s*\{\/\*[^\n]*\*\/\}\n)?\s*\{createElement\("lazurio-column-head", \{ active: "automate" \}\)\}/);
  NodeAssert.equal(sidebar.match(/lazurio-column-head/g)?.length, 1);
});

NodeTest.test("the shell takes the active skin's colours through its roles", async () => {
  const [page, styles] = await Promise.all([read("index.html"), read("src/styles.css")]);
  const block = /<style>\s*:root \{([^}]*)\}\s*<\/style>/.exec(page)?.[1];
  NodeAssert.ok(block, "index.html sets the colour roles on :root");
  const roles = Object.fromEntries([...block.matchAll(/(--lazurio-[\w-]+): ([^;]+);/g)].map(([, name, value]) => [name, value]));
  const names = ["surface", "ink", "ink-muted", "line", "line-strong", "hover", "selected", "control", "raised", "overlay", "overlay-ink", "focus"];
  NodeAssert.deepEqual(Object.keys(roles).sort(), names.map((name) => `--lazurio-${name}`).sort());
  // The rail is the sidebar's panel: one surface, no line between them.
  NodeAssert.equal(roles["--lazurio-surface"], "var(--color-panel)");
  // Every token a role reads is declared by the skins, so a rebuild on an
  // upstream tag that renames one fails here instead of dropping a colour.
  const theme = /@theme \{([^]*?)\n\}/.exec(styles)?.[1];
  NodeAssert.ok(theme, "src/styles.css declares the skin tokens in @theme");
  for (const [, token] of block.matchAll(/var\((--[\w-]+)\)/g)) {
    NodeAssert.match(token, /^--color-/, token);
    NodeAssert.match(theme, new RegExp(`\\n\\s*${token}:`), `${token} is a skin token`);
  }
  // MausBot itself reads none of the roles: outside Lazurio it looks as upstream.
  // The one shell property it reads is the theme's scheme, in the Environment skin (below).
  NodeAssert.deepEqual([...new Set(styles.match(/--lazurio-[\w-]+/g))], ["--lazurio-color-scheme"]);
});

// Root decision 0208: a Lazurio Environment has one colour theme, chosen in
// Apps → Settings, and Chat, Apps and Automate follow it. The shell declares
// it on the document as the design system's tokens (--lz-*), with dark values
// that apply as the host says it shows dark. MausBot follows it through one
// skin, the Environment skin, which only names those tokens; without the
// shell each one falls back to Midnight's value. Which skin is the default,
// the one-time move and the picker are tested in src/lib/environment-skin.test.ts.
NodeTest.test("the Environment skin names the Environment theme, with Midnight as its fallback", async () => {
  const [page, styles] = await Promise.all([read("index.html"), read("src/styles.css")]);
  // MausBot has no light and dark of its own: the theme's dark values follow the device.
  NodeAssert.match(page, /<html lang="en" data-lazurio-appearance="device">/);
  // The shell marks the document before MausBot's module reads the skin: module
  // scripts run in document order, and the build puts the app's entry at the
  // end of <head>, after the shell's.
  NodeAssert.ok(page.indexOf('src="/.lazurio/shell.js"') < page.indexOf('src="/src/main.tsx"'), "the shell loads first");
  const rule = (id) => {
    const rules = [...styles.matchAll(new RegExp(`\\n\\[data-skin="${id}"\\] \\{\\n([^}]*)\\n\\}`, "g"))];
    NodeAssert.equal(rules.length, 1, `one ${id} block`);
    return rules[0];
  };
  const declarations = (body) => new Map([...body.replace(/\/\*[^]*?\*\//g, "").matchAll(/(--[\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.replace(/\s+/g, " ").trim()]));
  const [environmentRule, environmentBody] = rule("environment");
  const environment = declarations(environmentBody);
  // Midnight as it renders: its block, and the focus ring it takes from @theme.
  const midnight = declarations(rule("midnight")[1]);
  const meadow = declarations(rule("meadow")[1]);
  midnight.set("--color-focus", declarations(/@theme \{([^]*?)\n\}/.exec(styles)[1]).get("--color-focus"));
  NodeAssert.deepEqual([...environment.keys()].sort(), [...midnight.keys()].sort());
  // The names the shell's interface v1 promises (LazurioPlatform src/shell/interface.ts
  // `declares.tokens`). Values are never promised; a new name needs the promise first.
  const promised = [
    "--lz-accent",
    "--lz-accent-button",
    "--lz-accent-button-hover",
    "--lz-danger",
    "--lz-danger-bg",
    "--lz-font-mono",
    "--lz-font-sans",
    "--lz-gray-100",
    "--lz-gray-50",
    "--lz-green-500",
    "--lz-info",
    "--lz-info-bg",
    "--lz-ink",
    "--lz-ink-muted",
    "--lz-line",
    "--lz-on-accent",
    "--lz-paper",
    "--lz-radius-sm",
    "--lz-red-500",
    "--lz-success",
    "--lz-surface",
    "--lz-warning",
    "--lz-warning-bg",
  ];
  // Midnight tints a hovered or chosen menu row with its own ink, which a light theme would not show; the Environment
  // skin derives them from its raised surface, as upstream's other skins do.
  const derived = new Map([
    ["--color-menu-hover", "color-mix(in srgb, var(--color-raised) 70%, transparent)"],
    ["--color-menu-active", "var(--color-raised)"],
  ]);
  for (const [name, value] of environment) {
    if (derived.has(name)) {
      NodeAssert.equal(value, derived.get(name), name);
    } else if (name.startsWith("--color-")) {
      const [, token, fallback] = /^var\((--lz-[a-z0-9-]+), (.+)\)$/.exec(value) ?? [];
      NodeAssert.ok(promised.includes(token), `${name}: ${value}`);
      NodeAssert.equal(fallback, midnight.get(name), `${name} falls back to Midnight's value`);
    } else if (name === "--code-color-scheme") {
      NodeAssert.equal(value, `var(--lazurio-color-scheme, ${midnight.get(name)})`);
    } else {
      // The type and corners stay Midnight's: the Environment theme is a colour theme.
      NodeAssert.equal(value, midnight.get(name), name);
    }
  }
  // Bots' names follow the thread they sit on: Midnight's in the block, as every
  // fallback; with the theme's light values Meadow's tones (upstream fits them to
  // a white thread); where its dark values apply Midnight's again. Only those names.
  const identity = (map) => new Map([...map].filter(([name]) => name.startsWith("--identity-")));
  const light = /\n\[data-skin="environment"\]\[data-lazurio-environment-theme\] \{\n([^}]*)\n\}/.exec(styles);
  const dark = /@media \(prefers-color-scheme: dark\) \{\n {2}\[data-skin="environment"\]\[data-lazurio-environment-theme\]\[data-lazurio-theme-dark\] \{\n([^}]*)\n {2}\}\n\}/.exec(styles);
  NodeAssert.ok(light && dark, "the light and the dark rule after the block");
  NodeAssert.deepEqual(declarations(light[1]), identity(meadow));
  NodeAssert.deepEqual(declarations(dark[1]), identity(midnight));
  NodeAssert.equal(identity(meadow).size, 12);
  // Outside the Environment skin MausBot reads neither the theme nor the shell's roles.
  NodeAssert.doesNotMatch(styles.replace(environmentRule, "").replace(/\/\*[^]*?\*\//g, ""), /--lz-|--lazurio-/);
});