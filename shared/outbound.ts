// Outbound actions: calls that reach a person outside the app or move money.
// Below Full access they get their own confirmation, or spend an optional daily
// allowance per bot; at Full access they run. A read-and-draft routine run never
// reaches them: the relay refuses every send there. Shared by the harness (which
// enforces it) and the app.
import { isConnectedAppsServer } from "./own-apps.ts";

export type OutboundPolicy = {
  /** ask: every outbound call waits for a tap. allow: up to dailyCap a day. */
  policy: "ask" | "allow";
  dailyCap: number;
};

export const OUTBOUND_DEFAULT_CAP = 25;
const OUTBOUND_MAX_CAP = 1_000;

/** Tools whose action is one of these words send something somewhere. */
const SEND_VERBS = new Set([
  "SEND",
  "SENDS",
  "REPLY",
  "RESPOND",
  "FORWARD",
  "POST",
  "PUBLISH",
  "TWEET",
  "RETWEET",
  "BROADCAST",
  "INVITE",
  "SHARE",
  "REFUND",
  "CHARGE",
  "PAY",
  "PAYOUT",
  "TRANSFER",
]);

/** Creating one of these is sending it: a created comment is a comment
 * someone reads, a created invoice is one someone receives. */
const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM"]);

/** A read verb first means the rest of the name is what is being read:
 * REDDIT_GET_POST fetches a post, it does not post. */
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** Composio reads known by slug, since some put the noun first (GOOGLECALENDAR_EVENTS_LIST lists events). */
export const KNOWN_READ_SLUGS: ReadonlySet<string> = new Set([
  "GMAIL_FETCH_EMAILS",
  "GMAIL_GET_PROFILE",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_FIND_EVENT",
  "GOOGLECALENDAR_LIST_CALENDARS",
]);

/** The action part of a tool name, as upper-case word tokens. An app's
 * TOOLKIT_ACTION drops its toolkit; an MCP server's mcp__server__action
 * drops its server; a bare built-in like Bash stays as it is. */
function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, , ...rest] = name.split("__");
    action = rest.join("_");
  } else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
    action = name.slice(name.indexOf("_") + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Does the tool name describe a read-only action? This is deliberately
 * narrower than "not outbound": updates, deletes and other writes do not
 * become reads merely because they send nothing to another person. */
export function isReadOnlyTool(name: string): boolean {
  if (KNOWN_READ_SLUGS.has(name.replace(/^mcp__(?:composio|own_apps)__/, ""))) return true;
  const tokens = actionTokens(name);
  return tokens.length > 0 && READ_VERBS.has(tokens[0]);
}

/** The built-in agents server's X research tools only read X: x_post reads a post, it does not post one. */
const AGENTS_X_READS = /^(?:mcp__agents__|agents__|agents_)?x_(?:search|user_posts|post|profile)$/;

/** Does this tool send something to someone, or move money? */
export function isOutboundTool(name: string): boolean {
  if (AGENTS_X_READS.test(name)) return false;
  const tokens = actionTokens(name);
  if (tokens.length === 0) return false;
  if (isReadOnlyTool(name)) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  if (tokens.includes("DRAFT")) return false;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}
