import type { Surface } from "../shared/wire.ts";
import { canWorkOnCloud, type CloudEngine } from "../shared/cloud-computer.ts";
import { canUseMcpServer } from "../shared/tool-scope.ts";
import { placeRowText, type PlaceRow, type PlaceSource } from "../shared/place-view.ts";
import { PLAIN_WORDS } from "./local-computer-guidance.ts";
export type { Surface, PlaceSource };

/** The bot's "Works on" setting; undefined = Auto. */
export type Destination = Surface | "off" | undefined;

export type ComputerWant = "cloud" | "vm" | "local" | "off" | undefined;

export interface MountedSurfaces {
  computer: Surface | null;
}

export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "local":
      return "this computer";
    case "browser":
  }
}

/** This computer is the person's own: web work goes elsewhere first, and their first-use question is the harness's to ask. */
const WEB_WORK_ORDER = "For web work such as finding, booking or looking something up, use, in this order:";
const YOUR_COMPUTER_LAST =
  " Use their own browser or screen only when the task needs their own signed-in session and nothing else works. Before your first action on it in a request, OpenMausBot asks them once whether you may, at every approval level: do not ask in chat yourself, and if they say no, finish another way. " + PLAIN_WORDS;
const YOUR_COMPUTER_BESIDE_BROWSER =
  ` This computer is the person's own: their screen, their apps and the browsers they are signed in to. ${WEB_WORK_ORDER} your built-in browser, a cloud computer if select_computer offers one, a connected app.${YOUR_COMPUTER_LAST}`;
const YOUR_COMPUTER_ALONE =
  ` Everything you do on screen happens on this computer, which is the person's own: their screen, their apps and the browsers they are signed in to; there is no built-in browser of yours this turn. ${WEB_WORK_ORDER} web search and fetching pages, a cloud computer if select_computer offers one, a connected app.${YOUR_COMPUTER_LAST} If you need the user to sign in, tell them it is on this computer.`;

const RESTATE_SENTENCE =

const SURFACE_AUTHORITY =

const CLOUD_HOME_WORDING: ReadonlyArray<readonly [string, string]> = [
];

/** Built from what was actually mounted, never from the setting, so the model is only told about tools it can call. */
export function surfacePrompt(
  mounted: MountedSurfaces,
  opts: { pinned?: Surface | null; note?: string; canSelect?: boolean; cloudHome?: boolean; botOpened?: boolean } = {},
): string {
  const reportBack = opts.botOpened && !opts.canSelect;
  const computer = mounted.computer ? surfaceLabel(mounted.computer) : null;
  let text = "";
  if (mounted.computer === "local" && !opts.cloudHome) {
    text = mounted.browser
      ? ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and this computer (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → this computer tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the Browser tab or this computer.${YOUR_COMPUTER_BESIDE_BROWSER}`
      : YOUR_COMPUTER_ALONE;
  } else if (computer && mounted.browser) {
    text =
      ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and ${computer} (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → ${computer} tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the Browser tab or ${computer}.`;
  } else if (computer) {
    text =
      ` Everything you do on screen happens on ${computer}, web pages included, through its own browser; there is no separate built-in browser this turn. If you need the user to sign in, tell them it is on ${computer}.`;
  } else if (mounted.browser) {
    text =
      " Everything you do on screen happens in the built-in browser tab; there is no desktop, file or shell computer this turn. If you need the user to sign in, tell them it is in the Browser tab of the Screen panel.";
  }
  if (text) text += RESTATE_SENTENCE + (opts.canSelect
    ? SURFACE_AUTHORITY.replace(ASK_TO_SWITCH, "inspect connected choices with select_computer and select the requested available place; on a pending result end this turn so OpenMausBot can reconnect the correct tools and continue the original request")
    : reportBack ? SURFACE_AUTHORITY.replace(ASK_TO_SWITCH, REPORT_BACK) : SURFACE_AUTHORITY);
  else if (!opts.note && !opts.canSelect) {
    text = ` No computer or built-in browser tools are mounted this turn. You cannot open apps, click, or inspect a screen through OpenMausBot. If asked for screen work, ${reportBack ? REPORT_BACK : "explain this and ask the user to choose where this conversation works in the Screen panel"}; do not claim to have opened or checked it.`;
  }
  if (opts.cloudHome) for (const [desktop, cloudHome] of CLOUD_HOME_WORDING) text = text.replace(desktop, cloudHome);
  return text + (opts.note ?? "");
}
