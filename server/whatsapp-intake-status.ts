// Lazurio MausBot WhatsApp intake: what its status reports, and the one word
// that sums it up. Pure: the intake passes in what it knows.
import type { WhatsappGroup } from "./whatsapp-intake-config.ts";
import type { LIMITS } from "./whatsapp-intake-guards.ts";
import type { LedgerEntry } from "./whatsapp-intake-state.ts";

export type FollowerState = "starting" | "connected" | "reconnecting" | "down" | "logged_out" | "store_full" | "store_locked" | "wacli_missing";
export type IntakeHealth =
  | "starting" | "ok" | "connecting" | "no_target" | "checkpoint_failed" | "catch_up_failed" | "error" | Exclude<FollowerState, "starting" | "connected" | "reconnecting">;

export interface WhatsappIntakeStatus {
  enabled: true;
  state: IntakeHealth;
  account?: string;
  bot?: { id: string; name: string };
  follower: { state: FollowerState; restarts: number; webhookFailures: number; since?: number; lastEventAt?: number; detail?: string };
  operator: string;
  bundle: string;
  groups: Array<{
    key: string; name: string; chat: string; mode: WhatsappGroup["mode"]; paused: boolean; webhookId?: string;
    runId?: string; batch: number; waiting: number; lastMessageAt?: number; lastTeamAt?: number;
  }>;
  stopped: { all: boolean; groups: string[] };
  limits: typeof LIMITS & { spacing: string };
  activatedAt: number;
  lastCatchUpAt?: number;
  /** Why the last catch-up could not read wacli's journal, or take a checkpoint in it; until one can, replies are drafts. */
  catchUpProblem?: string;
  lastDigestDay?: string;
  unmapped: Array<{ chat: string; lastAt: number }>;
  lastError?: string;
  recent: LedgerEntry[];
}

export interface CatchUpSummary {
  /** Journal entries read. */
  changes: number;
  /** Messages among them handled for the first time. */
  messages: number;
  errors: number;
  /** The journal holds more, which the next tick reads. */
  more: boolean;
}

/** The follower's state in the operator's digest. */
export const FOLLOWER_WORDS: Record<FollowerState, string> = {
  starting: "se spouští", connected: "připojeno", reconnecting: "se znovu připojuje", down: "neběží", logged_out: "odhlášeno",
  store_full: "má plné úložiště", store_locked: "drží jiný proces", wacli_missing: "chybí",
};

/** The status's one word: a missing checkpoint first, since then nothing is collected at all, then a follower that does
 * not run, a catch-up that cannot read the journal and a bot that cannot be found. */
export function intakeHealth(input: {
  receiver: boolean; lastError: string | undefined; journal: boolean; catchUpProblem: string | undefined; follower: FollowerState;
  targetProblem: string | undefined;
}): IntakeHealth {
  if (!input.receiver) return input.lastError ? "error" : "starting";
  if (!input.journal && input.catchUpProblem !== undefined) return "checkpoint_failed";
  const follower = input.follower;
  if (follower === "logged_out" || follower === "store_full" || follower === "store_locked" || follower === "wacli_missing" || follower === "down") return follower;
  if (input.catchUpProblem !== undefined) return "catch_up_failed";
  if (input.targetProblem) return "no_target";
  return follower === "connected" ? "ok" : "connecting";
}
