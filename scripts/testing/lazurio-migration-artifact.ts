import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const MIGRATION_CANDIDATE = {
  version: "0.1.115-lazurio.7",
  source: "b726e96af313b621b6e4200a5deb4d593af96df9",
  sha256: "5b58fda0e5fd6533a7603e004950038378bc53811e2845adfaf40be51057f264",
  size: 9_724_231,
} as const;

/** Only the reviewed release can enter the migration sandbox; no download or package scripts. */
export function unpackMigrationCandidate(archive: string, manifest: string, destination: string): void {
  const evidence = JSON.parse(readFileSync(manifest, "utf8"));
  const bytes = readFileSync(archive);
  if (bytes.length !== MIGRATION_CANDIDATE.size || createHash("sha256").update(bytes).digest("hex") !== MIGRATION_CANDIDATE.sha256
    || evidence.source?.commit !== MIGRATION_CANDIDATE.source || evidence.source?.version !== MIGRATION_CANDIDATE.version
    || evidence.artifact?.archive?.sha256 !== MIGRATION_CANDIDATE.sha256 || evidence.artifact?.archive?.size !== bytes.length) {
    throw new Error("candidate-mismatch");
  }
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const names = new Set<string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const octal = (start: number, length: number) => {
      const value = field(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("invalid-tar-number");
      return Number.parseInt(value, 8);
    };
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (sum !== octal(148, 8)) throw new Error("invalid-tar-checksum");
    const prefix = field(345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`.replace(/\/$/, "");
    const type = field(156, 1);
    const size = octal(124, 12);
    if (!(name.startsWith("package/") || name === "package" && type === "5") || name.split("/").some((part) => !part || part === "." || part === "..")
      || name.includes("\\") || names.has(name) || !["", "0", "5"].includes(type)
      || offset + 512 + size > tar.length || names.size >= 10_000) throw new Error("unsafe-tar-entry");
    names.add(name);
    const target = join(destination, name);
    if (type === "5") mkdirSync(target, { recursive: true, mode: 0o700 });
    else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size), { flag: "wx", mode: 0o400 });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const pkg = JSON.parse(readFileSync(join(destination, "package/package.json"), "utf8"));
  if (!names.has("package/cli.js") || pkg.version !== MIGRATION_CANDIDATE.version) throw new Error("invalid-package");
}
