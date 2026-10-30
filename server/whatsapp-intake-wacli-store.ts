// Lazurio MausBot WhatsApp intake: the one thing it reads from wacli's store
// itself, when a message was last edited. wacli v0.25.1 (commit b7603b69) keeps
// that as `messages.edited_ts`, the edit's own time in whole seconds, which a
// later edit only moves forward and a rewrite of the row (a sender it
// normalized, a chat it moved) leaves as it was, but prints it in no command:
// `messages show` and the change journal give the edited message's own time. So
// this reads that one column of one row from `<store>/wacli.db`, read-only, and
// only from a store whose newest migration is v0.25.1's. Any other store, or one
// it cannot read, gives no time, and the intake fails closed on that.
//
// The handle closes after each read and is never `immutable`: the store runs in
// WAL mode, recent rows live in the -wal file, and a reader there never waits for
// wacli's writer.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** wacli v0.25.1's newest store migration (internal/store/migrations.go). A store another version migrated may keep its
 * edit times otherwise. */
export const PINNED_MIGRATION = { version: 33, name: "ordered chat auto-unarchive" } as const;

/** When a stored message was last edited, in ms (0: never), or why wacli's store cannot tell. */
export type EditTime = { at: number } | { unknown: string };

export function readEditTime(store: string | undefined, chat: string, id: string): EditTime {
  if (!store) return { unknown: "no wacli store is set (OMB_WHATSAPP_INTAKE_STORE)" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(store, "wacli.db"), { readOnly: true, timeout: 2_000 });
    const newest = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
    if (newest?.version !== PINNED_MIGRATION.version || newest.name !== PINNED_MIGRATION.name) {
      return { unknown: `wacli's store is not v0.25.1's (newest migration ${String(newest?.version)})` };
    }
    const row = db.prepare("SELECT edited_ts FROM messages WHERE chat_jid = ? AND msg_id = ?").get(chat, id);
    return row ? { at: Number(row.edited_ts) * 1_000 } : { unknown: "wacli's store does not hold the message" };
  } catch (error) {
    return { unknown: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  } finally {
    db?.close();
  }
}
