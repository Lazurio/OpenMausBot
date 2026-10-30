// Lazurio MausBot WhatsApp intake: the shape of its durable state,
// `<data>/whatsapp-intake.json`. Security invariant: ids, times and actions,
// never message text.
import { z } from "zod";

export type TriggerKind = "mention" | "reply" | "batch";
export type LedgerAction =
  | "observed" | "run" | "duplicate" | "sent" | "draft" | "escalated" | "no_action" | "skipped" | "missed"
  | "invalid_output" | "run_failed" | "send_failed" | "command" | "dm_reported" | "digest";

const ledgerSchema = z.object({
  at: z.number().finite().nonnegative(),
  action: z.enum(["observed", "run", "duplicate", "sent", "draft", "escalated", "no_action", "skipped", "missed",
    "invalid_output", "run_failed", "send_failed", "command", "dm_reported", "digest"]),
  group: z.string().optional(),
  ids: z.array(z.string()).optional(),
  runId: z.string().optional(),
  reason: z.string().optional(),
});
export type LedgerEntry = z.output<typeof ledgerSchema>;

const editSchema = z.object({ id: z.string(), hash: z.string() });
/** An edited message of the operator's that the intake judged: its id and a hash of the text judged last, never the text. */
export type OperatorEdit = z.output<typeof editSchema>;

const chatSchema = z.object({
  lastSeenAt: z.number().optional(),
  /** The messages already handled, with their times: every one since the last complete catch-up (in a mapped group at
   * most 5,000), and at least the newest 500. `own` marks the account's own messages, which the catch-up never reads
   * again; in the operator's chat it reads a change to any other one again, since it may be an edit. */
  seen: z.array(z.object({ id: z.string(), at: z.number(), own: z.boolean().optional() })),
  /** The newest time among handled messages no longer in `seen`. In a mapped group, a message the journal shows again at
   * or before it is taken for one of them, changed since (an edit, a sender id wacli normalized), not a new one. The
   * operator's chat never uses it: wacli's journal cannot tell a change from a new message, and a command there is never
   * skipped. */
  forgottenUpTo: z.number().optional(),
  /** The operator's chat only: the edited messages the intake judged, the newest 1,000. A change to one whose text hashes
   * as the one judged last is a rewrite wacli made (a sender it normalized, a chat it moved), not a new edit. */
  edits: z.array(editSchema).optional(),
  lastTeamAt: z.number().optional(),
  /** The ids the previous run judged, so the next one knows what is new. */
  lastInput: z.array(z.string()).optional(),
  /** Client messages no one from the team or this account has answered since. */
  open: z.array(z.object({ id: z.string(), at: z.number() })),
});
export type ChatState = z.output<typeof chatSchema>;

const commandSchema = z.object({
  verb: z.enum(["stop", "start"]),
  /** When WhatsApp says the operator sent it. */
  at: z.number(),
  id: z.string(),
});
export type Command = z.output<typeof commandSchema>;

const commandsSchema = z.object({ all: commandSchema.optional(), groups: z.record(z.string(), commandSchema) });
/** The latest STOP or START for all groups, and for each group key. */
export type Commands = z.output<typeof commandsSchema>;

const runSchema = z.object({
  runId: z.string(),
  chat: z.string(),
  trigger: z.enum(["mention", "reply", "batch"]),
  ids: z.array(z.string()),
  inputIds: z.array(z.string()),
  startedAt: z.number(),
});
export type ActiveRun = z.output<typeof runSchema>;

export const stateSchema = z.object({
  version: z.literal(1),
  activatedAt: z.number(),
  triggers: z.record(z.string(), z.string()),
  commands: commandsSchema,
  /** Where the catch-up continues in wacli's change journal. */
  journal: z.object({ checkpoint: z.string() }).optional(),
  chats: z.record(z.string(), chatSchema),
  sent: z.array(z.object({ id: z.string(), chat: z.string(), at: z.number() })),
  runs: z.array(runSchema),
  ledger: z.array(ledgerSchema),
  /** The bot's one-liners wait here only until the next digest is sent. */
  digest: z.object({
    lastDay: z.string().optional(),
    lastAt: z.number().optional(),
    lines: z.array(z.object({ group: z.string(), at: z.number(), line: z.string() })),
  }),
});
export type IntakeState = z.output<typeof stateSchema>;
