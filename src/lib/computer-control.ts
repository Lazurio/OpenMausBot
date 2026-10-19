import type { ComputerHelpRef } from "../../shared/wire";

export type ComputerControlAction = "take" | "release";

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

/** The server's answer must match the request: a take that is not held, or a release that still is, fails. */
export async function transitionComputerControlLease<
  Action extends ComputerControlAction,
  Snapshot extends ComputerControlSnapshot,
>(input: {
  action: Action;
  requestControl: (action: Action) => Promise<Snapshot>;
}): Promise<Snapshot> {
  const { action, requestControl } = input;
  const snap = await requestControl(action);
  if (snap.held !== (action === "take")) {
    throw new Error(`OpenMausBot could not ${action === "take" ? "confirm" : "release"} computer control`);
  }
  return snap;
}
