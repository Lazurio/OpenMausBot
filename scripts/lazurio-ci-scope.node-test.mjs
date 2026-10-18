// Which vitest files the Lazurio Fork CI runs (scripts/lazurio-ci-scope.mjs).
// Run with:
//   node --test scripts/lazurio-ci-scope.node-test.mjs
import * as NodeAssert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeTest from "node:test";

import { pullRequestScope, selectTests } from "./lazurio-ci-scope.mjs";

const overlay = ["server/github-intake.ts", "server/github-intake.test.ts", "server/default-bot-cwd.e2e.test.ts", "LAZURIO.md"];

NodeTest.test("a pull request runs the overlay's tests and the inputs of vitest related", () => {
  NodeAssert.deepEqual(selectTests({ changed: ["LAZURIO.md"], upstream: [], overlay }), {
    scope: "related",
    files: ["LAZURIO.md", "server/default-bot-cwd.e2e.test.ts", "server/github-intake.test.ts"],
  });
  // Lazurio code, upstream documentation and upstream tests stay selective.
  const changed = ["server/github-intake.ts", "docs/self-hosting.md", "server/browser-live.test.ts"];
  NodeAssert.deepEqual(selectTests({ changed, upstream: changed.slice(1), overlay: [] }), {
    scope: "related",
    files: ["docs/self-hosting.md", "server/browser-live.test.ts", "server/github-intake.ts"],
  });
});

NodeTest.test("upstream code runs the whole suite: its tests reach it through child processes", () => {
  for (const file of ["server/index.ts", "server/store.ts", "scripts/control-omb.ts", "src/components/Sidebar.tsx", "index.html"]) {
    const scope = selectTests({ changed: ["LAZURIO.md", file], upstream: [file], overlay });
    NodeAssert.equal(scope.scope, "full", file);
    NodeAssert.match(scope.reason, /upstream code/);
  }
});

NodeTest.test("what the import graph cannot see runs the whole suite", () => {
  for (const file of [
    ".github/workflows/lazurio-fork-ci.yml",
    "scripts/lazurio-ci-scope.mjs",
    "lazurio/vitest.config.mjs",
    "package.json",
    "cloudflare/composio-broker/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vite.config.ts",
    "evals/vitest.config.ts",
    "tsconfig.server.json",
    "server/testing/setup.ts",
    "scripts/testing/preview-fixture.ts",
    "companion/test/fixtures/devices.json",
    "shared/package-fixtures/full-team.v2.json",
  ]) {
    NodeAssert.equal(selectTests({ changed: ["LAZURIO.md", file], upstream: [], overlay }).scope, "full", file);
  }
});

NodeTest.test("an empty or unreadable diff runs the whole suite", () => {
  for (const changed of [[], undefined, ["server/../x.ts"], ["server//x.ts"], ["--config=x"], [42]]) {
    NodeAssert.equal(selectTests({ changed, upstream: [], overlay }).scope, "full", JSON.stringify(changed));
  }
  NodeAssert.equal(selectTests({ changed: ["LAZURIO.md"], upstream: undefined, overlay }).scope, "full");
});

NodeTest.test("the scope of a pull request comes from git, and fails closed off the pinned upstream", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "lazurio-ci-scope-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
    }
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const upstream = commit({ "server/store.ts": "1", "server/store.test.ts": "1" }, "upstream");
  commit({ "server/github-intake.ts": "1", "server/github-intake.test.ts": "1", "server/store.test.ts": "2" }, "overlay");
  const base = commit({ "LAZURIO.md": "1" }, "main");
  const head = commit({ "LAZURIO.md": "2", "server/github-intake.ts": "2", "server/store.test.ts": "3" }, "pull request");

  NodeAssert.deepEqual(pullRequestScope({ base, head, upstream, cwd: repo }), {
    scope: "related",
    files: ["LAZURIO.md", "server/github-intake.test.ts", "server/github-intake.ts", "server/store.test.ts"],
  });
  const touchesUpstream = commit({ "server/store.ts": "2" }, "pull request on upstream code");
  NodeAssert.deepEqual(pullRequestScope({ base, head: touchesUpstream, upstream, cwd: repo }), {
    scope: "full",
    reason: "upstream code server/store.ts changed, which tests reach outside the import graph",
  });
  // A rebuild on a newer upstream tag: its base does not stand on the new pin.
  git("checkout", "-q", "-b", "rebuild", upstream);
  const newUpstream = commit({ "server/store.ts": "3" }, "newer upstream");
  const rebuilt = commit({ "server/github-intake.ts": "1" }, "overlay, rebuilt");
  NodeAssert.equal(pullRequestScope({ base, head: rebuilt, upstream: newUpstream, cwd: repo }).scope, "full");
  // Unknown or unrelated commits throw; the CI entry point then runs the whole suite.
  git("checkout", "-q", "--orphan", "unrelated");
  const unrelated = commit({ "README.md": "1" }, "unrelated");
  NodeAssert.throws(() => pullRequestScope({ base: unrelated, head, upstream, cwd: repo }));
  NodeAssert.throws(() => pullRequestScope({ base: "0".repeat(40), head, upstream, cwd: repo }));
  NodeAssert.throws(() => pullRequestScope({ base: "main", head, upstream, cwd: repo }), /invalid commit SHAs/);
});
