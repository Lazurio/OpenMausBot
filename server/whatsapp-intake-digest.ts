// Lazurio MausBot WhatsApp intake: the operator's workday digest and the
// Prague time its messages use. Security invariant: the digest is built from
// the ledger and the group state alone, counts, times and the bot's one-liners,
// never message text.
import { isPaused } from "./whatsapp-intake-commands.ts";
import type { GroupMap } from "./whatsapp-intake-config.ts";
import type { IntakeState, LedgerAction } from "./whatsapp-intake-state.ts";

const ZONE = "Europe/Prague";
const DAY_MS = 24 * 60 * 60_000;
const UNANSWERED_MS = 2 * 60 * 60_000;

export function pragueParts(at: number): { day: string; weekday: number; hour: number; clock: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour), clock: `${parts.hour}:${parts.minute}` };
}

export const clock = (at: number) => pragueParts(at).clock;

/** Since the previous digest: per group the replies, drafts, escalations still open, client messages without a reaction
 * for over 2 hours and the bot's digest lines; then the follower (`follower`, in words), the last message, unfinished
 * runs, a pause and the number of unmapped groups. */
export function composeDigest(input: { state: IntakeState; map: GroupMap; now: number; follower: string; unmapped: number }): string {
  const { state, map, now } = input;
  const since = state.digest.lastAt ?? now - DAY_MS;
  const entries = state.ledger.filter((entry) => entry.at > since);
  const lines = [`Přehled podpory od ${pragueParts(since).day} ${clock(since)}`];
  for (const group of map.groups) {
    const own = entries.filter((entry) => entry.group === group.key);
    const count = (action: LedgerAction) => own.filter((entry) => entry.action === action).length;
    const chat = state.chats[group.chat];
    const escalations = own.filter((entry) => entry.action === "escalated");
    const open = escalations.filter((entry) => !(chat?.lastTeamAt !== undefined && chat.lastTeamAt > entry.at)).length;
    const waiting = (chat?.open ?? []).filter((entry) => now - entry.at > UNANSWERED_MS);
    lines.push(`${group.name}${isPaused(state.commands, group.key) ? " (pozastaveno)" : ""}: odpovědi ${count("sent")} · návrhy ${count("draft")} · eskalace ${escalations.length}, otevřené ${open} · bez reakce přes 2 h ${waiting.length}${waiting.length ? ` (${waiting.slice(-10).map((entry) => clock(entry.at)).join(", ")})` : ""}`);
    for (const line of state.digest.lines.filter((entry) => entry.group === group.key).slice(-10)) lines.push(`– ${line.line}`);
  }
  const failed = entries.filter((entry) => entry.action === "run_failed" || entry.action === "invalid_output").length;
  const last = Math.max(0, ...map.groups.map((group) => state.chats[group.chat]?.lastSeenAt ?? 0));
  lines.push(`Stav: wacli ${input.follower} · poslední zpráva ${last ? clock(last) : "žádná"} · nedokončené běhy ${failed}${state.commands.all?.verb === "stop" ? " · odesílání pozastavené" : ""}${input.unmapped ? ` · nezmapované skupiny ${input.unmapped}` : ""}`);
  return lines.join("\n");
}
