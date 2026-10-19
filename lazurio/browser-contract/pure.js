// The Environment browser's contract, its pure part (decision F50): the one
// definition of the rules shared by the programs that meet in the
// Environment browser. The view's hub and its service, the view page, the
// Launchpad, the `lazurio browser` CLI and the shell take them from here, and
// the forks (T3 Code, Lazurio MausBot) take this module from the attested
// shell artifact.
//
// Pure: no I/O, no DOM and no runtime built-ins but the standard `URL`, so it
// runs in a page, in Node and in Bun. `node.ts` is the part that needs the
// file system, processes and sockets. Within v1 the contract only grows (F50
// point 3): a release may add members, values and cases and accept what it
// refused before; it never removes, renames or narrows anything. The module's
// directory holds nothing from outside it and is licensed under MIT
// (`LICENSE`, F50 point 6), unlike the rest of this repository.
// ---- Remote tabs (C1) --------------------------------------------------------
const targetIdPattern = /^[0-9A-Fa-f]{32}$/;
/** A remote tab's id (F39 point 1): a DevTools target id, 32 hexadecimal
 * digits. Chrome and the Platform write it in upper case; a reader takes it
 * in either case and keeps its upper-case form (`targetIdOf`). */
export function isTargetId(value) {
    return typeof value === "string" && targetIdPattern.test(value);
}
/** A remote tab's id in upper case, as Chrome writes it; null for anything
 * that is no target id. */
export function targetIdOf(value) {
    return isTargetId(value) ? value.toUpperCase() : null;
}
// ---- Strips and sessions (C2) ------------------------------------------------
const stripPattern = /^[A-Za-z0-9_-]{1,64}$/;
/** A strip's name (F47 point 4), which is also its holder file's name
 * without `.json` and an agent-browser session's name: `[A-Za-z0-9_-]`, at
 * most 64 characters. It is Lazurio's deliberate subset of the names
 * agent-browser accepts, which may be longer and hold other characters (F50
 * point 2): the hub counts no binding of a session outside it. */
export function isStrip(value) {
    return typeof value === "string" && stripPattern.test(value);
}
/** The Launchpad's one strip (F47 point 4). */
export const launchpadStrip = "launchpad";
/** The prefix of every other app's strips and sessions (F50 point 2): a T3
 * Code thread's `t3-<thread>`, a Codex thread's `codex-<CODEX_THREAD_ID>`, a
 * Claude Code session's `claude-<CLAUDE_CODE_SESSION_ID>`, and `bot-`,
 * reserved for Lazurio MausBot's bots. The overview and the strips name an
 * app by them, and an app writes and removes only the holder files of its
 * own prefix; the Launchpad only `launchpad.json`. */
// Marked pure, so a bundle that takes another rule of this module leaves the
// registry out.
export const stripPrefixes = /* @__PURE__ */ Object.freeze({
    t3code: "t3-",
    codex: "codex-",
    claude: "claude-",
    mausbot: "bot-",
});
/** The app a strip's or a session's name belongs to; null for a name of no
 * app (a session named by hand) and for anything that is no strip's name. */
export function stripAppOf(name) {
    if (!isStrip(name))
        return null;
    if (name === launchpadStrip)
        return "launchpad";
    const apps = Object.keys(stripPrefixes);
    return apps.find((app) => name.startsWith(stripPrefixes[app])) ?? null;
}
/** The agent-browser session of the calling thread: the name given on
 * purpose, used as given or refused; otherwise the one its harness gives it,
 * every character outside the alphabet a `-` and cut at 64. T3 Code sets
 * `AGENT_BROWSER_SESSION` per thread; Codex exports `CODEX_THREAD_ID` and
 * Claude Code `CLAUDE_CODE_SESSION_ID` to the commands of a thread. Null
 * when there is none. */
export function threadSession(named, env) {
    const candidates = [
        named,
        env.AGENT_BROWSER_SESSION,
        env.CODEX_THREAD_ID === undefined
            ? undefined
            : `${stripPrefixes.codex}${env.CODEX_THREAD_ID}`,
        env.CLAUDE_CODE_SESSION_ID === undefined
            ? undefined
            : `${stripPrefixes.claude}${env.CLAUDE_CODE_SESSION_ID}`,
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === "")
            continue;
        // A name given on purpose is used as given or refused.
        if (candidate === named)
            return isStrip(named) ? named : null;
        const sanitized = candidate.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
        if (isStrip(sanitized))
            return sanitized;
    }
    return null;
}
// ---- Environments and the addresses of their views (C3) ---------------------
// The identity of an Environment (F37's addendum of 2026-10-04): its base
// host in lowercase DNS form. Every hosted Environment has its own addresses
// (root decision 0146): `<app>.<machine>.<org>.lazurio.io` for an
// Organization's Environment, `<app>.<personal-dns-slug>.lazurio.io` for a
// personal Remote Environment. What stands between the app label and
// `lazurio.io` is unique by DNS, so it tells two Organizations' `vm-01`
// apart, where the bare machine name repeats. The Dashboard derives the same
// value from the registry's Apps address. A workstation, which has no such
// address, keeps its local id (one label, `local`). `src/shell/contract.ts`
// passes both functions on to the shell's documents.
const hostedDomain = ".lazurio.io";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** An Environment id: one lowercase DNS label (a personal Remote
 * Environment's slug, a workstation's `local`) or two (`<machine>.<org>`). */
export function isEnvironmentId(value) {
    if (typeof value !== "string")
        return false;
    const labels = value.split(".");
    return (labels.length >= 1 &&
        labels.length <= 2 &&
        labels.every((label) => dnsLabel.test(label)));
}
/** The id of a hosted Environment from an app origin of its own
 * (`https://<app>.<base>.lazurio.io`, with or without the trailing slash of
 * an Apps address): `<base>` in lowercase, one label for a personal Remote
 * Environment, two for an Organization's. Null for anything else: another
 * scheme, a port, credentials, a path, a query or a fragment, another
 * domain, or a base of another depth. The one place the id is derived. */
export function environmentIdOf(origin) {
    let url;
    try {
        url = new URL(origin);
    }
    catch {
        return null;
    }
    const written = origin.toLowerCase();
    if (url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        (written !== url.origin && written !== `${url.origin}/`))
        return null;
    const host = url.hostname;
    if (!host.endsWith(hostedDomain))
        return null;
    const labels = host.slice(0, -hostedDomain.length).split(".");
    // The app's label, then the base of one or two labels.
    if (labels.length < 2 || labels.length > 3)
        return null;
    if (!labels.every((label) => dnsLabel.test(label)))
        return null;
    const id = labels.slice(1).join(".");
    return isEnvironmentId(id) ? id : null;
}
/** The label the gateway routes an Environment browser's view under
 * (decisions F38 and F39): `https://browser.<base>.lazurio.io`. */
const viewLabel = "browser";
const viewPathPattern = /^\/t\/([^/]+)$/;
/** Far longer than any view address, whose base has at most two labels. */
const maxViewLength = 512;
/** The path of one remote tab's view, `/t/<id>`, or of a new tab, `/` (F39
 * point 1), the id written as given: Chrome's, in upper case. */
export function viewPath(targetId) {
    return targetId === null ? "/" : `/t/${targetId}`;
}
/** The view of one remote tab, `<origin>/t/<id>`, or of a new one,
 * `<origin>/` (F39 point 1): `viewPath` on the view's origin. Neither carries
 * a token: the gateway's session is the only admission (F39 point 8). */
export function browserViewUrl(origin, targetId) {
    return `${origin}${viewPath(targetId)}`;
}
/** The remote tab a path of the view shows, `/t/<id>`: the id in either case,
 * given in its upper-case form (`targetIdOf`); null for any other path. */
export function viewPathTab(path) {
    return targetIdOf(viewPathPattern.exec(path)?.[1]);
}
/** The view address `value` is (F50 point 2):
 * `https://browser.<base>.lazurio.io/t/<id>`, one remote tab, or the bare
 * origin, with or without its `/`, which opens a new one. `<base>` is an id
 * `environmentIdOf` gives and the id a target id in either case
 * (`targetIdOf`); the rest exactly as written: the host in lower case, no
 * port, no credentials, no query or fragment (not even an empty one) and no
 * slash after the id. A link is a tab only in this form, on every Lazurio
 * surface alike. Null for anything else. */
export function viewAddressOf(value) {
    if (typeof value !== "string" || value.length > maxViewLength)
        return null;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return null;
    }
    const environment = environmentIdOf(url.origin);
    if (environment === null ||
        url.hostname !== `${viewLabel}.${environment}${hostedDomain}` ||
        url.username !== "" ||
        url.password !== "")
        return null;
    const origin = url.origin;
    if (value === origin || value === `${origin}/`)
        return Object.freeze({
            view: browserViewUrl(origin, null),
            origin,
            environment,
            tab: null,
        });
    const tab = value === `${origin}${url.pathname}` ? viewPathTab(url.pathname) : null;
    return tab === null
        ? null
        : Object.freeze({
            view: browserViewUrl(origin, tab),
            origin,
            environment,
            tab,
        });
}
/** Whether a host is where the gateway routes the views of Environment
 * browsers: `browser.` and a name in `lazurio.io`, an Environment's or not,
 * also written in its absolute form with the DNS root's trailing dot, which
 * names the same host. No Lazurio surface loads an address on such a host in
 * the Environment browser (F50 point 2): a view address opens as its tab, a
 * new tab or another Environment's, and any other address there is refused.
 * The browser itself stays unrestricted. */
export function isViewHost(hostname) {
    const host = hostname.toLowerCase().replace(/\.+$/, "");
    return host.startsWith(`${viewLabel}.`) && host.endsWith(hostedDomain);
}
const bootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A boot-clock time as it is stored, or null when the value is not one. */
export function parseBootTime(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const record = value;
    return typeof record.boot === "string" &&
        bootIdPattern.test(record.boot) &&
        typeof record.at === "number" &&
        Number.isFinite(record.at) &&
        record.at >= 0
        ? { boot: record.boot, at: record.at }
        : null;
}
// ---- Holder files (C5) -------------------------------------------------------
/** The `schema` of every holder file this module writes (F50 point 3). A
 * file without one is v1, written before the module; a file of another major
 * is one this module cannot read. */
export const holderSchema = "lazurio.browser-holder.v1";
/** The hold one holder file records, or null when the file is not one this
 * module can read: its name is `<strip>.json`, its `strip` that strip and
 * its `schema` absent or `holderSchema`, and only target ids count, in upper
 * case and once each, at most 500. The label is trimmed and cut at 200
 * characters; a file of more than 64 Ki characters is none. Members it does
 * not know are ignored, the writer's `contract` and `recordedAt` too. */
export function parseHolder(fileName, text) {
    if (!fileName.endsWith(".json"))
        return null;
    const name = fileName.slice(0, -".json".length);
    if (!isStrip(name) || text.length > browserBounds.holderCharacters)
        return null;
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof value !== "object" || value === null)
        return null;
    const record = value;
    if (record.schema !== undefined && record.schema !== holderSchema)
        return null;
    if (record.strip !== name || !Array.isArray(record.tabs))
        return null;
    const label = typeof record.label === "string"
        ? record.label.trim().slice(0, browserBounds.holderLabelLength)
        : "";
    const tabs = [
        ...new Set(record.tabs.flatMap((id) => {
            const tab = targetIdOf(id);
            return tab === null ? [] : [tab];
        })),
    ].slice(0, browserBounds.holderTabs);
    return { strip: name, label, tabs };
}
/** The text of a holder file (F47 point 4, F50 point 3): its `schema`, the
 * Platform release this module came from (`contract`, which doctor reads and
 * the hub ignores), the strip, its label, its tabs, and each tab's record
 * time, `recordedAt`, by its id. The hub ignores the times too: only the app
 * that writes the file reads them back (`parseHolderRecords`), so its
 * reconciliation survives a restart. A tab without a time has no entry. */
export function holderFileText(strip, label, tabs, contract) {
    const recordedAt = {};
    for (const tab of tabs)
        if (tab.recordedAt !== null)
            recordedAt[tab.id] = { boot: tab.recordedAt.boot, at: tab.recordedAt.at };
    return `${JSON.stringify({
        schema: holderSchema,
        contract,
        strip,
        label,
        tabs: tabs.map((tab) => tab.id),
        recordedAt,
    })}\n`;
}
/** A holder file with the record time of each of its tabs, or null when the
 * file is not a holder file (`parseHolder`'s rules). A tab whose time is
 * missing or not a boot-clock time has null. */
export function parseHolderRecords(fileName, text) {
    const hold = parseHolder(fileName, text);
    if (hold === null)
        return null;
    const times = new Map();
    const stored = JSON.parse(text).recordedAt;
    if (typeof stored === "object" && stored !== null && !Array.isArray(stored))
        for (const [id, value] of Object.entries(stored)) {
            const tab = targetIdOf(id);
            const at = parseBootTime(value);
            if (tab !== null && at !== null)
                times.set(tab, at);
        }
    return {
        strip: hold.strip,
        label: hold.label,
        tabs: hold.tabs.map((id) => ({ id, recordedAt: times.get(id) ?? null })),
    };
}
// ---- The list of live tabs (C6) ----------------------------------------------
/** The `schema` of the hub's list of live tabs (F50 point 3); a list without
 * one is v1, and one of another major is no list. */
export const liveTabsSchema = "lazurio.browser-tabs.v1";
/** The text of `tabs.json`, the hub's list that every app reconciles its
 * holds with (F47 point 4). */
export function liveTabsText(tabs, takenAt) {
    return `${JSON.stringify({ schema: liveTabsSchema, tabs, takenAt })}\n`;
}
/** The list a reader finds, its ids in upper case, or null when the file is
 * not one: every id a target id, the time a boot-clock time and the `schema`
 * absent or `liveTabsSchema`. Members it does not know are ignored. */
export function parseLiveTabs(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof value !== "object" || value === null)
        return null;
    const record = value;
    if (record.schema !== undefined && record.schema !== liveTabsSchema)
        return null;
    const takenAt = parseBootTime(record.takenAt);
    if (!Array.isArray(record.tabs) || takenAt === null)
        return null;
    if (!record.tabs.every(isTargetId))
        return null;
    return {
        tabs: record.tabs.map((id) => id.toUpperCase()),
        takenAt,
    };
}
/** An app's reconciliation (F47 point 4): the ids it keeps from its stored
 * ones, `boot` being the current boot. A list of another boot is ignored.
 * An id the list lacks goes when the list was taken after the app recorded
 * it: a snapshot lists every target that exists when it begins, so such an
 * id had ended by then, while a tab recorded after the snapshot began stays.
 * A record from an earlier boot, or without a time, is older than every list
 * of this boot. Without a list, or without the boot clock, it keeps
 * everything. */
export function keptTabs(stored, list, boot) {
    if (list === null || boot === null || list.takenAt.boot !== boot)
        return stored.map((tab) => tab.id);
    const live = new Set(list.tabs);
    return stored
        .filter((tab) => live.has(tab.id.toUpperCase()) ||
        (tab.recordedAt !== null &&
            tab.recordedAt.boot === boot &&
            tab.recordedAt.at >= list.takenAt.at))
        .map((tab) => tab.id);
}
// ---- The view's messages to its app (C8) and the identity (C9) --------------
/** The `type` of every message between a view and the app around it (F39
 * point 4, F47 point 4, F39's addendum of 2026-10-12), each posted with
 * `postMessage` to exactly the other side's origin. */
export const browserMessage = Object.freeze({
    /** View → app: where its tab is, `{view, url, title}`. */
    info: "lazurio-browser:info",
    /** View → app: its page opened a new tab, `{view, url}`. */
    newTab: "lazurio-browser:new-tab",
    /** View → app: its tab ended, `{view}`. */
    closed: "lazurio-browser:closed",
    /** View → app: how does your shell name my Environment? */
    identityRequest: "lazurio-browser:identity-request",
    /** App → view: `{identity}`, and the majors its own parser reads
     * (`majors`). */
    identity: "lazurio-browser:identity",
});
/** The majors of the messages this module writes and reads (F50 point 3).
 * A message carries its major as `v`; one without is v1, for good. */
export const messageMajors = Object.freeze([1]);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether this module reads a message: its `v` absent, or a major of
 * `messageMajors`. A message of another major is one it cannot read, which
 * counts as no message at all (F50 point 3). */
const readsMajor = (data) => data.v === undefined || messageMajors.includes(data.v);
/** The majors an app's identity answer names (`majors`): whole numbers from
 * 1, at most 16, none twice; null where it names none, which every app
 * deployed before this member does, or names them in another form. */
export function parseMessageMajors(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 16)
        return null;
    const majors = value.filter((major) => Number.isSafeInteger(major) && major >= 1);
    return majors.length === value.length &&
        new Set(majors).size === majors.length
        ? Object.freeze([...majors])
        : null;
}
/** The major a view sends its messages in (F50 point 3): the highest that
 * both it and the app around it read. To an app whose identity answer named
 * no majors (every app deployed before them) or that has not answered, v1:
 * a receiver deployed today never gets a message it would read as another v1
 * action. Null for an app that names majors but none of these: it could read
 * no message, so none is sent. */
export function messageMajor(majors) {
    if (majors === null)
        return 1;
    const common = majors.filter((major) => messageMajors.includes(major));
    return common.length === 0 ? null : Math.max(...common);
}
/** `lazurio-browser:info` (C8): where the view's tab is, the tab named by
 * its view address in the contract's form (`browserViewUrl`). */
export function viewInfoMessage(view, url, title) {
    return Object.freeze({ type: browserMessage.info, v: 1, view, url, title });
}
/** `lazurio-browser:new-tab` (C8): the view's page opened the tab of `view`
 * as a new tab, at `url`. */
export function viewNewTabMessage(view, url) {
    return Object.freeze({ type: browserMessage.newTab, v: 1, view, url });
}
/** `lazurio-browser:closed` (C8): the tab of `view` ended. */
export function viewClosedMessage(view) {
    return Object.freeze({ type: browserMessage.closed, v: 1, view });
}
/** `lazurio-browser:identity-request` (C9): the view asks the app around it
 * how its shell names the view's Environment. */
export function identityRequestMessage() {
    return Object.freeze({ type: browserMessage.identityRequest, v: 1 });
}
/** `lazurio-browser:identity` (C9): the app's answer. `identity` is the
 * shell's document of that Environment (or null where the app does not know
 * it), which the shell reads; `majors` are the majors the app's own message
 * parser reads, only where the app named them (F50 point 3): the answer never
 * names majors by itself. */
export function identityReplyMessage(identity, majors = null) {
    return Object.freeze({
        type: browserMessage.identity,
        v: 1,
        identity,
        ...(majors === null ? {} : { majors: Object.freeze([...majors]) }),
    });
}
/** A message of a view as the app around it takes it (F50 point 2): only
 * from that frame's window (`fromFrame`) on the view's own origin, of a major
 * this module reads, about a tab it names by a view address of that origin
 * in the contract's form (`viewAddressOf`), with the members its kind needs.
 * Texts are cut for display at `browserBounds.titleLength` and
 * `addressLength` characters. Null for anything else. */
export function acceptViewMessage(event, viewOrigin) {
    if (!event.fromFrame || viewOrigin === null || event.origin !== viewOrigin)
        return null;
    const data = event.data;
    if (!isRecord(data) || !readsMajor(data))
        return null;
    const address = viewAddressOf(data.view);
    const tab = address !== null && address.origin === viewOrigin ? address.tab : null;
    if (tab === null)
        return null;
    const cut = (text, length) => text.slice(0, length);
    switch (data.type) {
        case browserMessage.newTab:
            return typeof data.url === "string"
                ? {
                    kind: "new-tab",
                    tab,
                    url: cut(data.url, browserBounds.addressLength),
                }
                : null;
        case browserMessage.closed:
            return { kind: "closed", tab };
        case browserMessage.info:
            return typeof data.title === "string" && typeof data.url === "string"
                ? {
                    kind: "info",
                    tab,
                    title: cut(data.title, browserBounds.titleLength),
                    url: cut(data.url, browserBounds.addressLength),
                }
                : null;
        default:
            return null;
    }
}
/** The Environment of a view's origin: the base host of
 * `https://browser.<base>.lazurio.io`, the bare origin of a view address
 * (`viewAddressOf`); null for any other origin. */
export function viewEnvironmentId(origin) {
    const address = viewAddressOf(origin);
    return address !== null && address.tab === null ? address.environment : null;
}
/** The app's side of the identity (C9): the Environment a request asks
 * about, or null. A request counts only from a frame of the app's own page
 * (`fromFrame`) on a view's origin, of a major this module reads, and it
 * asks about that origin's Environment, never another. */
export function identityRequestOf(event) {
    if (!event.fromFrame ||
        !isRecord(event.data) ||
        event.data.type !== browserMessage.identityRequest ||
        !readsMajor(event.data))
        return null;
    return viewEnvironmentId(event.origin);
}
/** The view's side of the identity (C9): its parent's answer, or null. It
 * counts only from the parent window (`fromParent`), on the parent's origin
 * as the browser names it (`location.ancestorOrigins`, `ancestor`) or, where
 * it names none, on an app origin of an Environment
 * (`https://<app>.<base>.lazurio.io`, the only pages a view's
 * `frame-ancestors` admits), and only of a major this module reads. It gives
 * the identity as the app sent it, which the shell reads, and the majors the
 * app named (`parseMessageMajors`). */
export function acceptIdentityReply(event, ancestor) {
    if (!event.fromParent)
        return null;
    const named = ancestor !== null && ancestor !== "null";
    if (named ? event.origin !== ancestor : environmentIdOf(event.origin) === null)
        return null;
    const data = event.data;
    if (!isRecord(data) ||
        data.type !== browserMessage.identity ||
        !readsMajor(data) ||
        !Object.hasOwn(data, "identity"))
        return null;
    return Object.freeze({
        identity: data.identity,
        majors: parseMessageMajors(data.majors),
    });
}
// ---- Nová karta's interface to an app (C10) -----------------------------------
/** The event `<lazurio-new-tab>` dispatches (F47 point 2): `detail` is what
 * the tab became (`NewTabChoice`). */
export const newTabEventName = "lazurio-new-tab";
const toolNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
const toolKeyPattern = /^[A-Za-z0-9]$/;
/** At most this many tools: T3 Code has six. */
export const maxNewTabTools = 12;
const maxToolLabelLength = 48;
const isToolLabel = (value) => typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= maxToolLabelLength &&
    ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
    });
/** An optional member: undefined when absent, the text when it matches
 * `pattern`, null for anything else. */
const optionalText = (value, pattern) => value === undefined
    ? undefined
    : typeof value === "string" && pattern.test(value)
        ? value
        : null;
/** The app's tools (the element's `tools`), or null when `value` is not a
 * list of them: at most `maxNewTabTools`, each with an id and a label, an
 * optional letter and an optional icon name, no id or letter twice. */
export function parseNewTabTools(value) {
    if (!Array.isArray(value) || value.length > maxNewTabTools)
        return null;
    const tools = [];
    const ids = new Set();
    const keys = new Set();
    for (const item of value) {
        if (!isRecord(item))
            return null;
        const { id, label } = item;
        const key = optionalText(item.key, toolKeyPattern);
        const icon = optionalText(item.icon, toolNamePattern);
        if (typeof id !== "string" ||
            !toolNamePattern.test(id) ||
            ids.has(id) ||
            !isToolLabel(label) ||
            key === null ||
            icon === null)
            return null;
        if (key !== undefined) {
            if (keys.has(key.toLowerCase()))
                return null;
            keys.add(key.toLowerCase());
        }
        ids.add(id);
        tools.push(Object.freeze({
            id,
            label,
            ...(key === undefined ? {} : { key }),
            ...(icon === undefined ? {} : { icon }),
        }));
    }
    return Object.freeze(tools);
}
/** The view of the remote tab `tab` (upper case) when `value` is one, a view
 * address of the contract (`viewAddressOf`, decision F50 point 2):
 * `https://browser.<base>.lazurio.io/t/<tab>`, as the contract writes it.
 * Null otherwise. */
export function newTabViewOf(value, tab) {
    const address = viewAddressOf(value);
    return address !== null && address.tab === tab ? address.view : null;
}
/** A choice of these three kinds and their exact members, or null: a tab's
 * id in upper case, as the hub writes it, with that tab's view; a tool by an
 * id of the tools' grammar. */
export function parseNewTabChoice(value) {
    if (!isRecord(value))
        return null;
    switch (value.kind) {
        case "page":
        case "tab": {
            const tab = targetIdOf(value.tab);
            if (tab === null)
                return null;
            const view = newTabViewOf(value.view, tab);
            return view === null
                ? null
                : Object.freeze({ kind: value.kind, tab, view });
        }
        case "tool":
            return typeof value.id === "string" && toolNamePattern.test(value.id)
                ? Object.freeze({ kind: "tool", id: value.id })
                : null;
        default:
            return null;
    }
}
/** The tools' registry (F50 point 2): the ids an app maps its own surfaces
 * to, each with its icon in Nová karta's set. An app chooses the id by the
 * surface, never by its label. */
// Marked pure, so a bundle that takes another rule leaves the registry out.
export const newTabToolIcons = /* @__PURE__ */ Object.freeze({
    terminal: "terminal",
    files: "files",
    diff: "diff",
    "pull-request": "pull-request",
    "linked-pull-requests": "pull-request",
    agents: "bot",
    device: "device",
});
/** The icon Nová karta draws for a tool: its id's in the registry; for an
 * id outside it the icon its `icon` names, where the registry has that name
 * (interface v1); otherwise the default, `grid`. */
export function newTabToolIcon(tool) {
    const icons = newTabToolIcons;
    return ((Object.hasOwn(icons, tool.id) ? icons[tool.id] : undefined) ??
        (tool.icon !== undefined && Object.hasOwn(icons, tool.icon)
            ? icons[tool.icon]
            : undefined) ??
        "grid");
}
// ---- `lazurio browser … --json` (C13) -----------------------------------------
/** The `schema` of every JSON answer of `lazurio browser` (F50 point 3),
 * beside its `kind`. An answer without one is v1. */
export const browserCliSchema = "lazurio.browser-cli.v1";
/** The text of an answer: JSON with `schema` beside its `kind`. */
export function browserCliText(answer) {
    return JSON.stringify({ schema: browserCliSchema, ...answer });
}
const cliKinds = [
    "browser-window",
    "browser-link",
    "browser-done",
    "browser-open",
];
const doneOutcomes = [
    "stopped",
    "none",
    "refused",
    "unconfirmed",
];
/** An answer as a caller reads it (T3 Code reads `window` and `link`): of
 * one of these kinds with its members, `schema` absent or v1; members it
 * does not know are ignored. Null for anything else, an answer of another
 * major too. */
export function parseBrowserCliAnswer(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || !cliKinds.includes(value.kind))
        return null;
    if (value.schema !== undefined && value.schema !== browserCliSchema)
        return null;
    const kind = value.kind;
    if (value.available === false)
        return Object.freeze({ kind, available: false });
    const session = isStrip(value.session) ? value.session : null;
    switch (kind) {
        case "browser-window": {
            const targetId = targetIdOf(value.targetId);
            return session !== null &&
                targetId !== null &&
                typeof value.created === "boolean" &&
                typeof value.link === "string" &&
                typeof value.command === "string"
                ? Object.freeze({
                    kind,
                    session,
                    targetId,
                    created: value.created,
                    link: value.link,
                    command: value.command,
                })
                : null;
        }
        case "browser-link": {
            const targetId = value.targetId === undefined ? undefined : targetIdOf(value.targetId);
            return (session !== null || value.session === null) &&
                typeof value.link === "string" &&
                targetId !== null
                ? Object.freeze({
                    kind,
                    session,
                    link: value.link,
                    ...(targetId === undefined ? {} : { targetId }),
                })
                : null;
        }
        case "browser-done":
            return session !== null && doneOutcomes.includes(value.outcome)
                ? Object.freeze({
                    kind,
                    session,
                    outcome: value.outcome,
                })
                : null;
        case "browser-open": {
            const targetId = targetIdOf(value.targetId);
            return (session !== null || value.session === null) &&
                targetId !== null &&
                typeof value.link === "string"
                ? Object.freeze({ kind, session, targetId, link: value.link })
                : null;
        }
    }
}
/** The exit statuses of `lazurio browser`: done, a usage error, a failure,
 * and an Environment without a browser. The first line of stderr is the
 * reason, in the Operator's language. */
export const browserCliExit = Object.freeze({
    done: 0,
    failure: 1,
    usage: 2,
    noBrowser: 10,
});
// ---- Times and bounds (C14) ---------------------------------------------------
const releaseGrace = 8_000;
/** The times the programs of the Environment browser keep (F50 point 2):
 * one set, which no app or fork types again. In milliseconds where the name
 * says so. Within v1 none that another program relies on is ever shortened
 * (F50 point 3). */
export const browserTimes = Object.freeze({
    /** The hub ends a tab this long after its last hold went while nobody
     * views it, and a close for everyone ends it after as long (F47 points 5
     * and 6). */
    releaseGraceMs: releaseGrace,
    /** A tab nothing holds ends this long after its last viewer left. */
    viewerGraceMs: 30_000,
    /** A tab nothing ever held or viewed ends after this long. */
    unviewedGraceMs: 600_000,
    /** Vrátit: every app offers it this long after its release request, 1 s
     * less than the hub's grace, so it never outlives the tab (F50 point 2). */
    undoMs: releaseGrace - 1_000,
    /** The hub reads the holds, and every app reconciles its holder file with
     * the list of live tabs, at least this often (the beat). */
    holdsEveryMs: 30_000,
    /** A burst of changes is one reading or one reconciliation, this long
     * after its first change. */
    changesJoinMs: 100,
    /** The hub writes the list of live tabs this long after a change. */
    snapshotJoinMs: 50,
    /** The hub reconnects to the browser this long after losing it. */
    reconnectMs: 2_000,
    /** The hub waits this long for the browser to report a tab it opened. */
    newTabWaitMs: 2_000,
    /** Přehled and the strips read the overview this often while shown. */
    overviewEveryMs: 5_000,
    /** A framed Nová karta page that has not heard its host after this long
     * is standalone. */
    standaloneAfterMs: 1_500,
    /** Another Environment's view in an app's frame names its tab within this
     * long after it loaded, else the app offers the sign-in there... */
    foreignViewNamedMs: 4_000,
    /** ...and within this long after the frame began, when it never loads. */
    foreignViewLoadMs: 15_000,
    /** When the view asks the app around it for the identity, after its
     * start, until it answers. */
    identityAskMs: Object.freeze([0, 1_000, 4_000]),
    /** agent-browser's idle timeout, which the Platform writes into
     * agent-browser's user configuration unless the person set one (C7):
     * agent-browser's own duration syntax. */
    agentBrowserIdleTimeout: "1h",
});
/** The bounds and fixed numbers of the Environment browser (F50 point 2). */
export const browserBounds = Object.freeze({
    /** The browser's DevTools port, on loopback only. */
    devtoolsPort: 9222,
    /** A thread's window: its page area until a person's view resizes it (F39
     * point 3)... */
    windowPage: Object.freeze({ width: 1280, height: 800 }),
    /** ...and the window around it. */
    window: Object.freeze({ width: 1280, height: 900 }),
    /** What an app shows of a message's title and address (C8). */
    titleLength: 500,
    addressLength: 2_048,
    /** What the hub reads of a holder file at most (C5); every app keeps its
     * own bound below it. */
    holderCharacters: 64 * 1024,
    holderTabs: 500,
    holderLabelLength: 200,
});
// ---- Framing (C15) ------------------------------------------------------------
/** The frame an app shows a view in (F50 point 2): the clipboard and full
 * screen; a sandbox that keeps the view on its own origin with its cookie and
 * scripts, never lets it navigate the app, and lets a tab it opens escape as
 * an ordinary tab of the person's browser; and a referrer that names the
 * app's origin, by which another Environment's view admits it (root decision
 * 0191 point 31). Never on the app's own origin: the sandbox confines the
 * frame only while it is another origin. */
export const viewFrameAttributes = Object.freeze({
    allow: "clipboard-read; clipboard-write; fullscreen",
    referrerpolicy: "origin",
    sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
});
/** The apps that frame views in their right panel: T3 Code and the
 * Launchpad of an Environment on lazurio.io. */
const appShellPattern = /^https:\/\/(?:t3code|launchpad)\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+lazurio\.io$/;
/** The origin of `referer` when it is such an app, else null. */
export function appShellOrigin(referer) {
    if (!referer)
        return null;
    let url;
    try {
        url = new URL(referer);
    }
    catch {
        return null;
    }
    return appShellPattern.test(url.origin) ? url.origin : null;
}
/** `frame-ancestors` of a view page (F39 point 8 and its addendum of
 * 2026-10-09): the Environment's own origins, the siblings of the view's host
 * (`https://*.<base>.lazurio.io`), and the T3 Code or Launchpad of another
 * Environment that asks for the page, named by the request's `Referer`. No
 * other page frames it: the gateway's sign-in still decides who sees it, and
 * this keeps the views out of other Organizations' apps. A host of fewer than
 * three labels (a test on localhost) is framed by itself only. */
export function viewFrameAncestors(viewOrigin, referer) {
    const labels = new URL(viewOrigin).hostname.split(".");
    if (labels.length < 3)
        return "'self'";
    const siblings = labels.slice(1).join(".");
    const shell = appShellOrigin(referer);
    return shell === null || new URL(shell).hostname.endsWith(`.${siblings}`)
        ? `'self' https://*.${siblings}`
        : `'self' https://*.${siblings} ${shell}`;
}
/** `frame-ancestors` of Nová karta's page (F47 point 1): the page's own
 * origin and the Environment's own apps that host it (Apps, Chat, Automate),
 * each origin once. */
export function newTabFrameAncestors(origins) {
    return ["'self'", ...new Set(origins)].join(" ");
}
/** A search for `text`. */
export function searchAddress(text) {
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
const dnsName = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A host as typed: `localhost`, an IP address (IPv6 in brackets), a name of
 * one label, or a name of more labels whose last is a top-level domain (two
 * letters or more, or an IDN's `xn--`); null for anything else. */
function typedHost(name) {
    const host = name.toLowerCase();
    if (host === "localhost")
        return "local";
    if (ipv4.test(host) || /^\[[0-9a-f:.]+\]$/.test(host))
        return "ip";
    const labels = host.split(".");
    if (!labels.every((label) => dnsName.test(label)))
        return null;
    if (labels.length === 1)
        return "label";
    const top = labels[labels.length - 1] ?? "";
    return /^\p{L}{2,63}$/u.test(top) || /^xn--[a-z0-9-]{1,59}$/.test(top)
        ? "domain"
        : null;
}
/** A view host's name, `browser.` and a name in `lazurio.io` (`isViewHost`),
 * anywhere in a text, standing apart from the letters, digits and hyphens
 * around it. */
const viewHostMention = /(?:^|[^\p{L}\p{N}-])browser\.(?:[^\s/?#\\@]+\.)?lazurio\.io(?![\p{L}\p{N}-])/u;
/** Whether a text that is no address still names a view host, in any
 * spelling, so it is refused and never a search: no view's address reaches
 * the search engine (F50 point 2). It does when the URL parser, typed
 * without a scheme or as a network path (`//`, `\\`), reads its host as a
 * view host (`isViewHost`), with the IDNA mapping a browser applies (soft
 * hyphens and other ignored characters gone, full-width forms, escapes,
 * upper case). It does too when the text mentions a view host anywhere once
 * read the same way by hand: one percent-decoding, Unicode's
 * default-ignorable characters removed, NFKC, ideographic and full-width
 * dots as dots, lower case. That holds a name no address takes, a port out
 * of range, an encoded slash. A text with a space is a search, as in Chrome,
 * whatever it mentions. */
function namesViewHost(typed) {
    if (/\s/.test(typed))
        return false;
    for (const read of [
        () => new URL(`https://${typed}`),
        () => new URL(typed, "https://host.invalid/"),
    ])
        try {
            if (isViewHost(read().hostname))
                return true;
        }
        catch { }
    let text = typed;
    try {
        text = decodeURIComponent(typed);
    }
    catch { }
    return viewHostMention.test(text
        .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
        .normalize("NFKC")
        .replace(/[\u3002\uff0e\uff61]/g, ".")
        .toLowerCase());
}
/** The address a text typed without a scheme stands for, as Chrome's
 * address bar reads it: `localhost`, an IP address, or a one-label name
 * followed by a port or a path, over http; a name with a dot and a
 * top-level domain over https. Null for a text that is a search: a single
 * word, text with spaces, an e-mail address. */
function typedAddress(typed) {
    if (/\s/.test(typed))
        return null;
    const host = typed.split(/[/?#]/, 1)[0] ?? "";
    if (host === "" || host.includes("@"))
        return null;
    const port = /^(.*?)(?::(\d{1,5}))?$/.exec(host);
    const name = port?.[1] ?? "";
    const kind = typedHost(name);
    const rest = typed.slice(host.length);
    const http = kind === "local" ||
        kind === "ip" ||
        (kind === "label" && (port?.[2] !== undefined || rest.startsWith("/")));
    if (!http && kind !== "domain")
        return null;
    try {
        return new URL(`${http ? "http" : "https"}://${typed}`);
    }
    catch {
        return null;
    }
}
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
export function addressBarTarget(input, viewOrigin) {
    const typed = input.trim();
    if (typed === "")
        return { kind: "none" };
    if (typed.toLowerCase() === "about:blank")
        return { kind: "page", url: "about:blank" };
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(typed);
    let address;
    if (scheme !== null && !/^\d{1,5}(?:[/?#]|$)/.test(scheme[2] ?? "")) {
        const name = (scheme[1] ?? "").toLowerCase();
        if (name !== "http" && name !== "https")
            return { kind: "refused", reason: "scheme" };
        try {
            address = new URL(typed);
        }
        catch {
            address = null;
        }
    }
    else
        address = typedAddress(typed);
    if (address === null)
        return namesViewHost(typed)
            ? { kind: "refused", reason: "view" }
            : { kind: "page", url: searchAddress(typed) };
    if (!isViewHost(address.hostname))
        return { kind: "page", url: address.href };
    // Over http, the view's own https, as written otherwise.
    const secure = new URL(address.href.replace(/^http:/, "https:"));
    const view = viewAddressOf(secure.href);
    if (view === null)
        return { kind: "refused", reason: "view" };
    if (view.origin !== viewOrigin)
        return { kind: "foreign", href: view.view, where: view.environment };
    return view.tab === null
        ? { kind: "new-tab" }
        : { kind: "tab", tab: view.tab, view: view.view };
}
/** What the hub opens a tab at or navigates one to on a person's or an
 * app's behalf (C16): an http or https address that is not on a view host
 * (`isViewHost`), or `about:blank`; null for anything else. The page itself
 * may go anywhere it likes, and so may an agent's own browser commands. */
export function navigableAddress(value) {
    if (value === "about:blank")
        return value;
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") &&
            !isViewHost(url.hostname)
            ? url.href
            : null;
    }
    catch {
        return null;
    }
}
// ---- Language (C17) -----------------------------------------------------------
/** The languages the Environment browser's surfaces speak. */
export const surfaceLanguages = Object.freeze([
    "cs",
    "en",
]);
/** One of these languages, or null. */
export function surfaceLanguageOf(value) {
    return value === "cs" || value === "en" ? value : null;
}
/** The browser's language (`navigator.language`) as a surface speaks it:
 * Czech for a Czech one, English otherwise. Root decision 0191 point 33
 * gives every surface the shell's language and the browser's only to one
 * shown on its own; a framed view still takes it until the identity answer
 * carries the shell's (F50 point 8, phase 3). */
export function browserLanguage(language) {
    return language.toLowerCase().startsWith("cs") ? "cs" : "en";
}
