import { appendFileSync } from "node:fs";
import { migrationFetch } from "./lazurio-migration-contract.mjs";

globalThis.fetch = migrationFetch((kind) => appendFileSync("/work/network-events.ndjson",
  `${JSON.stringify({ kind, at: Date.now() })}\n`, { mode: 0o600 }), globalThis.fetch);
