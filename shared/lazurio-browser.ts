// Lazurio overlay (DEV-6673; root decision 0191 points 13, 34 and 36–43): what the server and the
// web share about a bot's tabs in the Environment browser, which people see in MausBot's right
// panel, Prohlížeč, through the Platform's view.

/** A tab of a bot's strip: its DevTools target id and its view, `<view origin>/t/<id>`. */
export interface BotBrowserTab {
  tabId: string;
  view: string;
}

/** `GET /api/bots/<bot>/browser`: the bot's strip, or none where the Environment declares no browser. */
export type BotBrowserStrip =
  | { available: false }
  | {
      available: true;
      /** The origin of the Environment's view, `https://browser.<base>.lazurio.io`. */
      viewOrigin: string;
      /** In the order they were first recorded. */
      tabs: BotBrowserTab[];
      /** The tab the bot's session works in, when its strip holds it. */
      current: string | null;
    };

}

/**
 * Whether a sign-in at `url` is one with the person's Lazurio account. The Environment browser
 * never holds such a session (0191 point 36): the person signs in in their own browser. A page of
 * this Environment's own apps and Modules needs no sign-in there (point 37), so every sign-in a bot
 * asks for at lazurio.io is one of these.
 */
export function lazurioAccountSite(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return host === "lazurio.io" || host.endsWith(".lazurio.io");
}