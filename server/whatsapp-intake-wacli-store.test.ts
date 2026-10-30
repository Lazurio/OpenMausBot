// The WhatsApp intake's one read of wacli's store: a message's edit time. Each
// store here is built from wacli v0.25.1's own schema (internal/store/schema.sql
// and migrations.go, commit b7603b69) for the tables the read touches, with
// synthetic rows only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { PINNED_MIGRATION, readEditTime } from "./whatsapp-intake-wacli-store.ts";
import { spawnWacli } from "./whatsapp-intake-wacli.ts";

const OPERATOR = "15550000002@s.whatsapp.net";
const EDITED_AT = Date.parse("2026-11-02T08:05:00Z");

const CHATS = `CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    kind TEXT NOT NULL, -- dm|group|broadcast|newsletter|unknown
    name TEXT,
    last_message_ts INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    muted_until INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0
);`;

const MESSAGES = `CREATE TABLE IF NOT EXISTS messages (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    chat_name TEXT,
    msg_id TEXT NOT NULL,
    sender_jid TEXT,
    sender_name TEXT,
    ts INTEGER NOT NULL,
    from_me INTEGER NOT NULL,
    text TEXT,
    display_text TEXT,
    quoted_msg_id TEXT,
    quoted_sender_jid TEXT,
    is_forwarded INTEGER NOT NULL DEFAULT 0,
    forwarding_score INTEGER NOT NULL DEFAULT 0,
    reaction_to_id TEXT,
    reaction_emoji TEXT,
    media_type TEXT,
    media_caption TEXT,
    filename TEXT,
    mime_type TEXT,
    direct_path TEXT,
    media_key BLOB,
    file_sha256 BLOB,
    file_enc_sha256 BLOB,
    file_length INTEGER,
    local_path TEXT,
    downloaded_at INTEGER,
    media_unavailable_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0,
    deleted_for_me INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    deletion_reason TEXT,
    payload_purged_at INTEGER,
    edited INTEGER NOT NULL DEFAULT 0,
    edited_ts INTEGER NOT NULL DEFAULT 0,
    buttons TEXT,
    UNIQUE(chat_jid, msg_id),
    FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
);`;

// wacli v0.25.1's migrations in order; its store records each one it applied.
const MIGRATIONS = [
  "core schema", "messages display_text column", "messages fts", "groups left_at column", "messages forwarded columns",
  "messages reaction columns", "starred messages", "messages revoked column", "messages deleted_for_me column",
  "chat state columns", "group hierarchy columns", "contacts system_name column", "messages buttons column",
  "polls and poll_votes", "call events", "messages edited columns", "status messages", "chat unread count column",
  "messages quoted columns", "messages media_unavailable_at column", "message tombstone metadata",
  "message local media aliases", "app state recovery markers", "app state recovery intents", "message locations",
  "message identity indexes and selective fts updates", "repair placeholder chat activity", "unavailable app state keys",
  "message receipts", "retrieval identity, revision and sync state", "content-free message change journal",
  "message receipt retrieval revisions", "ordered chat auto-unarchive",
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-wacli-store-"));
  dirs.push(dir);
  return dir;
}

/** A store as wacli v0.25.1 leaves it, in WAL mode, with the operator's chat and two of its messages, one of them edited.
 * Returns the store's folder and wacli's own handle, open, as while wacli runs. */
function wacliStore(): { store: string; wacli: DatabaseSync } {
  const store = folder();
  const wacli = new DatabaseSync(join(store, "wacli.db"));
  wacli.exec("PRAGMA journal_mode=WAL;");
  wacli.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);");
  const applied = wacli.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)");
  MIGRATIONS.forEach((name, index) => applied.run(index + 1, name, 1_793_000_000));
  wacli.exec(CHATS);
  wacli.exec(MESSAGES);
  wacli.prepare("INSERT INTO chats(jid, kind, name) VALUES (?, 'dm', 'Operator')").run(OPERATOR);
  const add = wacli.prepare("INSERT INTO messages(chat_jid, msg_id, sender_jid, ts, from_me, text, edited, edited_ts) VALUES (?, ?, ?, ?, 0, ?, ?, ?)");
  const sent = Date.parse("2026-11-02T08:00:00Z") / 1_000;
  add.run(OPERATOR, "3EB0EDITED", OPERATOR, sent, "STOP", 1, EDITED_AT / 1_000);
  add.run(OPERATOR, "3EB0PLAIN", OPERATOR, sent, "Díky.", 0, 0);
  return { store, wacli };
}

/** The time read, or why there is none. */
function told(store: string | undefined, id = "3EB0EDITED"): string {
  const time = readEditTime(store, OPERATOR, id);
  return "unknown" in time ? time.unknown : `at ${new Date(time.at).toISOString()}`;
}

describe("readEditTime", () => {
  it("reads the edit time wacli v0.25.1 keeps, in ms, and 0 for a message never edited, also through the adapter", async () => {
    const { store, wacli } = wacliStore();
    try {
      expect(readEditTime(store, OPERATOR, "3EB0EDITED")).toEqual({ at: EDITED_AT });
      expect(readEditTime(store, OPERATOR, "3EB0PLAIN")).toEqual({ at: 0 });
      expect(PINNED_MIGRATION).toEqual({ version: MIGRATIONS.length, name: MIGRATIONS.at(-1) });
      expect(await spawnWacli({ store, maxDbSize: "1GB" }).editedAt(OPERATOR, "3EB0EDITED")).toEqual({ at: EDITED_AT });
      expect(await spawnWacli({ maxDbSize: "1GB" }).editedAt(OPERATOR, "3EB0EDITED")).toEqual({ unknown: "no wacli store is set (OMB_WHATSAPP_INTAKE_STORE)" });
    } finally {
      wacli.close();
    }
    // With wacli stopped, its handle closed and the WAL folded back, the read is the same.
    expect(told(store)).toBe("at 2026-11-02T08:05:00.000Z");
  });

  it("reads while wacli writes: a change wacli has not committed keeps no one waiting, and the next read sees it", () => {
    const { store, wacli } = wacliStore();
    try {
      wacli.exec("BEGIN IMMEDIATE;");
      wacli.prepare("UPDATE messages SET text = 'Díky.', edited_ts = ? WHERE msg_id = '3EB0EDITED'").run(EDITED_AT / 1_000 + 60);
      const started = performance.now();
      expect(told(store)).toBe("at 2026-11-02T08:05:00.000Z");
      expect(performance.now() - started).toBeLessThan(1_000);
      wacli.exec("COMMIT;");
      expect(told(store)).toBe("at 2026-11-02T08:06:00.000Z");
    } finally {
      wacli.close();
    }
  });

  it("gives no time from a store it cannot vouch for: none set, none there, not a database, another version's, or without edited_ts", () => {
    expect(told(undefined)).toBe("no wacli store is set (OMB_WHATSAPP_INTAKE_STORE)");
    expect(told(folder())).toContain("unable to open database file");
    const garbage = folder();
    writeFileSync(join(garbage, "wacli.db"), "synthetic bytes, not a database ".repeat(200));
    expect(told(garbage)).toContain("file is not a database");
    const changed = [
      "DELETE FROM schema_migrations WHERE version = 33",
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (34, 'a later migration', 1793000000)",
      "UPDATE schema_migrations SET name = 'another migration' WHERE version = 33",
      "DELETE FROM schema_migrations",
      "DROP TABLE schema_migrations",
      "ALTER TABLE messages DROP COLUMN edited_ts",
    ].map((sql) => {
      const { store, wacli } = wacliStore();
      try {
        wacli.exec(sql);
      } finally {
        wacli.close();
      }
      return told(store);
    });
    expect(changed).toEqual([
      "wacli's store is not v0.25.1's (newest migration 32)",
      "wacli's store is not v0.25.1's (newest migration 34)",
      "wacli's store is not v0.25.1's (newest migration 33)",
      "wacli's store is not v0.25.1's (newest migration undefined)",
      expect.stringContaining("no such table: schema_migrations"),
      expect.stringContaining("no such column: edited_ts"),
    ]);
    const { store, wacli } = wacliStore();
    try {
      expect(told(store, "3EB0GONE")).toBe("wacli's store does not hold the message");
    } finally {
      wacli.close();
    }
  });
});
