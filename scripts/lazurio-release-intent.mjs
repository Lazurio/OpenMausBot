// Lazurio OpenMausBot: the release intent a pull request carries (Lazurio
// decision 0218, addendum of 2026-11-01). `lazurio/release-intent.json` names
// the next release; when a merge changes it to a version that has no tag yet,
// lazurio-release-on-merge.yml dispatches lazurio-release.yml for that commit.
// Runbook: docs/operations/lazurio-fork-release.md, "Release on merge".
//
//   node scripts/lazurio-release-intent.mjs <intent file>
// prints `version=…` and `upstream_tag=…` lines for $GITHUB_OUTPUT, or exits 1
// with the reason.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export const SCHEMA = "openmausbot.release-intent.v1";
const VERSION = /^(\d+\.\d+\.\d+)-lazurio\.[1-9]\d*$/;
const UPSTREAM_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The intent's version and upstream tag, or an Error naming what is wrong. */
export function parseIntent(text) {
  let intent;
  try {
    intent = JSON.parse(text);
  } catch {
    return new Error("the release intent is not JSON");
  }
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return new Error("the release intent is not an object");
  const extra = Object.keys(intent).filter((key) => !["schema_version", "version", "upstream_tag"].includes(key));
  if (extra.length) return new Error(`the release intent has unknown fields: ${extra.join(", ")}`);
  if (intent.schema_version !== SCHEMA) return new Error(`schema_version must be ${SCHEMA}`);
  const version = typeof intent.version === "string" ? VERSION.exec(intent.version) : null;
  if (!version) return new Error("version must be X.Y.Z-lazurio.N with N from 1");
  const upstream = typeof intent.upstream_tag === "string" ? UPSTREAM_TAG.exec(intent.upstream_tag) : null;
  if (!upstream) return new Error("upstream_tag must be an upstream stable tag vX.Y.Z");
  if (version[1] !== upstream[1]) return new Error(`version ${intent.version} does not stand on upstream ${intent.upstream_tag}`);
  return { version: intent.version, upstreamTag: intent.upstream_tag };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const result = parseIntent(NodeFS.readFileSync(process.argv[2], "utf8"));
  if (result instanceof Error) {
    console.error(`${process.argv[2]}: ${result.message}`);
    process.exit(1);
  }
  console.log(`version=${result.version}\nupstream_tag=${result.upstreamTag}`);
}
