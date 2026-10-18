// Lazurio overlay (DEV-6673 M3): a bot works on this host only (its own screen
// through the desktop app, and the built-in browser). Per-bot computers (Local
// VM, cloud computer, VPS, team computers), the Works on setting, conversation
// place pins and the computer selection tool are removed, so a turn has no place to choose.
import type { Surface } from "../shared/wire.ts";
export type { Surface };

export interface MountedSurfaces {
  computer: Surface | null;
  browser: boolean;
}

export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "local":
      return "this computer";
    case "browser":
      return "the built-in browser";
  }
}

const RESTATE_SENTENCE =
  " Before your first action on a screen or page in a task, say in one short sentence where you are working, using that same name.";

const SURFACE_AUTHORITY =
  " For browser and computer tasks, use OpenMausBot's mounted browser/computer tools first: inspect the target, perform the action, and verify its result before claiming success. Discover deferred tools by their server/name when needed. Do not substitute the provider's own desktop, a shell-launched browser, or another automation path for the selected OpenMausBot surface. Ordinary code and file tasks may still use their normal tools. Announcing an action is not performing it. A request naming another place does not move these tools: this computer is the user's host and the built-in browser is a separate browser. If the requested place differs from the mounted one, explain the mismatch; never act on a different computer.";

/** A Cloud home has no "this computer"; each pair rewrites one phrase of the wording above. */
const CLOUD_HOME_WORDING: ReadonlyArray<readonly [string, string]> = [
  ["this computer is the user's host and the built-in browser is a separate browser",
    "the built-in browser is a separate browser, and the user's own computer cannot be reached from here"],
];

/** Built from what was actually mounted, so the model is only told about tools it can call. */
export function surfacePrompt(mounted: MountedSurfaces, opts: { note?: string; cloudHome?: boolean } = {}): string {
  const computer = mounted.computer ? surfaceLabel(mounted.computer) : null;
  let text = "";
  if (computer && mounted.browser) {
    text =
      ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and ${computer} (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → ${computer} tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the Browser tab or ${computer}.`;
  } else if (computer) {
    text =
      ` Everything you do on screen happens on ${computer}, web pages included, through its own browser; there is no separate built-in browser this turn. If you need the user to sign in, tell them it is on ${computer}.`;
  } else if (mounted.browser) {
    text =
      " Everything you do on screen happens in the built-in browser tab; there is no desktop screen this turn. If you need the user to sign in, tell them it is in the Browser tab of the Computer panel.";
  }
  if (text) text += RESTATE_SENTENCE + SURFACE_AUTHORITY;
  else if (!opts.note) {
    text = " No computer or built-in browser tools are mounted this turn. You cannot open apps, click, or inspect a screen through OpenMausBot. If asked for screen work, explain this; do not claim to have opened or checked it.";
  }
  if (computer || mounted.browser) text += " For online research, use the selected OpenMausBot browser when a search service is unavailable. A failed tool proves only that this attempt failed, not that every browser is unavailable. Inspect the current page after navigation; report a sign-in page, redirect or error as such. A completed model turn is not proof that the user's task succeeded.";
  if (opts.cloudHome) for (const [desktop, cloudHome] of CLOUD_HOME_WORDING) text = text.replace(desktop, cloudHome);
  return text + (opts.note ?? "");
}
