// Lazurio Fork CI: which vitest files a run executes, and how its shards
// split them. Runbook: docs/operations/lazurio-fork-release.md, "Testing
// before a release".
//
// Upstream's suite is about 900 files and 45 minutes of serial tests; the
// overlay's own tests take seconds. A pull request that changes only
// Lazurio files, documentation or tests therefore runs the overlay's own
// tests (every test file the overlay adds or changes against UPSTREAM_SHA)
// and what `vitest related` relates to its diff: the changed test files and
// every test that imports a changed file.
//
// vitest relates by imports only, and upstream's tests reach most upstream
// code another way: about a hundred end-to-end tests start server/index.ts
// as a child process (no test imports it), and the UI tests load the app,
// index.html included, through a Vite dev server. A pull request that
// changes upstream code (any file present at UPSTREAM_SHA other than
// Markdown and test files) therefore runs the whole suite. So does one that
// changes CI and the upstream pin, this selection and the shard config, the
// test runner, dependencies, shared test helpers or fixtures; one whose base
// does not stand on the pinned upstream commit; and one whose diff cannot be
// read. Pushes to main and manual runs (a rebuild on a new upstream tag is
// dispatched by hand) always run everything.
//
// What stays outside the import graph for Lazurio code (a Lazurio module
// the spawned server loads, a file a test reads from disk) is covered by the
// overlay's own end-to-end tests, which boot the real server on every pull
// request, and by main running everything after each merge.
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
 * @param {{ changed: string[], upstream: string[], overlay: string[] }} diff
 *   paths the pull request changes, those of them present at the pinned
 *   upstream commit, and paths the overlay adds or changes against upstream
 * @returns {{ scope: "full", reason: string } | { scope: "related", files: string[] }}
 */
export function selectTests({ changed, upstream, overlay }) {
  if (![changed, upstream, overlay].every(Array.isArray) || changed.length === 0) {
    return { scope: "full", reason: "the pull request's diff is empty or unreadable" };
  }
  for (const file of [...changed, ...upstream, ...overlay]) {
    if (typeof file !== "string" || file.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("-"))) {
      return { scope: "full", reason: `unexpected path ${JSON.stringify(file)}` };
    }
  }
  const trigger = changed.find((file) => FULL_SUITE.some((pattern) => pattern.test(file)));
  if (trigger) return { scope: "full", reason: `${trigger} changed` };
  const code = upstream.find((file) => !file.endsWith(".md") && !TEST_FILE.test(file));
  if (code) return { scope: "full", reason: `upstream code ${code} changed, which tests reach outside the import graph` };
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
  const changed = diffPaths(cwd, [mergeBase, head]);
  const present = changed.length === 0 ? "" : git(cwd, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", upstream, "--", ...changed]);
  if (present && !present.endsWith("\0")) throw new Error("unreadable git ls-tree output");
  return selectTests({
    changed,
    upstream: present ? present.slice(0, -1).split("\0") : [],
    overlay: diffPaths(cwd, ["--diff-filter=d", upstream, head]),
  });
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
