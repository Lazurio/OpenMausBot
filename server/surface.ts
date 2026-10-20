// Lazurio overlay: a bot works on this host through its shell and files, and on web pages in the Environment
// browser from its own agent-browser session. MausBot's own computers, its control of this host's screen and
// its own browser are removed, so a turn has no place to choose and no screen tools.
import type { Surface } from "../shared/wire.ts";
export type { Surface };

export const SURFACE_PROMPT =
  " No computer tools are mounted this turn. You cannot open desktop apps, click on or inspect this computer's screen through OpenMausBot. If asked for such screen work, explain this; do not claim to have opened or checked it.";
