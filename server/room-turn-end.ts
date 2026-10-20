export function roomTurnEnd(
  event: { ok: boolean; stopReason?: string | null },
  orchestrated: boolean,
): { outcome: "settled" | "provider_failed"; stopReason?: string | null } {
  if (orchestrated && !event.ok) return { outcome: "provider_failed", stopReason: event.stopReason ?? null };
  return { outcome: "settled" };
}
