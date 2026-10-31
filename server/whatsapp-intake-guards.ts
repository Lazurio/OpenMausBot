// Lazurio MausBot WhatsApp intake: the bot's output contract and the guards that
// turn a reply into a draft for the operator. All of it is plain code over the
// reply's text, the group map, the run's tool log and the files that log names;
// no model decides here. A guard that cannot tell (an unknown tool, an
// unreadable path, an engine that reports no tool calls) counts as a hit: the
// reply becomes a draft.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

import type { GroupMap, WhatsappGroup } from "./whatsapp-intake-config.ts";
import { previewIsPartial } from "./tool-summary.ts";

// ── the output contract ───────────────────────────────────────────────────

const outputSchema = z.object({
  action: z.enum(["none", "reply", "escalate", "reply_and_escalate"]),
  reply: z.string().nullable().optional().transform((value) => (value ?? "").trim()),
  reply_to: z.string().nullable().optional().transform((value) => (value ?? "").trim()),
  escalation: z.object({
    urgency: z.enum(["low", "normal", "high"]).catch("normal"),
    summary: z.string().catch(""),
    next_step: z.string().optional().catch(""),
  }).strict().nullable().optional(),
  // Anything but an explicit no is a commitment, and anything but high or medium is low confidence.
  commitment: z.unknown().optional().transform((value) => value !== false && value !== "false"),
  confidence: z.unknown().optional().transform((value) => {
    const level = typeof value === "string" ? value.trim().toLowerCase() : "";
    return level === "high" || level === "medium" ? level : "low";
  }),
  sources: z.array(z.string()).optional().catch([]),
  digest_line: z.string().optional().catch(""),
}).strict();

export type RunOutput = z.output<typeof outputSchema>;

/** The bot's JSON answer, from its final message (a code fence or text around it is tolerated); null when it is not
 * the contract. */
export function parseRunOutput(text: string | undefined): RunOutput | null {
  const trimmed = (text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = outputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const wantsReply = (output: RunOutput) => (output.action === "reply" || output.action === "reply_and_escalate") && output.reply !== "";
export const wantsEscalation = (output: RunOutput) => output.action === "escalate" || output.action === "reply_and_escalate";

// ── the guards ────────────────────────────────────────────────────────────

export const LIMITS = { perHour: 6, perDay: 30, overallPerDay: 80 } as const;
export const MAX_REPLY_CHARS = 1_200;

export interface ToolCall {
  name: string;
  /** The shell command, when the call ran one. */
  summary?: string;
  /** The engine's bounded, redacted preview of the call's input. */
  input?: string;
}

export interface RunCapture {
  /** The engine that ran the turn, as its runtime events name it. */
  provider?: string;
  tools: ToolCall[];
  text?: string;
}

export interface SentCounts {
  groupLastHour: number;
  groupLastDay: number;
  allLastDay: number;
}

export interface GuardInput {
  group: WhatsappGroup;
  map: GroupMap;
  reply: string;
  output: RunOutput;
  capture: RunCapture;
  bundle: string;
  botCwd?: string;
  sent: SentCounts;
  paused: boolean;
}

/** Why this reply must not be sent: empty means every guard passed. */
export function sendGuards(input: GuardInput): string[] {
  const reasons: string[] = [];
  if (input.paused) reasons.push("paused");
  if (input.output.confidence === "low") reasons.push("low_confidence");
  if (input.output.commitment) reasons.push("commitment");
  if (input.reply.length > MAX_REPLY_CHARS) reasons.push("too_long");
  reasons.push(...commercialKinds(input.reply).map((kind) => `commercial:${kind}`));
  if (mentionsOtherClient(input.reply, otherClientTerms(input.group, input.map))) reasons.push("other_client");
  if (foreignLinks(input.reply, input.map).length) reasons.push("link");
  reasons.push(...toolViolations(input.capture, input.bundle, input.botCwd));
  reasons.push(...rateViolations(input.sent));
  return [...new Set(reasons)];
}

/** Letters and digits only around a match, so "cena" is a price and "procent" is not. */
const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})`, "iu");

const COMMERCIAL: ReadonlyArray<readonly [string, RegExp]> = [
  ["price", word("cen[aáeěiíouůy]|ceník|kolik\\s+(?:to\\s+)?stoj|price|pricing|costs?(?![\\p{L}])|platb|zaplat|payment|předplatn|subscription|tarif")],
  ["price", /\d[\d\s.,]*\s?(?:kč|czk|eur|€|usd|\$)|(?:€|\$)\s?\d/iu],
  ["discount", word("slev|discount|zdarma|free of charge")],
  ["contract", word("smlouv|smluvn|contract|objednávk")],
  ["invoice", word("faktur|invoice|billing|vyúčtován")],
  ["deadline", word("termín|deadline|garant|guarantee|zaruč|slibuj|do\\s+(?:zítra|zítřka|pondělí|úterý|středy|čtvrtka|pátku|soboty|neděle|konce)|by\\s+(?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the end of)")],
  ["sla", word("sla(?![\\p{L}\\p{N}])|uptime|dostupnost\\w*\\s+\\d+(?:[.,]\\d+)?\\s*%")],
];

/** Price, discount, contract, invoice, deadline or SLA language: a coarse net that errs towards a draft. */
export function commercialKinds(text: string): string[] {
  const normalized = text.normalize("NFC");
  return [...new Set(COMMERCIAL.filter(([, pattern]) => pattern.test(normalized)).map(([kind]) => kind))];
}

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every other group's name, client names and owner logins, less those this group shares. */
export function otherClientTerms(group: WhatsappGroup, map: GroupMap): string[] {
  const own = new Set([group.name, ...group.clientNames, ...group.owners].map(fold));
  const others = map.groups.filter((other) => other.chat !== group.chat)
    .flatMap((other) => [other.name, ...other.clientNames, ...other.owners]).map(fold);
  return [...new Set(others)].filter((term) => term && !own.has(term));
}

export function mentionsOtherClient(text: string, terms: readonly string[]): boolean {
  const folded = fold(text);
  return terms.some((term) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "u").test(folded));
}

const REPOSITORY_HOSTS = new Set(["github.com", "www.github.com", "gist.github.com", "raw.githubusercontent.com", "codeload.github.com",
  "api.github.com", "gitlab.com", "www.gitlab.com", "bitbucket.org", "www.bitbucket.org"]);
const LINK = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>()"'`]*)?/giu;

function underPrefix(url: string, prefix: string): boolean {
  const base = prefix.toLowerCase().replace(/\/+$/, "");
  const candidate = url.toLowerCase();
  return candidate === base || ["/", "?", "#"].some((next) => candidate.startsWith(base + next));
}

/** Repository links and Environment links (a subdomain of an Environment domain) that no allowed prefix covers. */
export function foreignLinks(text: string, map: GroupMap): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    const guarded = REPOSITORY_HOSTS.has(host) || map.environmentDomains.some((domain) => host.endsWith(`.${domain}`));
    if (!guarded) continue;
    const normalized = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    const https = normalized.replace(/^http:/, "https:");
    if (!map.allowedLinks.some((prefix) => underPrefix(normalized, prefix) || underPrefix(https, prefix))) found.push(raw);
  }
  return found;
}

/** Engines whose drivers report every tool call of a turn to the server. */
export const TOOL_REPORTING_ENGINES = new Set(["claudeAgent", "codex"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const INERT_TOOLS = new Set(["TodoWrite"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "shell", "exec_command", "local_shell", "command_execution"]);
const MAX_BUNDLE_ENTRIES = 10_000;

function inside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The path a call names, on the folder it ran in, left for the file system to resolve: `..` after a link leaves the
 * link's target, not the folder the link is in. */
function joined(path: string, cwd: string | undefined): string | null {
  const expanded = path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  if (isAbsolute(expanded)) return expanded;
  return cwd ? `${cwd}${sep}${expanded}` : null;
}

function attempt<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

// realpath(3), which resolves a path as opening it does; Node's own realpathSync drops `..` before it follows a link.
const real = (path: string) => attempt(() => realpathSync.native(path));

/** The file or folder a read-only call names; null when the preview cannot tell. */
function readTarget(call: ToolCall, cwd: string | undefined): string | null {
  if (!call.input || previewIsPartial(call.input)) return null;
  let fields: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(call.input);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    fields = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const field = (key: string) => (typeof fields[key] === "string" ? fields[key] as string : undefined);
  const target = call.name === "Read" ? field("file_path") : call.name === "NotebookRead" ? field("notebook_path") : field("path");
  if (!target && (call.name === "Read" || call.name === "NotebookRead" || call.name === "LS")) return null;
  const pattern = call.name === "Glob" ? field("pattern") : undefined;
  if (pattern && (isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes(".."))) return null;
  return target ? joined(target, cwd) : cwd ?? null;
}

/** Every link in the folder leads back into it and no file in it has another hard link, so a search below any of its
 * folders, following links or not, finds only its own files. False when that cannot be told. */
function sealed(root: string): boolean {
  const folders = [root];
  let entries = 0;
  try {
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (++entries > MAX_BUNDLE_ENTRIES) return false;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) folders.push(path);
        else if (entry.isSymbolicLink()) {
          const target = real(path);
          if (target === null || !inside(target, root)) return false;
        } else if (entry.isFile() && lstatSync(path).nlink > 1) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

/** Where a read-only call read, by the real file or folder its path leads to within the bundle's real `root`. A search
 * below a folder may follow links, so a folder counts as inside only when the bundle is sealed; a file with another
 * hard link may be another client's. */
function readReach(call: ToolCall, cwd: string | undefined, root: string | null, rootSealed: () => boolean): "inside" | "outside" | "unverified" {
  const path = readTarget(call, cwd);
  const target = path === null ? null : real(path);
  if (target === null || root === null) return "unverified";
  if (!inside(target, root)) return "outside";
  const stat = attempt(() => statSync(target));
  if (stat?.isFile()) return stat.nlink > 1 ? "unverified" : "inside";
  return stat?.isDirectory() && rootSealed() ? "inside" : "unverified";
}

/** A shell, gh, wacli, a tool outside the read-only file tools, or a read outside the bundle. */
export function toolViolations(capture: RunCapture, bundle: string, cwd: string | undefined): string[] {
  if (!capture.provider || !TOOL_REPORTING_ENGINES.has(capture.provider)) return ["no_tool_log"];
  const found = new Set<string>();
  const root = real(bundle);
  let rootSealed: boolean | undefined;
  for (const call of capture.tools) {
    if (INERT_TOOLS.has(call.name)) continue;
    if (READ_TOOLS.has(call.name)) {
      const reach = readReach(call, cwd, root, () => (rootSealed ??= root !== null && sealed(root)));
      if (reach !== "inside") found.add(`tools:read_${reach}`);
      continue;
    }
    const command = call.summary ?? "";
    if (/(?<![\w-])gh(?![\w-])/.test(command)) found.add("tools:gh");
    else if (/(?<![\w-])wacli(?![\w-])/.test(command)) found.add("tools:wacli");
    else if (command || SHELL_TOOLS.has(call.name)) found.add("tools:shell");
    else found.add(`tools:${call.name.replace(/[^\w.:-]/g, "_").slice(0, 60)}`);
  }
  return [...found];
}

export function rateViolations(sent: SentCounts): string[] {
  return [
    ...(sent.groupLastHour >= LIMITS.perHour ? ["rate:hour"] : []),
    ...(sent.groupLastDay >= LIMITS.perDay ? ["rate:day"] : []),
    ...(sent.allLastDay >= LIMITS.overallPerDay ? ["rate:all"] : []),
  ];
}

/** The operator's words for a reason code, in the Environment's language (Czech, formal). */
export function reasonText(reason: string): string {
  const [code, detail] = reason.split(":", 2);
  switch (code) {
    case "paused": return "odesílání je pozastavené (STOP)";
    case "catch_up": return "dohledávání ztracených zpráv nefunguje";
    case "low_confidence": return "bot si není jistý";
    case "commitment": return "bot hlásí závazek";
    case "too_long": return "odpověď je příliš dlouhá";
    case "commercial": return `obchodní téma (${({ price: "cena", discount: "sleva", contract: "smlouva", invoice: "faktura", deadline: "termín", sla: "SLA" } as Record<string, string>)[detail ?? ""] ?? detail})`;
    case "other_client": return "zmiňuje jinou skupinu nebo klienta";
    case "link": return "odkaz na repozitář nebo Prostředí mimo povolené";
    case "no_tool_log": return "běh nejde ověřit (engine nehlásí nástroje)";
    case "tools": return detail === "read_outside" ? "běh četl mimo podklady" : detail === "read_unverified" ? "běh četl, kde nejde ověřit" : `běh použil ${detail}`;
    case "rate": return detail === "hour" ? "limit zpráv za hodinu" : detail === "day" ? "denní limit skupiny" : "denní limit všech skupin";
    case "draft_mode": return "skupina je v režimu návrhů";
    case "unasked": return "nikdo se bota neptal";
    case "send_failed": return "odeslání selhalo";
    default: return reason;
  }
}
