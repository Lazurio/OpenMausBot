#!/usr/bin/env bash
# Build and smoke-test the Lazurio OpenMausBot release archive.
#
#   scripts/lazurio-release-archive.sh <X.Y.Z-lazurio.N> <output-dir>
#
# The archive is upstream's own npm package (scripts/build-npm-package.mjs,
# exactly the steps .github/workflows/npm-package.yml runs), packed with
# `npm pack` from this source under the release version: a `package/` tree
# with cli.js, dist-server/, dist/, skills/, enterprise/ and package.json,
# no node_modules, run by Node 24+. Its bytes are published unchanged as
# openmausbot-<version>-linux-x64.tar.gz. Called by lazurio-archive.yml (CI
# and release) and usable locally; see docs/operations/lazurio-fork-release.md.
set -euo pipefail

VERSION="${1:?usage: $0 <X.Y.Z-lazurio.N> <output-dir>}"
OUT_DIR="${2:?usage: $0 <X.Y.Z-lazurio.N> <output-dir>}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-lazurio\.[0-9]+$ ]] || {
  echo "version must be X.Y.Z-lazurio.N, got: $VERSION" >&2
  exit 1
}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ARCHIVE="openmausbot-$VERSION-linux-x64.tar.gz"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
  echo "Node 24 or newer is required, found $(node --version)" >&2
  exit 1
fi
if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
  echo "note: releases are built and proven on linux-x64; this is a local build on $(uname -s)-$(uname -m)" >&2
fi

work="$(mktemp -d)"
cp package.json "$work/package.json.orig"
cleanup() {
  local status=$?
  cp "$work/package.json.orig" "$ROOT/package.json"
  if [[ -n "${server_pid:-}" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  # The smoke server may start rootless Podman under the temporary HOME (a
  # runner with Podman installed). Its storage holds files owned by subordinate
  # UIDs that only `podman unshare` can remove; stop it before deleting.
  if command -v podman >/dev/null 2>&1 && [[ -d "$work/home/.local/share/containers" ]]; then
    HOME="$work/home" podman system migrate >/dev/null 2>&1 || true
    HOME="$work/home" podman unshare rm -rf "$work/home/.local/share/containers" >/dev/null 2>&1 || true
  fi
  rm -rf "$work" 2>/dev/null || echo "warning: could not remove $work" >&2
  exit "$status"
}
trap cleanup EXIT

# The package, the About dialog (vite.config.ts) and serverVersion() all read
# package.json, so the release version is stamped before anything is built.
# It is never committed.
VERSION="$VERSION" node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.env.VERSION;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

pnpm build:server
pnpm exec vite build
node scripts/build-npm-package.mjs
# Lazurio's team definitions ship inside the package, so an Environment can
# import the Steward team from the installed release without the repository
# (the Steward preset, decision 0169). Only this generated package changes;
# upstream's build script and package.json stay untouched.
mkdir -p release/npm/lazurio
cp -R lazurio/teams release/npm/lazurio/teams
node -e '
  const fs = require("node:fs");
  const path = "release/npm/package.json";
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!pkg.files.includes("lazurio")) pkg.files.push("lazurio");
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
'
(cd release/npm && npm pack --silent --pack-destination "$work" >/dev/null)
packed="$work/openmausbot-$VERSION.tgz"
test -f "$packed"

# Upstream's standalone proof (npm-package.yml), plus what Lazurio Machines
# rely on: the exact version, loopback-only serving, and OMB_DEFAULT_BOT_CWD.
mkdir -p "$work/run" "$work/home" "$work/data" "$work/folder"
tar -xzf "$packed" -C "$work/run"
pkg="$work/run/package"
test ! -d "$pkg/node_modules"
for required in cli.js dist-server/index.js dist-server/openmausbot.js dist/index.html package.json LICENSE lazurio/teams/steward.openmaus.json; do
  test -f "$pkg/$required" || { echo "archive is missing package/$required" >&2; exit 1; }
done
test "$(node -p 'require(process.argv[1]).version' "$pkg/package.json")" = "$VERSION"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$pkg/lazurio/teams/steward.openmaus.json"
help="$(node "$pkg/cli.js" --help)"
grep -q "openmausbot serve" <<< "$help"

port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
HOME="$work/home" OMB_WEBHOOK_PORT="$((port + 1))" OMB_DEFAULT_BOT_CWD="$work/folder" \
  node "$pkg/cli.js" serve --no-pair --port "$port" --data-dir "$work/data" --label lazurio-smoke \
  > "$work/serve.log" 2>&1 &
server_pid=$!
healthy=""
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$port/api/health" > /dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ -z "$healthy" ]]; then
  echo "the packaged server did not become healthy" >&2
  cat "$work/serve.log" >&2
  exit 1
fi
# shellcheck disable=SC2016 # the single-quoted program is JavaScript
curl -sf "http://127.0.0.1:$port/.well-known/openmausbot/environment" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).version;if(v!==process.argv[1]){console.error(`server reports ${v}, expected ${process.argv[1]}`);process.exit(1)}})' "$VERSION"
node -e '
  const bots = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (bots.length !== 1 || bots[0].cwd !== process.argv[2]) {
    console.error("the first bot did not start in OMB_DEFAULT_BOT_CWD:", JSON.stringify(bots.map((bot) => bot.cwd)));
    process.exit(1);
  }
' "$work/data/bots.json" "$work/folder"
kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=""

cp "$packed" "$OUT_DIR/$ARCHIVE"
echo "$OUT_DIR/$ARCHIVE"
