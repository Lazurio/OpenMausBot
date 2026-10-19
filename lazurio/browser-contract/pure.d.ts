/** A remote tab's id (F39 point 1): a DevTools target id, 32 hexadecimal
 * digits. Chrome and the Platform write it in upper case; a reader takes it
 * in either case and keeps its upper-case form (`targetIdOf`). */
export declare function isTargetId(value: unknown): value is string;
/** A remote tab's id in upper case, as Chrome writes it; null for anything
 * that is no target id. */
export declare function targetIdOf(value: unknown): string | null;
/** A strip's name (F47 point 4), which is also its holder file's name
 * without `.json` and an agent-browser session's name: `[A-Za-z0-9_-]`, at
 * most 64 characters. It is Lazurio's deliberate subset of the names
 * agent-browser accepts, which may be longer and hold other characters (F50
 * point 2): the hub counts no binding of a session outside it. */
export declare function isStrip(value: unknown): value is string;
/** The Launchpad's one strip (F47 point 4). */
export declare const launchpadStrip = "launchpad";
/** The prefix of every other app's strips and sessions (F50 point 2): a T3
 * Code thread's `t3-<thread>`, a Codex thread's `codex-<CODEX_THREAD_ID>`, a
 * Claude Code session's `claude-<CLAUDE_CODE_SESSION_ID>`, and `bot-`,
 * reserved for Lazurio MausBot's bots. The overview and the strips name an
 * app by them, and an app writes and removes only the holder files of its
 * own prefix; the Launchpad only `launchpad.json`. */
export declare const stripPrefixes: Readonly<{
    t3code: "t3-";
    codex: "codex-";
    claude: "claude-";
    mausbot: "bot-";
}>;
/** An app that names strips or agent-browser sessions. */
export type StripApp = "launchpad" | keyof typeof stripPrefixes;
/** The app a strip's or a session's name belongs to; null for a name of no
 * app (a session named by hand) and for anything that is no strip's name. */
export declare function stripAppOf(name: unknown): StripApp | null;
/** The agent-browser session of the calling thread: the name given on
 * purpose, used as given or refused; otherwise the one its harness gives it,
 * every character outside the alphabet a `-` and cut at 64. T3 Code sets
 * `AGENT_BROWSER_SESSION` per thread; Codex exports `CODEX_THREAD_ID` and
 * Claude Code `CLAUDE_CODE_SESSION_ID` to the commands of a thread. Null
 * when there is none. */
export declare function threadSession(named: string | undefined, env: Readonly<Record<string, string | undefined>>): string | null;
/** An Environment id: one lowercase DNS label (a personal Remote
 * Environment's slug, a workstation's `local`) or two (`<machine>.<org>`). */
export declare function isEnvironmentId(value: unknown): value is string;
/** The id of a hosted Environment from an app origin of its own
 * (`https://<app>.<base>.lazurio.io`, with or without the trailing slash of
 * an Apps address): `<base>` in lowercase, one label for a personal Remote
 * Environment, two for an Organization's. Null for anything else: another
 * scheme, a port, credentials, a path, a query or a fragment, another
 * domain, or a base of another depth. The one place the id is derived. */
export declare function environmentIdOf(origin: string): string | null;
/** The path of one remote tab's view, `/t/<id>`, or of a new tab, `/` (F39
 * point 1), the id written as given: Chrome's, in upper case. */
export declare function viewPath(targetId: string | null): string;
/** The view of one remote tab, `<origin>/t/<id>`, or of a new one,
 * `<origin>/` (F39 point 1): `viewPath` on the view's origin. Neither carries
 * a token: the gateway's session is the only admission (F39 point 8). */
export declare function browserViewUrl(origin: string, targetId: string | null): string;
/** The remote tab a path of the view shows, `/t/<id>`: the id in either case,
 * given in its upper-case form (`targetIdOf`); null for any other path. */
export declare function viewPathTab(path: string): string | null;
/** A view address as `viewAddressOf` reads it. */
export type ViewAddress = Readonly<{
    /** The address as the contract writes it (`browserViewUrl`): a tab's id in
     * upper case, the bare origin with its `/`. */
    view: string;
    /** The view's origin, `https://browser.<base>.lazurio.io`. */
    origin: string;
    /** The Environment whose view it is, `<base>` (`environmentIdOf`). */
    environment: string;
    /** The remote tab it shows; null for the bare origin, which opens a new
     * one. */
    tab: string | null;
}>;
/** The view address `value` is (F50 point 2):
 * `https://browser.<base>.lazurio.io/t/<id>`, one remote tab, or the bare
 * origin, with or without its `/`, which opens a new one. `<base>` is an id
 * `environmentIdOf` gives and the id a target id in either case
 * (`targetIdOf`); the rest exactly as written: the host in lower case, no
 * port, no credentials, no query or fragment (not even an empty one) and no
 * slash after the id. A link is a tab only in this form, on every Lazurio
 * surface alike. Null for anything else. */
export declare function viewAddressOf(value: unknown): ViewAddress | null;
/** Whether a host is where the gateway routes the views of Environment
 * browsers: `browser.` and a name in `lazurio.io`, an Environment's or not,
 * also written in its absolute form with the DNS root's trailing dot, which
 * names the same host. No Lazurio surface loads an address on such a host in
 * the Environment browser (F50 point 2): a view address opens as its tab, a
 * new tab or another Environment's, and any other address there is refused.
 * The browser itself stays unrestricted. */
export declare function isViewHost(hostname: string): boolean;
/** A time on the Environment's boot clock (F47 point 4): the boot's id and
 * the seconds since it. Unlike the wall clock it never steps back, and every
 * process of the Environment reads the same one, so it orders an app's record
 * against the hub's snapshot. */
export type BootTime = Readonly<{
    boot: string;
    at: number;
}>;
/** A boot-clock time as it is stored, or null when the value is not one. */
export declare function parseBootTime(value: unknown): BootTime | null;
/** The `schema` of every holder file this module writes (F50 point 3). A
 * file without one is v1, written before the module; a file of another major
 * is one this module cannot read. */
export declare const holderSchema = "lazurio.browser-holder.v1";
/** What one holder file holds. */
export type HolderReading = Readonly<{
    strip: string;
    label: string;
    tabs: readonly string[];
}>;
/** A stored tab of an app with the boot-clock time it recorded the tab, or
 * null for a tab without one, which counts as recorded long ago (F47 point
 * 4). */
export type RecordedTab = Readonly<{
    id: string;
    recordedAt: BootTime | null;
}>;
/** The hold one holder file records, or null when the file is not one this
 * module can read: its name is `<strip>.json`, its `strip` that strip and
 * its `schema` absent or `holderSchema`, and only target ids count, in upper
 * case and once each, at most 500. The label is trimmed and cut at 200
 * characters; a file of more than 64 Ki characters is none. Members it does
 * not know are ignored, the writer's `contract` and `recordedAt` too. */
export declare function parseHolder(fileName: string, text: string): HolderReading | null;
/** The text of a holder file (F47 point 4, F50 point 3): its `schema`, the
 * Platform release this module came from (`contract`, which doctor reads and
 * the hub ignores), the strip, its label, its tabs, and each tab's record
 * time, `recordedAt`, by its id. The hub ignores the times too: only the app
 * that writes the file reads them back (`parseHolderRecords`), so its
 * reconciliation survives a restart. A tab without a time has no entry. */
export declare function holderFileText(strip: string, label: string, tabs: readonly RecordedTab[], contract: string): string;
/** A holder file with the record time of each of its tabs, or null when the
 * file is not a holder file (`parseHolder`'s rules). A tab whose time is
 * missing or not a boot-clock time has null. */
export declare function parseHolderRecords(fileName: string, text: string): Readonly<{
    strip: string;
    label: string;
    tabs: readonly RecordedTab[];
}> | null;
/** The `schema` of the hub's list of live tabs (F50 point 3); a list without
 * one is v1, and one of another major is no list. */
export declare const liveTabsSchema = "lazurio.browser-tabs.v1";
/** One snapshot of the browser's page targets: `takenAt` is the boot-clock
 * time the hub began it, before it asked the browser. */
export type LiveTabs = Readonly<{
    tabs: readonly string[];
    takenAt: BootTime;
}>;
/** The text of `tabs.json`, the hub's list that every app reconciles its
 * holds with (F47 point 4). */
export declare function liveTabsText(tabs: readonly string[], takenAt: BootTime): string;
/** The list a reader finds, its ids in upper case, or null when the file is
 * not one: every id a target id, the time a boot-clock time and the `schema`
 * absent or `liveTabsSchema`. Members it does not know are ignored. */
export declare function parseLiveTabs(text: string): LiveTabs | null;
/** An app's reconciliation (F47 point 4): the ids it keeps from its stored
 * ones, `boot` being the current boot. A list of another boot is ignored.
 * An id the list lacks goes when the list was taken after the app recorded
 * it: a snapshot lists every target that exists when it begins, so such an
 * id had ended by then, while a tab recorded after the snapshot began stays.
 * A record from an earlier boot, or without a time, is older than every list
 * of this boot. Without a list, or without the boot clock, it keeps
 * everything. */
export declare function keptTabs(stored: readonly RecordedTab[], list: LiveTabs | null, boot: string | null): string[];
/** The `type` of every message between a view and the app around it (F39
 * point 4, F47 point 4, F39's addendum of 2026-10-12), each posted with
 * `postMessage` to exactly the other side's origin. */
export declare const browserMessage: Readonly<{
    /** View → app: where its tab is, `{view, url, title}`. */
    info: "lazurio-browser:info";
    /** View → app: its page opened a new tab, `{view, url}`. */
    newTab: "lazurio-browser:new-tab";
    /** View → app: its tab ended, `{view}`. */
    closed: "lazurio-browser:closed";
    /** View → app: how does your shell name my Environment? */
    identityRequest: "lazurio-browser:identity-request";
    /** App → view: `{identity}`, and the majors its own parser reads
     * (`majors`). */
    identity: "lazurio-browser:identity";
}>;
/** The majors of the messages this module writes and reads (F50 point 3).
 * A message carries its major as `v`; one without is v1, for good. */
export declare const messageMajors: readonly number[];
/** The majors an app's identity answer names (`majors`): whole numbers from
 * 1, at most 16, none twice; null where it names none, which every app
 * deployed before this member does, or names them in another form. */
export declare function parseMessageMajors(value: unknown): readonly number[] | null;
/** The major a view sends its messages in (F50 point 3): the highest that
 * both it and the app around it read. To an app whose identity answer named
 * no majors (every app deployed before them) or that has not answered, v1:
 * a receiver deployed today never gets a message it would read as another v1
 * action. Null for an app that names majors but none of these: it could read
 * no message, so none is sent. */
export declare function messageMajor(majors: readonly number[] | null): number | null;
/** `lazurio-browser:info` (C8): where the view's tab is, the tab named by
 * its view address in the contract's form (`browserViewUrl`). */
export declare function viewInfoMessage(view: string, url: string, title: string): Readonly<{
    type: "lazurio-browser:info";
    v: 1;
    view: string;
    url: string;
    title: string;
}>;
/** `lazurio-browser:new-tab` (C8): the view's page opened the tab of `view`
 * as a new tab, at `url`. */
export declare function viewNewTabMessage(view: string, url: string): Readonly<{
    type: "lazurio-browser:new-tab";
    v: 1;
    view: string;
    url: string;
}>;
/** `lazurio-browser:closed` (C8): the tab of `view` ended. */
export declare function viewClosedMessage(view: string): Readonly<{
    type: "lazurio-browser:closed";
    v: 1;
    view: string;
}>;
/** `lazurio-browser:identity-request` (C9): the view asks the app around it
 * how its shell names the view's Environment. */
export declare function identityRequestMessage(): Readonly<{
    type: "lazurio-browser:identity-request";
    v: 1;
}>;
/** `lazurio-browser:identity` (C9): the app's answer. `identity` is the
 * shell's document of that Environment (or null where the app does not know
 * it), which the shell reads; `majors` are the majors the app's own message
 * parser reads, only where the app named them (F50 point 3): the answer never
 * names majors by itself. */
export declare function identityReplyMessage(identity: unknown, majors?: readonly number[] | null): Readonly<{
    majors?: readonly number[];
    type: "lazurio-browser:identity";
    v: number;
    identity: unknown;
}>;
/** A view's message as an app takes it (C8). */
export type ViewMessage = 
/** The view's page opened a new tab. */
Readonly<{
    kind: "new-tab";
    tab: string;
    url: string;
}>
/** The view's tab ended. */
 | Readonly<{
    kind: "closed";
    tab: string;
}>
/** Where the view's tab is now. */
 | Readonly<{
    kind: "info";
    tab: string;
    title: string;
    url: string;
}>;
/** A message of a view as the app around it takes it (F50 point 2): only
 * from that frame's window (`fromFrame`) on the view's own origin, of a major
 * this module reads, about a tab it names by a view address of that origin
 * in the contract's form (`viewAddressOf`), with the members its kind needs.
 * Texts are cut for display at `browserBounds.titleLength` and
 * `addressLength` characters. Null for anything else. */
export declare function acceptViewMessage(event: Readonly<{
    data: unknown;
    origin: string;
    fromFrame: boolean;
}>, viewOrigin: string | null): ViewMessage | null;
/** The Environment of a view's origin: the base host of
 * `https://browser.<base>.lazurio.io`, the bare origin of a view address
 * (`viewAddressOf`); null for any other origin. */
export declare function viewEnvironmentId(origin: string): string | null;
/** The app's side of the identity (C9): the Environment a request asks
 * about, or null. A request counts only from a frame of the app's own page
 * (`fromFrame`) on a view's origin, of a major this module reads, and it
 * asks about that origin's Environment, never another. */
export declare function identityRequestOf(event: Readonly<{
    data: unknown;
    origin: string;
    fromFrame: boolean;
}>): string | null;
/** The view's side of the identity (C9): its parent's answer, or null. It
 * counts only from the parent window (`fromParent`), on the parent's origin
 * as the browser names it (`location.ancestorOrigins`, `ancestor`) or, where
 * it names none, on an app origin of an Environment
 * (`https://<app>.<base>.lazurio.io`, the only pages a view's
 * `frame-ancestors` admits), and only of a major this module reads. It gives
 * the identity as the app sent it, which the shell reads, and the majors the
 * app named (`parseMessageMajors`). */
export declare function acceptIdentityReply(event: Readonly<{
    data: unknown;
    origin: string;
    fromParent: boolean;
}>, ancestor: string | null): Readonly<{
    identity: unknown;
    majors: readonly number[] | null;
}> | null;
/** The event `<lazurio-new-tab>` dispatches (F47 point 2): `detail` is what
 * the tab became (`NewTabChoice`). */
export declare const newTabEventName = "lazurio-new-tab";
/** One of the app's own surfaces, drawn under the address bar in this
 * order: a button with its label, the letter that opens it while nobody
 * types (`key`), and an icon by name (`icon`, interface v1). Its `id` is one
 * of the registry's where the surface is one of them (`newTabToolIcons`). */
export type NewTabTool = Readonly<{
    id: string;
    label: string;
    key?: string;
    icon?: string;
}>;
/** What Nová karta became (F47 point 2): a remote tab an address opened
 * (`page`), a tab chosen in Přehled (`tab`), each with its view
 * (`https://browser.<…>/t/<id>`, F39 point 1), or one of the app's tools. */
export type NewTabChoice = Readonly<{
    kind: "page";
    tab: string;
    view: string;
}> | Readonly<{
    kind: "tab";
    tab: string;
    view: string;
}> | Readonly<{
    kind: "tool";
    id: string;
}>;
/** At most this many tools: T3 Code has six. */
export declare const maxNewTabTools = 12;
/** The app's tools (the element's `tools`), or null when `value` is not a
 * list of them: at most `maxNewTabTools`, each with an id and a label, an
 * optional letter and an optional icon name, no id or letter twice. */
export declare function parseNewTabTools(value: unknown): readonly NewTabTool[] | null;
/** The view of the remote tab `tab` (upper case) when `value` is one, a view
 * address of the contract (`viewAddressOf`, decision F50 point 2):
 * `https://browser.<base>.lazurio.io/t/<tab>`, as the contract writes it.
 * Null otherwise. */
export declare function newTabViewOf(value: unknown, tab: string): string | null;
/** A choice of these three kinds and their exact members, or null: a tab's
 * id in upper case, as the hub writes it, with that tab's view; a tool by an
 * id of the tools' grammar. */
export declare function parseNewTabChoice(value: unknown): NewTabChoice | null;
/** The tools' registry (F50 point 2): the ids an app maps its own surfaces
 * to, each with its icon in Nová karta's set. An app chooses the id by the
 * surface, never by its label. */
export declare const newTabToolIcons: Readonly<{
    terminal: "terminal";
    files: "files";
    diff: "diff";
    "pull-request": "pull-request";
    "linked-pull-requests": "pull-request";
    agents: "bot";
    device: "device";
}>;
/** The icon Nová karta draws for a tool: its id's in the registry; for an
 * id outside it the icon its `icon` names, where the registry has that name
 * (interface v1); otherwise the default, `grid`. */
export declare function newTabToolIcon(tool: Pick<NewTabTool, "id" | "icon">): string;
/** The `schema` of every JSON answer of `lazurio browser` (F50 point 3),
 * beside its `kind`. An answer without one is v1. */
export declare const browserCliSchema = "lazurio.browser-cli.v1";
/** The kinds of the answers, one per command. */
export type BrowserCliKind = "browser-window" | "browser-link" | "browser-done" | "browser-open";
/** What letting go of a window came to (`stopSessionDaemon`). */
export type BrowserDoneOutcome = "stopped" | "none" | "refused" | "unconfirmed";
/** An answer of `lazurio browser window`, `link`, `done` or `open` with
 * `--json`;
 * each command answers with its own `kind`, also where the Environment has
 * no browser (`available: false`, exit 10). */
export type BrowserCliAnswer = Readonly<{
    kind: "browser-window";
    session: string;
    targetId: string;
    created: boolean;
    link: string;
    command: string;
}> | Readonly<{
    kind: "browser-link";
    session: string | null;
    link: string;
    /** The new tab of `link --url`. */
    targetId?: string;
}> | Readonly<{
    kind: "browser-done";
    session: string;
    outcome: BrowserDoneOutcome;
}>
/** The default browser's page (root decision 0201 point 5): its tab and
 * link, and the thread whose session it is bound to, so its app shows it;
 * null where none is. */
 | Readonly<{
    kind: "browser-open";
    session: string | null;
    targetId: string;
    link: string;
}> | Readonly<{
    kind: BrowserCliKind;
    available: false;
}>;
/** The text of an answer: JSON with `schema` beside its `kind`. */
export declare function browserCliText(answer: BrowserCliAnswer): string;
/** An answer as a caller reads it (T3 Code reads `window` and `link`): of
 * one of these kinds with its members, `schema` absent or v1; members it
 * does not know are ignored. Null for anything else, an answer of another
 * major too. */
export declare function parseBrowserCliAnswer(text: string): BrowserCliAnswer | null;
/** The exit statuses of `lazurio browser`: done, a usage error, a failure,
 * and an Environment without a browser. The first line of stderr is the
 * reason, in the Operator's language. */
export declare const browserCliExit: Readonly<{
    done: 0;
    failure: 1;
    usage: 2;
    noBrowser: 10;
}>;
/** The times the programs of the Environment browser keep (F50 point 2):
 * one set, which no app or fork types again. In milliseconds where the name
 * says so. Within v1 none that another program relies on is ever shortened
 * (F50 point 3). */
export declare const browserTimes: Readonly<{
    /** The hub ends a tab this long after its last hold went while nobody
     * views it, and a close for everyone ends it after as long (F47 points 5
     * and 6). */
    releaseGraceMs: 8000;
    /** A tab nothing holds ends this long after its last viewer left. */
    viewerGraceMs: 30000;
    /** A tab nothing ever held or viewed ends after this long. */
    unviewedGraceMs: 600000;
    /** Vrátit: every app offers it this long after its release request, 1 s
     * less than the hub's grace, so it never outlives the tab (F50 point 2). */
    undoMs: number;
    /** The hub reads the holds, and every app reconciles its holder file with
     * the list of live tabs, at least this often (the beat). */
    holdsEveryMs: 30000;
    /** A burst of changes is one reading or one reconciliation, this long
     * after its first change. */
    changesJoinMs: 100;
    /** The hub writes the list of live tabs this long after a change. */
    snapshotJoinMs: 50;
    /** The hub reconnects to the browser this long after losing it. */
    reconnectMs: 2000;
    /** The hub waits this long for the browser to report a tab it opened. */
    newTabWaitMs: 2000;
    /** Přehled and the strips read the overview this often while shown. */
    overviewEveryMs: 5000;
    /** A framed Nová karta page that has not heard its host after this long
     * is standalone. */
    standaloneAfterMs: 1500;
    /** Another Environment's view in an app's frame names its tab within this
     * long after it loaded, else the app offers the sign-in there... */
    foreignViewNamedMs: 4000;
    /** ...and within this long after the frame began, when it never loads. */
    foreignViewLoadMs: 15000;
    /** When the view asks the app around it for the identity, after its
     * start, until it answers. */
    identityAskMs: readonly number[];
    /** agent-browser's idle timeout, which the Platform writes into
     * agent-browser's user configuration unless the person set one (C7):
     * agent-browser's own duration syntax. */
    agentBrowserIdleTimeout: "1h";
}>;
/** The bounds and fixed numbers of the Environment browser (F50 point 2). */
export declare const browserBounds: Readonly<{
    /** The browser's DevTools port, on loopback only. */
    devtoolsPort: 9222;
    /** A thread's window: its page area until a person's view resizes it (F39
     * point 3)... */
    windowPage: Readonly<{
        width: 1280;
        height: 800;
    }>;
    /** ...and the window around it. */
    window: Readonly<{
        width: 1280;
        height: 900;
    }>;
    /** What an app shows of a message's title and address (C8). */
    titleLength: 500;
    addressLength: 2048;
    /** What the hub reads of a holder file at most (C5); every app keeps its
     * own bound below it. */
    holderCharacters: number;
    holderTabs: 500;
    holderLabelLength: 200;
}>;
/** The frame an app shows a view in (F50 point 2): the clipboard and full
 * screen; a sandbox that keeps the view on its own origin with its cookie and
 * scripts, never lets it navigate the app, and lets a tab it opens escape as
 * an ordinary tab of the person's browser; and a referrer that names the
 * app's origin, by which another Environment's view admits it (root decision
 * 0191 point 31). Never on the app's own origin: the sandbox confines the
 * frame only while it is another origin. */
export declare const viewFrameAttributes: Readonly<{
    allow: "clipboard-read; clipboard-write; fullscreen";
    referrerpolicy: "origin";
    sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";
}>;
/** The origin of `referer` when it is such an app, else null. */
export declare function appShellOrigin(referer: string | null | undefined): string | null;
/** `frame-ancestors` of a view page (F39 point 8 and its addendum of
 * 2026-10-09): the Environment's own origins, the siblings of the view's host
 * (`https://*.<base>.lazurio.io`), and the T3 Code or Launchpad of another
 * Environment that asks for the page, named by the request's `Referer`. No
 * other page frames it: the gateway's sign-in still decides who sees it, and
 * this keeps the views out of other Organizations' apps. A host of fewer than
 * three labels (a test on localhost) is framed by itself only. */
export declare function viewFrameAncestors(viewOrigin: string, referer?: string | null): string;
/** `frame-ancestors` of Nová karta's page (F47 point 1): the page's own
 * origin and the Environment's own apps that host it (Apps, Chat, Automate),
 * each origin once. */
export declare function newTabFrameAncestors(origins: readonly string[]): string;
/** What a text typed into an address bar opens (F50 point 2): nothing, a
 * page (or a search), a tab of this Environment's view, a new remote tab
 * (this view's bare origin), another Environment's view, which no Lazurio
 * surface opens in this Environment's browser, or nothing, refused: an
 * address on a view host that is no view address, or a scheme other than
 * http and https. */
export type AddressTarget = Readonly<{
    kind: "none";
}> | Readonly<{
    kind: "page";
    url: string;
}> | Readonly<{
    kind: "tab";
    tab: string;
    view: string;
}> | Readonly<{
    kind: "new-tab";
}> | Readonly<{
    kind: "foreign";
    href: string;
    where: string;
}> | Readonly<{
    kind: "refused";
    reason: "view" | "scheme";
}>;
/** A search for `text`. */
export declare function searchAddress(text: string): string;
/** What the address bar opens for `input` (F50 point 2: Chrome's address
 * bar, the view's bar and Nová karta's alike), `viewOrigin` being this
 * Environment's view:
 * 1. text with a scheme opens as typed when the scheme is http or https,
 *    and `about:blank`; any other scheme is refused (a host's port is no
 *    scheme);
 * 2. without one, `localhost`, an IP address or a one-label name followed by
 *    a port or a path opens over http, and a name with a dot and a top-level
 *    domain over https;
 * 3. anything else is a search, except a text without a space that
 *    mentions a view host anywhere (`namesViewHost`), which is refused;
 * 4. an address on a view host (`isViewHost`), typed over http or https, is
 *    never loaded in the Environment browser: a view address of this
 *    Environment is that tab, its bare origin a new remote tab, another
 *    Environment's view that Environment's, and any other address there is
 *    refused. A written default port and dot segments are the address they
 *    stand for, as in Chrome. */
export declare function addressBarTarget(input: string, viewOrigin: string | null): AddressTarget;
/** What the hub opens a tab at or navigates one to on a person's or an
 * app's behalf (C16): an http or https address that is not on a view host
 * (`isViewHost`), or `about:blank`; null for anything else. The page itself
 * may go anywhere it likes, and so may an agent's own browser commands. */
export declare function navigableAddress(value: string): string | null;
/** The languages the Environment browser's surfaces speak. */
export declare const surfaceLanguages: readonly ("cs" | "en")[];
/** One of these languages, or null. */
export declare function surfaceLanguageOf(value: unknown): "cs" | "en" | null;
/** The browser's language (`navigator.language`) as a surface speaks it:
 * Czech for a Czech one, English otherwise. Root decision 0191 point 33
 * gives every surface the shell's language and the browser's only to one
 * shown on its own; a framed view still takes it until the identity answer
 * carries the shell's (F50 point 8, phase 3). */
export declare function browserLanguage(language: string): "cs" | "en";
