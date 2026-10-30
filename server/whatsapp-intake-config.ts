// Lazurio MausBot WhatsApp intake: its settings (OMB_WHATSAPP_INTAKE*) and the
// group map, the operator's file that says which WhatsApp chats the intake
// handles and how. A chat that is not in the map is never handed to a bot.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export type GroupMode = "observe" | "draft" | "auto";
export type AddressForm = "vy" | "ty";

export interface WhatsappGroup {
  /** The group's chat id, `<digits>@g.us`. */
  chat: string;
  /** Short lowercase key the operator uses in `STOP <key>`. */
  key: string;
  name: string;
  /** observe: classify only, no model. draft: replies go to the operator. auto: replies to a mention or a reply to the account are sent. */
  mode: GroupMode;
  /** Absolute path of the client note, injected into this group's runs only. */
  note: string;
  address: AddressForm;
  /** The cross-client guard keeps these out of every other group's replies; no run is given them. */
  clientNames: string[];
  owners: string[];
}

export interface GroupMap {
  groups: WhatsappGroup[];
  /** Chat ids of the people who answer for the provider; their messages pause unasked runs. */
  team: string[];
  /** URL prefixes a reply may link to although they are repository or Environment links. */
  allowedLinks: string[];
  /** Domains whose subdomains are Environment links (`<app>.<machine>.<org>.<domain>`). */
  environmentDomains: string[];
}

export interface WhatsappIntakeConfig {
  /** Id or exact name (case-insensitive) of the bot that answers. */
  bot: string;
  groupsFile: string;
  /** The operator's direct chat with the account: commands in, drafts, escalations and the digest out. */
  operator: string;
  /** The folder the bot may read; any other tool use in a run turns its reply into a draft. */
  bundle: string;
  wacliPath?: string;
  store?: string;
  maxDbSize: string;
  /** More ids of the account than the phone number wacli reports, such as its LID digits, for mentions. */
  selfIds: string[];
}

export const GROUP_JID = /^\d{5,30}(?:-\d{1,20})?@g\.us$/;
export const USER_JID = /^\d{5,20}@(?:s\.whatsapp\.net|lid)$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const SIZE = /^\d+(?:\.\d+)?\s*(?:kib|kb|k|mib|mb|m|gib|gb|g|b)?$/i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const DEFAULT_ENVIRONMENT_DOMAINS = ["lazurio.io"];
export const MAX_NOTE_CHARS = 8_000;

const term = z.string().trim().min(2).max(80);
const groupSchema = z.object({
  key: z.string().regex(KEY, "a key is lowercase letters, digits and dashes"),
  name: term,
  mode: z.enum(["observe", "draft", "auto"]),
  note: z.string().min(1),
  address: z.enum(["vy", "ty"]).default("vy"),
  clientNames: z.array(term).max(50).default([]),
  owners: z.array(z.string().trim().toLowerCase().regex(GITHUB_LOGIN, "an owner is a GitHub login")).max(50).default([]),
}).strict();
const mapSchema = z.object({
  version: z.literal(1),
  team: z.array(z.string().regex(USER_JID, "a team member is a user chat id such as 15550000000@s.whatsapp.net")).max(50).default([]),
  allowedLinks: z.array(z.string().url().refine((url) => /^https?:\/\//i.test(url), "an allowed link is an http(s) URL")).max(200).default([]),
  environmentDomains: z.array(z.string().trim().toLowerCase().regex(DOMAIN)).max(20).default(DEFAULT_ENVIRONMENT_DOMAINS),
  groups: z.record(z.string(), groupSchema),
}).strict();

/** Reads and checks the group map; a note path stays inside the map's folder. Throws with the reason. */
export function loadGroupMap(file: string): GroupMap {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof SyntaxError ? "not valid JSON" : "cannot be read"}`);
  }
  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: ${issue?.path.join(".") || "the map"}: ${issue?.message ?? "invalid"}`);
  }
  const folder = dirname(file);
  const keys = new Set<string>();
  const names = new Set<string>();
  const groups: WhatsappGroup[] = Object.entries(parsed.data.groups).map(([chat, group]) => {
    if (!GROUP_JID.test(chat)) throw new Error(`${file}: "${chat}" is not a group: a group is a chat id ending in @g.us`);
    if (keys.has(group.key)) throw new Error(`${file}: two groups have the key "${group.key}"`);
    if (names.has(group.name.toLowerCase())) throw new Error(`${file}: two groups are named "${group.name}"`);
    keys.add(group.key);
    names.add(group.name.toLowerCase());
    const note = resolve(folder, group.note);
    const inside = relative(folder, note);
    if (isAbsolute(group.note) || !inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${file}: the note of "${group.key}" must be a file inside ${folder}`);
    }
    if (!statSync(note, { throwIfNoEntry: false })?.isFile()) throw new Error(`${file}: the note of "${group.key}" (${group.note}) does not exist`);
    return { chat, ...group, note };
  });
  return { groups, team: parsed.data.team, allowedLinks: parsed.data.allowedLinks, environmentDomains: parsed.data.environmentDomains };
}

export function readNote(path: string): string {
  return readFileSync(path, "utf8").trim().slice(0, MAX_NOTE_CHARS);
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function absolute(name: string, value: string | undefined): string {
  const path = (value ?? "").trim();
  if (!path) throw new Error(`OMB_WHATSAPP_INTAKE=1 needs ${name}`);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path, got "${path}"`);
  return path;
}

/** OMB_WHATSAPP_INTAKE and friends. Unset (or 0/false) keeps the intake off; a
 * value the server does not understand stops it at start with the reason. */
export function whatsappIntakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsappIntakeConfig | null {
  const flag = (env.OMB_WHATSAPP_INTAKE ?? "").trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false") return null;
  if (flag !== "1" && flag !== "true") throw new Error(`OMB_WHATSAPP_INTAKE must be 1 to enable the WhatsApp intake, got "${env.OMB_WHATSAPP_INTAKE}"`);
  const bot = (env.OMB_WHATSAPP_INTAKE_BOT ?? "").trim();
  if (!bot) throw new Error("OMB_WHATSAPP_INTAKE=1 needs OMB_WHATSAPP_INTAKE_BOT: the id or exact name of the bot that answers");
  const groupsFile = absolute("OMB_WHATSAPP_INTAKE_GROUPS", env.OMB_WHATSAPP_INTAKE_GROUPS);
  const operator = (env.OMB_WHATSAPP_INTAKE_OPERATOR ?? "").trim();
  if (!USER_JID.test(operator)) throw new Error(`OMB_WHATSAPP_INTAKE_OPERATOR must be the operator's user chat id, such as 15550000000@s.whatsapp.net, got "${operator}"`);
  const bundle = absolute("OMB_WHATSAPP_INTAKE_BUNDLE", env.OMB_WHATSAPP_INTAKE_BUNDLE);
  const store = (env.OMB_WHATSAPP_INTAKE_STORE ?? "").trim();
  if (store && !isAbsolute(store)) throw new Error(`OMB_WHATSAPP_INTAKE_STORE must be an absolute path, got "${store}"`);
  const maxDbSize = (env.OMB_WHATSAPP_INTAKE_MAX_DB_SIZE ?? "").trim() || "2GB";
  if (!SIZE.test(maxDbSize)) throw new Error(`OMB_WHATSAPP_INTAKE_MAX_DB_SIZE must be a size such as 500MB or 2GB, got "${maxDbSize}"`);
  const selfIds = list(env.OMB_WHATSAPP_INTAKE_SELF_IDS);
  const badSelf = selfIds.find((id) => !/^\d{5,20}$/.test(id) && !USER_JID.test(id));
  if (badSelf) throw new Error(`OMB_WHATSAPP_INTAKE_SELF_IDS: "${badSelf}" is not a number or a user chat id`);
  const wacliPath = (env.OMB_WHATSAPP_INTAKE_WACLI ?? "").trim();
  return {
    bot, groupsFile, operator, bundle, maxDbSize, selfIds,
    ...(wacliPath ? { wacliPath } : {}),
    ...(store ? { store } : {}),
  };
}

/** The user part of a chat id without its device: `15550000000:3@s.whatsapp.net` → `15550000000`. */
export function userOf(jid: string): string {
  return jid.split("@")[0]!.split(":")[0]!;
}

export const isGroupChat = (jid: string) => jid.endsWith("@g.us");
export const isUserChat = (jid: string) => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
