// Lazurio overlay (DEV-6673 M3, M4a): a bot works on this host only: its own screen through the desktop
// app, and web pages in the Environment browser, from its own agent-browser session (the "Browser"
// part of its instructions, server/lazurio-environment-browser.ts). Per-bot computers (Local VM, cloud
// computer, VPS, team computers), the Works on setting, conversation place pins, the computer selection
// tool and MausBot's own browser are removed, so a turn has no place to choose.
import type { Surface } from "../shared/wire.ts";
export type { Surface };

export interface MountedSurfaces {
  computer: Surface | null;
}

export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "local":
      return "this computer";
    case "browser":
      return "the Environment browser";
  }
}

const RESTATE_SENTENCE =
  " Before your first action on a screen in a task, say in one short sentence where you are working, using that same name.";

const SURFACE_AUTHORITY =
  " For desktop tasks, use OpenMausBot's mounted computer tools first: inspect the target, perform the action, and verify its result before claiming success. Discover deferred tools by their server/name when needed. Do not substitute the provider's own desktop or another automation path for them. Web pages are not part of this: you work in them in the Environment browser, as your Browser instructions say. Ordinary code and file tasks may still use their normal tools. Announcing an action is not performing it. A request naming another place does not move these tools: this computer is the user's host. If the requested place differs from the mounted one, explain the mismatch; never act on a different computer.";

/** A Cloud home has no "this computer"; each pair rewrites one phrase of the wording above. */
const CLOUD_HOME_WORDING: ReadonlyArray<readonly [string, string]> = [
  ["this computer is the user's host", "the user's own computer cannot be reached from here"],
];

/** Built from what was actually mounted, so the model is only told about tools it can call. */
export function surfacePrompt(mounted: MountedSurfaces, opts: { note?: string; cloudHome?: boolean } = {}): string {
  const computer = mounted.computer ? surfaceLabel(mounted.computer) : null;
  let text = "";
  if (computer) {
    text = ` Desktop apps you use on screen are on ${computer}, through the computer server's tools. If you need the user to sign in to a desktop app, tell them it is on ${computer}.`
      + RESTATE_SENTENCE + SURFACE_AUTHORITY;
  } else if (!opts.note) {
    text = " No computer tools are mounted this turn. You cannot open desktop apps, click on or inspect this computer's screen through OpenMausBot. If asked for such screen work, explain this; do not claim to have opened or checked it.";
  }
  if (computer) text += " A completed model turn is not proof that the user's task succeeded.";
  if (opts.cloudHome) for (const [desktop, cloudHome] of CLOUD_HOME_WORDING) text = text.replace(desktop, cloudHome);
  return text + (opts.note ?? "");
}
