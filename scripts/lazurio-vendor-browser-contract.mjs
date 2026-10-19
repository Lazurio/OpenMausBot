#!/usr/bin/env node
// Lazurio overlay (DEV-6673, task 2026-10-05-510; LazurioPlatform decision
// F50 point 5): vendors the Environment browser's contract module of one
// LazurioPlatform release into lazurio/browser-contract/. Every bump is a
// reviewed pull request made by this command; nothing there is edited by hand:
//
//   node scripts/lazurio-vendor-browser-contract.mjs <tag>     e.g. v0.1.9
//
// 1. `gh release download` fetches the release's shell artifact
//    (lazurio-shell.tar.gz) and the release's one attestation bundle.
// 2. `gh attestation verify` checks the archive against the Platform's
//    release workflow at exactly that tag; the certificate must also name the
//    Platform repository and its owner by their immutable GitHub ids, since a
//    name can be released and claimed by someone else.
// 3. The archive is unpacked in memory, admitting only POSIX ustar entries of
//    regular files with plain relative paths. Nothing from it is executed here.
// 4. artifact.json must name the tag's version and the attested commit, list
//    exactly the archive's other files with their SHA-256, and name the
//    contract's major 1 with its files under `browserContract`.
// 5. lazurio/browser-contract/ is replaced by those files (without their
//    `browser-contract/` prefix), the release's NOTICE, which names the MIT
//    exception, and provenance.json. It holds no time, so one release always
//    vendors the same bytes.
//
// Any refusal leaves lazurio/browser-contract/ as it was.
// scripts/lazurio-browser-contract.node-test.mjs checks the bytes against
// provenance.json and runs the vectors on every CI run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const PLATFORM = Object.freeze({
  repository: "Lazurio/LazurioPlatform",
  // The immutable GitHub ids of the repository and of its owner.
  repositoryId: "1361711425",
  ownerId: "309688040",
  signerWorkflow: "Lazurio/LazurioPlatform/.github/workflows/release.yml",
  asset: "lazurio-shell.tar.gz",
  bundle: "lazurio.sigstore.json",
});
export const ARTIFACT_SCHEMA = "lazurio.shell-artifact.v1";
export const CONTRACT_MAJOR = 1;
export const PROVENANCE_SCHEMA = "lazurio.openmausbot.vendored-browser-contract.v1";
export const VENDOR_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lazurio", "browser-contract");
const PREFIX = "browser-contract/";

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARCHIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export class VendorError extends Error {
  name = "VendorError";
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function versionOfTag(tag) {
  if (!TAG.test(tag)) throw new VendorError(`Not a Platform release tag: ${JSON.stringify(tag)}`);
  return tag.slice(1);
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function field(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("latin1");
}

function octal(header, offset, length, what) {
  const text = field(header, offset, length).trim();
  if (!/^[0-7]{1,11}$/.test(text)) throw new VendorError(`The archive's ${what} field is not an octal number.`);
  return Number.parseInt(text, 8);
}

/** The files of a gzip of a POSIX ustar archive of regular files; anything else refuses the whole archive. */
export function unpack(archive) {
  let tar;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new VendorError("The asset is not a gzip archive.");
  }
  const files = new Map();
  for (let offset = 0; ;) {
    if (offset + 512 > tar.length) throw new VendorError("The archive ends without its end marker.");
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const recorded = octal(header, 148, 8, "checksum");
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (sum !== recorded) throw new VendorError("An archive header has a wrong checksum.");
    if (field(header, 257, 6) !== "ustar") throw new VendorError("The archive is not POSIX ustar.");
    const path = field(header, 0, 100);
    if (header[156] !== 0x30) throw new VendorError(`${JSON.stringify(path)} is not a regular file.`);
    if (field(header, 345, 155) !== "" || field(header, 157, 100) !== "") throw new VendorError(`${JSON.stringify(path)} uses a field the Platform never writes.`);
    if (!ARCHIVE_PATH.test(path)) throw new VendorError(`The archive path ${JSON.stringify(path)} is not admitted.`);
    if (files.has(path)) throw new VendorError(`The archive holds ${path} twice.`);
    const size = octal(header, 124, 12, "size");
    const start = offset + 512;
    if (start + size > tar.length) throw new VendorError(`${path} is truncated.`);
    files.set(path, tar.subarray(start, start + size));
    offset = start + size + ((512 - (size % 512)) % 512);
  }
  return files;
}

/** artifact.json checked against the attested release; the contract's files by their archive paths. */
export function checkArtifact(files, release) {
  const raw = files.get("artifact.json");
  if (raw === undefined) throw new VendorError("The archive has no artifact.json.");
  let artifact;
  try {
    artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new VendorError("artifact.json is not JSON.");
  }
  if (!isRecord(artifact) || artifact.schema !== ARTIFACT_SCHEMA) throw new VendorError(`artifact.json is not ${ARTIFACT_SCHEMA}.`);
  if (artifact.version !== release.version) throw new VendorError(`artifact.json names version ${JSON.stringify(artifact.version)}, not ${release.version}.`);
  if (artifact.sourceCommit !== release.sourceCommit) throw new VendorError(`artifact.json names commit ${JSON.stringify(artifact.sourceCommit)}, not the attested ${release.sourceCommit}.`);
  const listed = artifact.files;
  if (!isRecord(listed)) throw new VendorError("artifact.json lists no files.");
  const others = [...files.keys()].filter((path) => path !== "artifact.json").sort();
  const names = Object.keys(listed).sort();
  if (others.join("\n") !== names.join("\n")) throw new VendorError(`artifact.json lists ${names.join(", ")}; the archive holds ${others.join(", ")}.`);
  for (const path of others) {
    if (typeof listed[path] !== "string" || !SHA256.test(listed[path])) throw new VendorError(`artifact.json has no SHA-256 for ${path}.`);
    if (sha256(files.get(path)) !== listed[path]) throw new VendorError(`${path} does not have the SHA-256 artifact.json lists.`);
  }
  const contract = artifact.browserContract;
  if (!isRecord(contract) || contract.major !== CONTRACT_MAJOR || !Array.isArray(contract.files)) {
    throw new VendorError(`artifact.json names no browser contract of major ${CONTRACT_MAJOR}.`);
  }
  for (const path of contract.files) {
    if (typeof path !== "string" || !path.startsWith(PREFIX) || !files.has(path)) throw new VendorError(`The contract's file ${JSON.stringify(path)} is not in the archive under ${PREFIX}.`);
  }
  for (const needed of ["LICENSE", "pure.js", "pure.d.ts", "node.js", "node.d.ts"]) {
    if (!contract.files.includes(`${PREFIX}${needed}`)) throw new VendorError(`The contract has no ${needed}.`);
  }
  if (!files.has("NOTICE")) throw new VendorError("The archive has no NOTICE.");
  return { contract: [...contract.files].sort(), digests: listed };
}

/** The source commit `gh attestation verify --format json` proved, for exactly this tag of exactly this repository. */
export function attestedCommit(output, tag) {
  let results;
  try {
    results = JSON.parse(output);
  } catch {
    throw new VendorError("gh attestation verify printed no JSON.");
  }
  if (!Array.isArray(results) || results.length !== 1) throw new VendorError("gh attestation verify did not answer exactly one attestation.");
  const certificate = results[0]?.verificationResult?.signature?.certificate;
  if (!isRecord(certificate)) throw new VendorError("The verified attestation has no certificate.");
  const ref = `refs/tags/${tag}`;
  const expected = {
    sourceRepositoryIdentifier: PLATFORM.repositoryId,
    sourceRepositoryOwnerIdentifier: PLATFORM.ownerId,
    sourceRepositoryRef: ref,
    githubWorkflowRef: ref,
    buildSignerURI: `https://github.com/${PLATFORM.signerWorkflow}@${ref}`,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (certificate[name] !== value) throw new VendorError(`The attestation's ${name} is ${JSON.stringify(certificate[name])}, not ${value}.`);
  }
  const commit = certificate.sourceRepositoryDigest;
  if (typeof commit !== "string" || !COMMIT.test(commit) || certificate.buildSignerDigest !== commit) {
    throw new VendorError("The attestation names no single source commit.");
  }
  return commit;
}

/** The vendored directory's files by name, with provenance.json; one release always gives the same bytes. */
export function vendoredFiles({ tag, files, assetDigest, sourceCommit }) {
  const version = versionOfTag(tag);
  const { contract } = checkArtifact(files, { version, sourceCommit });
  const out = new Map();
  for (const path of contract) out.set(path.slice(PREFIX.length), files.get(path));
  out.set("NOTICE", files.get("NOTICE"));
  const provenance = {
    schema: PROVENANCE_SCHEMA,
    repository: { name: PLATFORM.repository, id: PLATFORM.repositoryId, ownerId: PLATFORM.ownerId },
    tag,
    version,
    sourceCommit,
    browserContract: CONTRACT_MAJOR,
    asset: { name: PLATFORM.asset, sha256: assetDigest },
    attestation: { bundle: PLATFORM.bundle, signerWorkflow: PLATFORM.signerWorkflow, sourceRef: `refs/tags/${tag}` },
    files: Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => [name, sha256(bytes)])),
  };
  out.set("provenance.json", Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`));
  return out;
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (error) {
    throw new VendorError(`gh ${args[0]} ${args[1]} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

export function vendor(tag) {
  versionOfTag(tag);
  const scratch = mkdtempSync(join(tmpdir(), "lazurio-browser-contract-"));
  try {
    gh(["release", "download", tag, "--repo", PLATFORM.repository, "--pattern", PLATFORM.asset, "--pattern", PLATFORM.bundle, "--dir", scratch]);
    const asset = join(scratch, PLATFORM.asset);
    const sourceCommit = attestedCommit(gh(["attestation", "verify", asset, "--bundle", join(scratch, PLATFORM.bundle),
      "--repo", PLATFORM.repository, "--signer-workflow", PLATFORM.signerWorkflow, "--source-ref", `refs/tags/${tag}`, "--format", "json"]), tag);
    const archive = readFileSync(asset);
    const out = vendoredFiles({ tag, files: unpack(archive), assetDigest: sha256(archive), sourceCommit });
    const staged = join(scratch, "browser-contract");
    for (const [name, bytes] of out) {
      mkdirSync(dirname(join(staged, name)), { recursive: true });
      writeFileSync(join(staged, name), bytes);
    }
    rmSync(VENDOR_DIRECTORY, { recursive: true, force: true });
    mkdirSync(dirname(VENDOR_DIRECTORY), { recursive: true });
    renameSync(staged, VENDOR_DIRECTORY);
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  try {
    const out = vendor(tag ?? "");
    console.log(`Vendored the browser contract of LazurioPlatform ${tag}: ${out.size} files in lazurio/browser-contract/.`);
  } catch (error) {
    console.error(error instanceof VendorError ? error.message : error);
    process.exit(1);
  }
}
