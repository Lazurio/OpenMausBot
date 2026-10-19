import { type BootTime, type HolderReading, type LiveTabs, type RecordedTab } from "./pure.js";
/** `$XDG_RUNTIME_DIR/lazurio-browser/holders`, where the apps' servers write
 * their holds; undefined without an absolute runtime directory. */
export declare function holderDirectory(env: Readonly<Record<string, string | undefined>>): string | undefined;
/** `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json`: the hub's list of the
 * browser's live page targets, which every app's server reconciles its holds
 * with (F47 point 4). */
export declare function liveTabsPath(env: Readonly<Record<string, string | undefined>>): string | undefined;
/** Where agent-browser keeps its sockets and a session's tab binding,
 * resolved as agent-browser resolves it (`get_socket_dir` in its
 * `cli/src/connection.rs`): `AGENT_BROWSER_SOCKET_DIR`, else
 * `$XDG_RUNTIME_DIR/agent-browser`, else `$HOME/.agent-browser`, each only
 * when set and not empty; with `AGENT_BROWSER_NAMESPACE`, its
 * `namespaces/<namespace>/run`. Undefined where agent-browser would take a
 * relative directory, which only its own working directory resolves, and
 * without `HOME`, where it asks the user database. The Environment's agents
 * set none of these variables but its `XDG_RUNTIME_DIR` (F50 point 2). */
export declare function agentBrowserSocketDirectory(env: Readonly<Record<string, string | undefined>>): string | undefined;
/** Reads the boot clock: `/proc/sys/kernel/random/boot_id` and the first
 * number of `/proc/uptime` (CLOCK_BOOTTIME). Null where there is none: not
 * Linux, where no Environment browser runs. */
export declare function readBootClock(read?: (path: string) => Promise<string>): Promise<BootTime | null>;
/** Replaces one file of `lazurio-browser` atomically and owner-only (F47
 * point 4): a temporary file of mode 0600 renamed over it, so a reader sees
 * the old text or the new one, never a part. Its directory is made with mode
 * 0700 when missing. */
export declare function replaceOwnerFile(path: string, text: string): Promise<void>;
/** Writes the list (`liveTabsText`) atomically: a reader sees the old list
 * or the new one. */
export declare function writeLiveTabs(path: string, tabs: readonly string[], takenAt: BootTime): Promise<void>;
/** A file's text the way the holder files are read: `read`, `readFile` by
 * default, replaceable in tests. */
type Read = (path: string) => Promise<string>;
/** The hub's list of live tabs as an app reads it before it lets a hold go
 * (`parseLiveTabs`): null where there is none, it cannot be read, or it is
 * no list this module reads, which lets nothing go. */
export declare function readLiveTabs(path: string | undefined, read?: Read): Promise<LiveTabs | null>;
/** One strip's holder file as its app writes it (F47 point 4). */
export type HolderFile = Readonly<{
    /** `holders/` (`holderDirectory`), where the file `<strip>.json` is. */
    directory: string;
    strip: string;
    label: string;
    /** The Platform release whose contract module writes the file
     * (`contract`, F50 point 3). */
    contract: string;
    /** The most tabs the app holds in this strip, below what the hub reads of
     * a file (`browserBounds.holderTabs`): a hold past it is refused, never
     * one dropped to make room. */
    bound: number;
    /** The hub's list of live tabs (`liveTabsPath`), which the file is
     * reconciled with before every write; undefined where there is none. */
    list: string | undefined;
}>;
/** What a change of a holder file came to: written, or nothing to write
 * (`kept`), with the tabs the file holds and their record times, in the
 * order they were first recorded; or refused, nothing written: the file
 * cannot be read or is no holder file of the strip (`unreadable`), or a
 * hold would pass the strip's bound (`full`). */
export type HolderFileChange = Readonly<{
    kind: "written" | "kept";
    tabs: readonly RecordedTab[];
}> | Readonly<{
    kind: "refused";
    reason: "unreadable" | "full";
}>;
/** The write of one strip's holder file (decision F50 point 1), one for
 * every app. The file is read first: only one that does not exist holds
 * nothing, and one that cannot be read, or is no holder file of this strip,
 * is never written over, since that would drop the holds it keeps (F47
 * point 5's rule for the hub, kept by its writers too). The holds are then
 * reconciled with the hub's list (`keptTabs`, at the boot time `now`), the
 * tabs of `release` let go, and those of `hold` recorded at `now`, a tab
 * held already with its new time. A hold past the strip's bound is refused.
 * The file is replaced atomically and owner-only only when its text
 * changes, and removed when it holds nothing. `now` is the boot clock read
 * by the caller (`readBootClock`); null off Linux, where nothing is let go
 * by a list. Ids that are no target id are ignored. */
export declare function changeHolderFile(file: HolderFile, change: Readonly<{
    hold?: readonly string[] | undefined;
    release?: readonly string[] | undefined;
}>, now: BootTime | null, read?: Read): Promise<HolderFileChange>;
export type Hold = Readonly<{
    strip: string;
    label: string;
}>;
export type Holds = Readonly<{
    /** The strips that hold each target. */
    holders: ReadonlyMap<string, readonly Hold[]>;
    /** The sessions whose agent works in each target: bound, daemon running. */
    working: ReadonlyMap<string, readonly string[]>;
    /** Every session bound to each target, its daemon running or not: who
     * opened an agent's window. */
    bound: ReadonlyMap<string, readonly string[]>;
}>;
export declare const noHolds: Holds;
/** What the files said at their last reading, by file name (root decision
 * 0191 point 32, which changes F47 point 5): a holder file that cannot be
 * read keeps holding what it held then, and only that, and a binding that
 * cannot be read keeps its tab. A file never read holds nothing. */
export type HoldsMemory = Readonly<{
    holders: ReadonlyMap<string, HolderReading>;
    /** Each session's target id, by its binding's file name. */
    bindings: ReadonlyMap<string, string>;
}>;
export declare const noHoldsMemory: HoldsMemory;
/** One reading of both directories: the holds, what the next reading
 * remembers, and the files this one could not read. */
export type HoldsReading = Readonly<{
    holds: Holds;
    memory: HoldsMemory;
    /** Holder files (`<strip>.json`) and bindings (`<session>.target`). */
    unreadable: readonly string[];
    /** Every holder file and binding there was at this reading, read or not:
     * one missing here is gone. */
    present: readonly string[];
}>;
/** True while a process with this id runs (one of another user counts too,
 * as `kill -0` answers EPERM for it). */
export declare function processAlive(pid: number): boolean;
/** Reads both directories (F47 point 5 as root decision 0191 point 32
 * changes it). Only a directory or file that does not exist reads as holding
 * nothing. A directory that cannot be listed is thrown, so the hub keeps its
 * last reading and no tab ends. A file that cannot be read (a permission, an
 * I/O error) or is not a holder file stops the ending of its own tabs only:
 * it keeps holding what it held at its last reading in `memory`, the other
 * files count as they read now, and it is named in `unreadable`. A holder
 * file is replaced atomically by its app, so a broken one is a fault to see,
 * not a release. Names that are no strip's file (an app's temporary file)
 * are skipped. An agent-browser session counts as ended only when its `.pid`
 * is gone or names a well-formed process id that no longer runs; one that
 * cannot be read or understood (empty, signed, zero) counts as working,
 * which keeps its tab. */
export declare function readHolds(directories: Readonly<{
    holders?: string | undefined;
    sockets?: string | undefined;
}>, alive?: (pid: number) => boolean, memory?: HoldsMemory): Promise<HoldsReading>;
/** The hub's reading of the holds: one reading at a time, each remembering
 * what the files it could read held, so a file that cannot be read keeps
 * holding what it held (root decision 0191 point 32). It logs when a file
 * becomes unreadable, and then whether it can be read again or is gone,
 * which lets go of what it held. A directory that cannot be listed is
 * thrown, as `readHolds` does. */
export declare function holdsReader(directories: Readonly<{
    holders?: string | undefined;
    sockets?: string | undefined;
}>, options?: Readonly<{
    alive?: (pid: number) => boolean;
    log?: (line: string) => void;
}>): () => Promise<Holds>;
/** The holder files that cannot be read or are not holder files, for
 * `lazurio doctor` (root decision 0191 point 32): their names, or the
 * directory itself when it cannot be listed. Empty without the directory. */
export declare function unreadableHolderFiles(env: Readonly<Record<string, string | undefined>>): Promise<string[]>;
/** Calls `changed` whenever something in one of the directories changes.
 * A directory that does not exist yet is watched once it does: `retry` is
 * called by the hub on its periodic read. */
export declare function watchHolds(directories: readonly (string | undefined)[], changed: () => void): Readonly<{
    retry: () => void;
    stop: () => void;
}>;
/** What a session's daemon answered on its socket: nothing listens there
 * (`absent`), a reply line, or no reply in time. */
export type DaemonAnswer = Readonly<{
    kind: "absent";
}> | Readonly<{
    kind: "reply";
    line: string;
}> | Readonly<{
    kind: "no-answer";
}>;
/** What letting go of a window needs of the host: overridable in tests. */
export type DaemonSeams = Readonly<{
    /** Sends one command line to a socket and answers the reply line. */
    ask?: (socketPath: string, line: string) => Promise<DaemonAnswer>;
    /** Whether a file is still there, polled while the daemon exits. */
    exists?: (path: string) => Promise<boolean>;
    /** How long to wait for the daemon to exit after it acknowledged. */
    exitWithinMs?: number;
}>;
/** One command line to a Unix socket and its reply line. Nothing listening
 * (no socket, a stale one) is `absent`; no reply within 5 s, or a socket
 * that cannot be reached for any other reason, is `no-answer`. */
export declare function askDaemonSocket(socketPath: string, line: string): Promise<DaemonAnswer>;
/** Lets go of a session's window (root decision 0191 point 28): asks the
 * session's own agent-browser daemon, on that session's socket
 * (`<socket dir>/<session>.sock`), to shut down, then waits up to 5 s for
 * its `.pid` to go. The daemon of an attached browser disconnects without
 * closing a tab, so the hub no longer counts the agent as working in it
 * (F47 point 5): the tab ends once nothing holds it and nobody views it.
 * Nothing is signalled by a process id, so a stale `.pid` whose number
 * another process now has, even another session's daemon, is never touched
 * (Pablo's review of #348). Never `agent-browser close` or `tab close`: the
 * tab would close for everyone who holds or views it, and the CLI starts a
 * daemon first when none runs. `stopped`: the daemon answered and its
 * `.pid` is gone; `none`: nothing listens on the session's socket;
 * `refused`: the daemon answered that it did not shut down, so nothing
 * changed; `unconfirmed`: no answer, a socket or `.pid` that cannot be
 * reached, or an answer but the `.pid` still there after the wait, so the
 * daemon may still hold the window. */
export declare function stopSessionDaemon(socketDirectory: string, session: string, seams?: DaemonSeams): Promise<"stopped" | "none" | "refused" | "unconfirmed">;
export {};
