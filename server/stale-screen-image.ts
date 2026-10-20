// Lazurio overlay (DEV-6673): MausBot's own computer is gone, and with it the `screen` messages that carried a frame
// of its screen as base64 `png` (with its `mime`). Older ones stay stored in a conversation. They are read without
// the image, so no page, event, transcript or export sends those pixels; the feature does not come back.

/** The message without a stale screen image: no top-level `png`, and no `mime` on a `screen` message. */
export function withoutScreenImage<T extends object>(message: T): T {
  const record = message as Record<string, unknown>;
  const screen = record.kind === "screen";
  if (!("png" in record) && !(screen && "mime" in record)) return message;
  const { png: _png, ...rest } = record;
  if (screen) delete rest.mime;
  return rest as T;
}
