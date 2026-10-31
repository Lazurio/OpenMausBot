// Lazurio MausBot WhatsApp intake: the operator's STOP and START. A command
// counts from when the operator sent it, not from when it arrived, since the
// webhook may drop one that the catch-up finds after newer ones, and the
// catch-up may read one again long after. The latest command for a group or for
// all groups decides; a STOP and a START of the same second leave sending
// paused. An edit of the operator's message counts once for each text.
import { createHash } from "node:crypto";

import type { WhatsappGroup } from "./whatsapp-intake-config.ts";
import type { Command, Commands, OperatorEdit } from "./whatsapp-intake-state.ts";

export type Verb = Command["verb"];

/** The operator's text as a command: STOP, START, STOP <key> or START <key>, in any case; null for anything else. */
export function parseCommand(text: string): { verb: Verb; key?: string } | null {
  const match = /^\s*(stop|start)(?:\s+([a-z0-9][a-z0-9-]{0,31}))?\s*$/i.exec(text);
  if (!match) return null;
  return { verb: match[1].toLowerCase() as Verb, ...(match[2] ? { key: match[2].toLowerCase() } : {}) };
}

/** How many of the operator's edited messages `newEdit` remembers. */
export const EDITS_KEPT = 1_000;

/** Whether `text` is new in an edit of the operator's message `id`, which it remembers either way. wacli rewrites a stored
 * row with no new edit (a sender it normalized, a chat it moved), and its journal shows that like an edit, so a change
 * whose text hashes as the one judged last is such a rewrite. Only a hash is kept, never the text, and only for the
 * `EDITS_KEPT` messages judged last: a rewrite of one forgotten since counts as a new edit. */
export function newEdit(edits: OperatorEdit[], id: string, text: string): boolean {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const index = edits.findIndex((edit) => edit.id === id);
  const fresh = index === -1 || edits[index].hash !== hash;
  if (index !== -1) edits.splice(index, 1);
  edits.push({ id, hash });
  edits.splice(0, Math.max(0, edits.length - EDITS_KEPT));
  return fresh;
}

/** The command in force among these: the latest by WhatsApp's time, and a STOP over a START of the same second. Store
 * order cannot break the tie: wacli v0.25.1's journal shows a changed message again, with a later sequence. */
export function inForce(...commands: Array<Command | undefined>): Command | undefined {
  let found: Command | undefined;
  for (const command of commands) {
    if (!command) continue;
    const order = found ? command.at - found.at : 1;
    if (order > 0 || (order === 0 && command.verb === "stop")) found = command;
  }
  return found;
}

export function isPaused(commands: Commands, key: string): boolean {
  return inForce(commands.all, commands.groups[key])?.verb === "stop";
}

export type CommandOutcome =
  /** In force wherever it reaches, except in the groups whose own command came later and says otherwise. */
  | { applied: true; exceptions: Array<{ group: WhatsappGroup; command: Command }> }
  /** In force nowhere: `winner`, of the group `winnerKey` or of all groups, came later. */
  | { applied: false; winner: Command; winnerKey?: string };

/** Keeps `command` as the latest of its scope (the group `key`, or all groups) unless a later one is there, and says where it
 * is in force. A command for all groups overrides the older commands of single groups, and a group's own command
 * overrides an older one for all groups. */
export function applyCommand(commands: Commands, command: Command, key: string | undefined, groups: readonly WhatsappGroup[]): CommandOutcome {
  if (key === undefined) {
    if (inForce(commands.all, command) === command) commands.all = command;
    if (commands.all !== command) return { applied: false, winner: commands.all! };
    return {
      applied: true,
      exceptions: groups.flatMap((group) => {
        const own = inForce(command, commands.groups[group.key])!;
        return own !== command && own.verb !== command.verb ? [{ group, command: own }] : [];
      }),
    };
  }
  if (inForce(commands.groups[key], command) === command) commands.groups[key] = command;
  const winner = inForce(commands.all, commands.groups[key])!;
  if (winner === command) return { applied: true, exceptions: [] };
  return { applied: false, winner, ...(winner === commands.groups[key] ? { winnerKey: key } : {}) };
}

/** Whether the latest command for all groups is STOP, and which groups their own STOP pauses. */
export function stoppedSummary(commands: Commands, groups: readonly WhatsappGroup[]): { all: boolean; groups: string[] } {
  return {
    all: commands.all?.verb === "stop",
    groups: groups.filter((group) => {
      const own = commands.groups[group.key];
      return own?.verb === "stop" && inForce(commands.all, own) === own;
    }).map((group) => group.key),
  };
}

const VERB: Record<Verb, string> = { stop: "STOP", start: "START" };

const named = (command: Command, key: string | undefined, clock: (at: number) => string) =>
  `${VERB[command.verb]}${key ? ` ${key}` : ""} z ${clock(command.at)}`;

/** What the operator reads back: what the command did, or in one line why it changes nothing. */
export function commandReply(command: Command, group: WhatsappGroup | undefined, outcome: CommandOutcome, clock: (at: number) => string): string {
  if (!outcome.applied) return `Příkaz ${named(command, group?.key, clock)} nic nemění, platí ${named(outcome.winner, outcome.winnerKey, clock)}.`;
  const where = group ? `do skupiny ${group.name}` : "do všech skupin";
  const except = outcome.exceptions.map((exception) => `${exception.group.name} (platí ${named(exception.command, exception.group.key, clock)})`);
  const scope = `${where}${except.length ? ` kromě ${except.join(", ")}` : ""}`;
  return command.verb === "stop"
    ? `Odesílání ${scope} je pozastavené. Odpovědi bota vám chodí sem jako návrhy. Obnovíte ho zprávou START${group ? ` ${group.key}` : ""}.`
    : `Odesílání ${scope} je obnovené.`;
}
