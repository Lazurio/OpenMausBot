// Lazurio Fork CI: which vitest files a run executes, and how its shards
// split them. Runbook: docs/operations/lazurio-fork-release.md, "Testing
// before a release".
//
// Upstream's suite is about 900 files and 45 minutes of serial tests; the
// overlay's own tests take seconds. A pull request therefore runs the
// overlay's own tests (every test file the overlay adds or changes against
// UPSTREAM_SHA) and what `vitest related` relates to the pull request's diff:
// the changed test files and every test that imports a changed file. The
// overlay guard lets a pull request change only allowlisted upstream files,
// and a new allowlist entry is a CI change, so the rest of a diff is Lazurio
// files and allowlisted upstream files.
//
// The whole suite runs on pushes to main and on manual runs (a rebuild on a
// new upstream tag is dispatched by hand), and on a pull request that
// changes what the import graph cannot see: CI and the upstream pin, this
// selection and the shard config, the test runner, dependencies, shared test
// helpers and fixtures. A pull request whose base does not stand on the
// pinned upstream tag, or whose diff cannot be read, runs the whole suite too.
//
// vitest relates by imports only: a test that starts the server as a child
// process, or reads a file from disk, is not related to what it uses. The
// overlay's own end-to-end tests boot the real server on every pull request,
// and main runs everything after each merge.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SUITE = [
  /^\.github\//, // CI, including the upstream pin (UPSTREAM_TAG, UPSTREAM_SHA)
  /^scripts\/lazurio-ci-scope\.mjs$/, // this selection
  /^lazurio\/vitest[.-]/, // the shard config and its measured durations
  /(^|\/)package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^\.npmrc$/,
  /(^|\/)(vite|vitest)\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(testing|test|__mocks__|[^/]*fixtures)\//, // shared test helpers, the setup file, fixtures
];
const TEST_FILE = /\.test\.(ts|mjs)$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * @param {{ changed: string[], overlay: string[] }} diff paths the pull
 *   request changes, and paths the overlay adds or changes against upstream
 * @returns {{ scope: "full", reason: string } | { scope: "related", files: string[] }}
 */
export function selectTests({ changed, overlay }) {
  if (!Array.isArray(changed) || !Array.isArray(overlay) || changed.length === 0) {
    return { scope: "full", reason: "the pull request's diff is empty or unreadable" };
  }
  for (const file of [...changed, ...overlay]) {
    if (typeof file !== "string" || file.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("-"))) {
      return { scope: "full", reason: `unexpected path ${JSON.stringify(file)}` };
    }
  }
  const trigger = changed.find((file) => FULL_SUITE.some((pattern) => pattern.test(file)));
  if (trigger) return { scope: "full", reason: `${trigger} changed` };
  const files = new Set([...overlay.filter((file) => TEST_FILE.test(file)), ...changed]);
  return { scope: "related", files: [...files].sort() };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

// Rename detection stays off: it would keep only the new path of a moved file.
function diffPaths(cwd, args) {
  const output = git(cwd, ["diff", "--name-only", "--no-renames", "-z", ...args, "--"]);
  if (output && !output.endsWith("\0")) throw new Error("unreadable git diff output");
  return output ? output.slice(0, -1).split("\0") : [];
}

/** The tests of a pull request from `base` to `head` on the pinned `upstream` commit. */
export function pullRequestScope({ base, head, upstream, cwd = process.cwd() }) {
  if (![base, head, upstream].every((sha) => typeof sha === "string" && SHA.test(sha))) {
    throw new Error("missing or invalid commit SHAs");
  }
  const mergeBase = git(cwd, ["merge-base", base, head]).trim();
  const onUpstream = spawnSync("git", ["merge-base", "--is-ancestor", upstream, mergeBase], { cwd, encoding: "utf8", timeout: 60_000 });
  if (onUpstream.status === 1) {
    return { scope: "full", reason: `the pull request's base ${mergeBase} does not stand on the pinned upstream ${upstream}` };
  }
  if (onUpstream.status !== 0) throw new Error(`git merge-base --is-ancestor failed: ${onUpstream.stderr}`);
  return selectTests({ changed: diffPaths(cwd, [mergeBase, head]), overlay: diffPaths(cwd, ["--diff-filter=d", upstream, head]) });
}

// Every file lands in exactly one of `count` shards, longest first, each on
// the shard with the least time so far; a file missing from `durations`
// weighs UNLISTED_SECONDS. The same files give the same split on every shard.
export const UNLISTED_SECONDS = 0.75;

/** @returns {string[][]} the files of each shard */
export function splitByDuration(files, durations, count) {
  const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
  const weighted = [...new Set(files)]
    .map((file) => ({ file, seconds: Object.hasOwn(durations, file) ? durations[file] : UNLISTED_SECONDS }))
    .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const { file, seconds } of weighted) {
    const shard = shards.reduce((least, next) => (next.seconds < least.seconds ? next : least));
    shard.seconds += seconds;
    shard.files.push(file);
  }
  return shards.map((shard) => shard.files);
}

/** lazurio/vitest-durations.json; a listed file that no longer exists fails. */
export function readDurations(root) {
  const durations = JSON.parse(readFileSync(resolve(root, "lazurio/vitest-durations.json"), "utf8"));
  for (const [file, seconds] of Object.entries(durations)) {
    if (!(Number.isFinite(seconds) && seconds > 0)) throw new Error(`lazurio/vitest-durations.json: ${file} needs a duration in seconds`);
  }
  const missing = Object.keys(durations).filter((file) => !existsSync(resolve(root, file)));
  if (missing.length > 0) {
    throw new Error(`lazurio/vitest-durations.json lists test files that no longer exist; rename or drop them: ${missing.join(", ")}`);
  }
  return durations;
}

// CI: `node scripts/lazurio-ci-scope.mjs` writes vitest_scope and
// vitest_related to GITHUB_OUTPUT. Locally,
// `UPSTREAM_SHA=<sha> node scripts/lazurio-ci-scope.mjs <base> <head>`
// prints what a pull request from <base> to <head> would run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result = { scope: "full", reason: `this is a ${process.env.GITHUB_EVENT_NAME ?? "local"} run` };
  if (process.argv.length === 4 || process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      const pr = process.argv.length === 4
        ? { base: { sha: process.argv[2] }, head: { sha: process.argv[3] } }
        : JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request;
      result = pullRequestScope({ base: pr?.base?.sha, head: pr?.head?.sha, upstream: process.env.UPSTREAM_SHA });
    } catch (error) {
      result = { scope: "full", reason: `the pull request's tests cannot be chosen: ${String(error.message).replace(/\s+/g, " ").trim()}` };
      console.log(`::warning::Running the whole vitest suite because ${result.reason}`);
    }
  }
  const related = result.scope === "related" ? result.files : [];
  console.log(result.scope === "related"
    ? `vitest related, on the overlay's tests and the pull request's changes:\n  ${related.join("\n  ")}`
    : `The whole vitest suite: ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `vitest_scope=${result.scope}\nvitest_related=${JSON.stringify(related)}\n`);
  }
}
