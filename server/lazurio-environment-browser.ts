// Lazurio overlay (DEV-6673, task 2026-10-05-510; root decision 0191 points 34 and 41–43): a bot
// works in the Environment browser as a T3 Code thread does.
//
// A Lazurio Environment has one browser: one Chromium with one persistent profile, DevTools on
// 127.0.0.1:9222, whose sign-ins every agent of the Environment shares. A bot has no browser,
// profile or computer of its own. It opens its own window there with the Platform's CLI
// (`lazurio browser window --session bot-<id>`) and works in it with Lazurio's agent-browser
// (`agent-browser --cdp 9222 --session bot-<id> …`), from its shell, like any other agent of the
// Environment (0191 point 4: the CLI, not an MCP server or a tool of MausBot's own).
//
// This module is the bot's strip: the server keeps `holders/bot-<id>.json`, the holder file the
// Platform's hub reads to keep the bot's tabs (LazurioPlatform F47 point 4, contract C5). A tab
// enters the strip when the bot's session binds it (agent-browser's `<session>.target`, which the
// Platform's `lazurio browser window` writes), as in T3 Code. Deleting or archiving the bot lets
// its tabs go: its holder file is removed and its session's daemon is stopped with
// `lazurio browser done`, so the hub ends a tab that nothing else holds and nobody watches (0191
// point 26). At start, the files and daemons of bots no longer live go too.
//
// Everything about the files comes from the Platform's contract module, vendored by digest from
// a release (lazurio/browser-contract/, F50 point 5). MausBot starts no browser, no daemon and no
// agent-browser configuration of its own: it sets neither AGENT_BROWSER_CONFIG,
// AGENT_BROWSER_SOCKET_DIR nor AGENT_BROWSER_NAMESPACE (C7), so the Platform's idle limit applies.
// Outside a Lazurio Environment, where `lazurio browser link --json` declares no browser, bots
// have no browser, and their instructions say so.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  agentBrowserSocketDirectory,
  changeHolderFile,
  holderDirectory,
  liveTabsPath,
  processAlive,
  readBootClock,
  readHolds,
  watchHolds,
} from "../lazurio/browser-contract/node.js";
import {
  type BootTime,
  browserBounds,
  browserCliExit,
  browserTimes,
  isStrip,
  parseBrowserCliAnswer,
  stripPrefixes,
} from "../lazurio/browser-contract/pure.js";

/** The Platform release whose contract module MausBot vendored (lazurio/browser-contract/provenance.json),
 * which every holder file it writes names (F50 point 3). */
export const BROWSER_CONTRACT_RELEASE = "0.1.9";

/** `bot-`, the prefix the Platform reserves for MausBot's strips and sessions (C2). */
export const BOT_SESSION_PREFIX = stripPrefixes.mausbot;
/** A strip's name is at most 64 characters of [A-Za-z0-9_-] (C2). */
const NAME_LIMIT = 64;
/** Hex digits of the id's SHA-256 that end a cut or rewritten name. */
const DIGEST_LENGTH = 32;
/** The most tabs one bot's strip holds: a hold past it is refused, never one dropped to make room. */
export const MAX_BOT_TABS = 128;
const LINK_CHECK_MS = 10_000;
const DONE_MS = 15_000;
/** How long a declaration of the Environment browser (or its absence) is believed. */
const DECLARATION_TTL_MS = 60_000;

/**
 * The agent-browser session of a bot, which is also the name of its strip: `bot-` and the bot's id.
 * An id with characters outside [A-Za-z0-9_-], or too long to fit, has them replaced by `-`, is
 * cut, and ends in 32 hex digits of the SHA-256 of the exact id, so two bots never share a
 * session, and with it a window (as T3 Code names a thread's).
 */
export function botBrowserSession(botId: string): string {
  const sanitized = botId.replace(/[^A-Za-z0-9_-]/g, "-");
  const name = `${BOT_SESSION_PREFIX}${sanitized}`;
  if (sanitized === botId && name.length <= NAME_LIMIT) return name;
  const digest = createHash("sha256").update(botId, "utf8").digest("hex").slice(0, DIGEST_LENGTH);
  return `${name.slice(0, NAME_LIMIT - DIGEST_LENGTH - 1)}-${digest}`;
}

/** What a bot's instructions say about the browser this turn. */
export function environmentBrowserPrompt(session: string, declared: boolean): string {
  if (!declared) {
    return "This Environment has no Environment browser, so you have no browser here. If a task needs a web page, say that"
      + " the Environment browser is unavailable; never start a browser of your own (Chrome, Chromium, Playwright, Puppeteer or"
      + " an agent-browser that launches its own browser).";
  }
  const port = browserBounds.devtoolsPort;
  return [
    `You work in the Environment browser, the one browser this Environment has, with its sign-ins, through your own session \`${session}\`.`,
    `Open your window with \`lazurio browser window --session ${session}\`: it prints the link a person opens to watch and work in the same tab with you, and the command to work in it.`,
    `Work in it with Lazurio's agent-browser from your shell, always with your session: \`agent-browser --cdp ${port} --session ${session} <command>\` (for example \`snapshot -i\`, \`click @e3\`, \`fill @e5 "text"\`, \`open https://example.com\`).`,
    `When your work in the browser is done, run \`lazurio browser done --session ${session}\`. Never close tabs with agent-browser (that closes them for everyone who holds or watches them), and never start a browser of your own (Chrome, Chromium, Playwright, Puppeteer or an agent-browser without --cdp ${port}).`,
}

export interface LazurioRun {
  code: number;
  stdout: string;
}

export interface StripBot {
  id: string;
  name: string;
  hidden?: boolean;
}

export interface StripChange {
  type: string;
  botId?: string;
}

export interface EnvironmentBrowserSeams {
  /** XDG_RUNTIME_DIR locates the holder files and agent-browser's sockets; HOME the Platform's CLI. */
  env: Readonly<Record<string, string | undefined>>;
  /** Every bot, archived ones (`hidden`) included. */
  bots: () => readonly StripBot[];
  /** The Store's changes, so an archived or deleted bot's tabs go at once. */
  onChange: (listener: (change: StripChange) => void) => () => void;
  /** Runs the Platform's `lazurio` CLI; by default `~/.local/bin/lazurio`. */
  runLazurio?: (args: readonly string[], timeoutMs: number) => Promise<LazurioRun>;
  /** The boot clock (C4); by default the Platform's reading of /proc, null off Linux. */
  now?: () => Promise<BootTime | null>;
  alive?: (pid: number) => boolean;
  /** How often the strips are reconciled without a change seen; the contract's beat by default. */
  everyMs?: number;
  log?: (line: string) => void;
}

export interface EnvironmentBrowser {
  declared(): Promise<boolean>;
  /** The tabs a bot's strip holds, in the order they were first recorded. */
  tabs(botId: string): Promise<string[]>;
  /** One reconciliation of every bot's strip; resolves once it is done. */
  sync(): Promise<void>;
  stop(): Promise<void>;
}

function defaultRunLazurio(env: Readonly<Record<string, string | undefined>>) {
  const binary = join(env.HOME || homedir(), ".local", "bin", "lazurio");
  return (args: readonly string[], timeoutMs: number) => new Promise<LazurioRun>((resolve) => {
    execFile(binary, [...args], { env: { ...env }, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
      const code = error == null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

/** Starts the bots' strips. Off (nothing read or written) where there is no runtime directory. */
export function startEnvironmentBrowser(seams: EnvironmentBrowserSeams): EnvironmentBrowser {
  const holders = holderDirectory(seams.env);
  const sockets = agentBrowserSocketDirectory(seams.env);
  const list = liveTabsPath(seams.env);
  const run = seams.runLazurio ?? defaultRunLazurio(seams.env);
  const now = seams.now ?? (() => readBootClock());
  const alive = seams.alive ?? processAlive;
  const log = seams.log ?? ((line: string) => console.warn(`environment browser: ${line}`));

  };

  /** What this process knows of each live bot's strip, and the tab each session was bound to at the last reading. */
  const held = new Map<string, string[]>();
  const lastBinding = new Map<string, string>();

  const fileOf = (bot: StripBot, directory: string) => ({
    directory,
    strip: botBrowserSession(bot.id),
    label: (bot.name.trim() || "Bot").slice(0, browserBounds.holderLabelLength),
    contract: BROWSER_CONTRACT_RELEASE,
    bound: Math.min(MAX_BOT_TABS, browserBounds.holderTabs),
    list,
  });

  const done = async (session: string) => {
    const answer = await run(["browser", "done", "--session", session, "--json"], DONE_MS).catch(() => null);
    const parsed = answer ? parseBrowserCliAnswer(answer.stdout) : null;
    const outcome = parsed !== null && "outcome" in parsed ? parsed.outcome : null;
    if (outcome !== "stopped" && outcome !== "none") {
      log(`lazurio browser done --session ${session} did not confirm (${outcome ?? `exit ${answer?.code ?? "none"}`})`);
    }
  };

  const reconcile = async (directory: string) => {
    const bots = seams.bots();
    const live = new Map(bots.filter((bot) => !bot.hidden).map((bot) => [botBrowserSession(bot.id), bot]));
    // The bots' sessions as agent-browser left them: bound to a tab, with or without a running daemon.
    const boundTo = new Map<string, string>();
    const running = new Set<string>();
      }
    }
    let files: string[] = [];
    try {
      files = (await readdir(directory)).filter((name) => name.startsWith(BOT_SESSION_PREFIX) && name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`${directory} cannot be listed`);
    }

    // The strip of a bot that is archived, deleted or unknown goes, and its session's daemon is stopped.
    const retired = new Set<string>();
    for (const name of files) {
      const session = name.slice(0, -".json".length);
      if (isStrip(session) && !live.has(session)) retired.add(session);
    }
    for (const session of running) if (!live.has(session)) retired.add(session);
    for (const session of retired) {
      await rm(join(directory, `${session}.json`), { force: true }).catch(() => log(`${session}.json could not be removed`));
      if (running.has(session)) await done(session);
      lastBinding.delete(session);
    }
    for (const id of held.keys()) if (!live.has(botBrowserSession(id))) held.delete(id);

    // Every live bot's strip: a tab its session newly bound is recorded, and the file is
    // reconciled with the hub's list of live tabs (changeHolderFile does both, and writes only a change).
    for (const [session, bot] of live) {
      const target = boundTo.get(session);
      if (!fresh && !files.includes(`${session}.json`) && !held.has(bot.id)) continue;
      if (result.kind === "refused") {
        continue;
      }
      if (result.tabs.length) held.set(bot.id, result.tabs.map((tab) => tab.id));
      else held.delete(bot.id);
    }
  };

  // One reconciliation at a time; a change seen during one asks for one more.
  let current: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const sync = (): Promise<void> => {
    if (holders === undefined) return Promise.resolve();
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
        } while (again && !stopped);
      } finally {
        current = null;
      }
    })();
    return current;
  };

  let joined: NodeJS.Timeout | null = null;
  const soon = () => {
    if (stopped || joined) return;
    joined = setTimeout(() => {
      joined = null;
      void sync();
    }, browserTimes.changesJoinMs);
  };

  const on = holders !== undefined;
  const unsubscribe = on ? seams.onChange((change) => {
    if (change.type === "bot" || change.type === "bot.deleted") soon();
  }) : () => {};
  const watch = on ? watchHolds([holders, sockets, list === undefined ? undefined : dirname(list)], soon) : null;
  const beat = on ? setInterval(() => {
    watch?.retry();
    void sync();
  }, seams.everyMs ?? browserTimes.holdsEveryMs) : null;
  beat?.unref();
  if (on) void sync();

  return {
    declared,
    async tabs(botId) {
      await current;
      return [...(held.get(botId) ?? [])];
    },
    sync,
    async stop() {
      stopped = true;
      unsubscribe();
      watch?.stop();
      if (beat) clearInterval(beat);
      if (joined) clearTimeout(joined);
      await current;
    },
  };
}