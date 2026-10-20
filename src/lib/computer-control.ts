import type { ComputerHelpRef } from "../../shared/wire";

export interface ComputerControlSnapshot {
  held: boolean;
  helpReason: string | null;
  help?: ComputerHelpRef | null;
}

const HELP_PLACES = new Set(["browser", "local"]);

export function parseComputerHelp(value: unknown): ComputerHelpRef | null {
  const ref = value as Partial<Record<keyof ComputerHelpRef, unknown>> | null;
  if (!ref || typeof ref !== "object") return null;
  const { botId, threadId, messageId, site, place } = ref;
  return typeof botId === "string" && typeof threadId === "string" && typeof messageId === "string" &&
    typeof site === "string" && typeof place === "string" && HELP_PLACES.has(place)
    ? { botId, threadId, messageId, site, place: place as ComputerHelpRef["place"] } : null;
}

/** Positive-only: loopback callers can influence server state, so a false snapshot never releases the Electron gate. */
export function heldComputerControlBotIds(
  snapshots: Record<string, Pick<ComputerControlSnapshot, "held">>,
): string[] {
  return Object.entries(snapshots)
    .filter(([, snapshot]) => snapshot.held)
    .map(([botId]) => botId);
}
