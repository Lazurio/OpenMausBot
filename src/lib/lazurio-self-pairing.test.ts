// Lazurio overlay (pair straight in): a Launchpad link opens the app for a connected browser, and the Environment
// pairs a browser its gateway let in; anything else keeps the pairing page as it is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enterFromPairLink, fetchSelfPairingCode, selfPair, SELF_PAIRING_PATH } from "./lazurio-self-pairing";
import { defaultDeviceLabel } from "./session";

const LINK_CODE = "ABCD-EFGH-JK23";
const SELF_CODE = "QRST-UVWX-YZ79";
const SESSION = { kind: "session", id: "s", label: "Chrome on Mac", scopes: ["client"], expiresAt: 1 };
const UNAUTHENTICATED: [number, unknown] = [401, { error: "unauthorized" }];

type Answer = Response | Error;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = () => new Response("<!doctype html><html><body><div id=\"root\"></div></body></html>", { status: 200, headers: { "content-type": "text/html" } });

let calls: Array<{ path: string; init?: RequestInit }>;
function server(answers: { session: [number, unknown]; pairing?: () => Answer; pair?: [number, unknown] }): typeof fetch {
  return (async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === "/api/auth/session") return json(...answers.session);
    if (path === SELF_PAIRING_PATH) {
      const answer = answers.pairing?.() ?? json(404, { error: "not found" });
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path === "/api/auth/pair") return json(...(answers.pair ?? [200, { session: {} }]));
    throw new Error(`unexpected ${path}`);
  }) as unknown as typeof fetch;
}
const pairedCodes = () => calls.filter((c) => c.path === "/api/auth/pair").map((c) => JSON.parse(String(c.init?.body)).code);
const askedForCode = () => calls.some((c) => c.path === SELF_PAIRING_PATH);

let address: string[];
function open(href: string) {
  const url = new URL(href, "https://mausbot.example.test");
  const loc = { pathname: url.pathname, search: url.search, hash: url.hash };
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", {
    replaceState: (_: unknown, __: string, next: string) => {
      const moved = new URL(next, "https://mausbot.example.test");
      Object.assign(loc, { pathname: moved.pathname, search: moved.search, hash: moved.hash });
      address.push(next);
    },
  });
  return loc;
}

beforeEach(() => { calls = []; address = []; });
afterEach(() => vi.unstubAllGlobals());

describe("a Launchpad link to /pair", () => {
  it("opens the app at once for a connected browser, with the link's code unused and gone from the address bar", async () => {
    const loc = open(`/pair#code=${LINK_CODE}`);
    expect(await enterFromPairLink(server({ session: [200, SESSION] }))).toEqual({ app: true });
    expect(pairedCodes()).toEqual([]);
    expect(askedForCode()).toBe(false);
    expect(address).toEqual(["/pair", "/"]);
    expect(loc).toEqual({ pathname: "/", search: "", hash: "" });
  });

  it("opens the app on the page pairing would reach, for an owner's loopback too", async () => {
    open(`/pair?desktop-settings=phone#code=${LINK_CODE}`);
    expect(await enterFromPairLink(server({ session: [200, { kind: "loopback" }] }))).toEqual({ app: true });
    expect(pairedCodes()).toEqual([]);
    expect(address.at(-1)).toBe("/?desktop-settings=phone");
  });

  it("pairs a signed-out browser with the Environment's code rather than the link's, and opens the app", async () => {
    open(`/pair#code=${LINK_CODE}`);
    const fetchImpl = server({ session: UNAUTHENTICATED, pairing: () => json(200, { kind: "mausbot-pairing", code: SELF_CODE }) });
    expect(await enterFromPairLink(fetchImpl)).toEqual({ app: true });
    expect(calls.find((c) => c.path === SELF_PAIRING_PATH)?.init).toEqual({ credentials: "same-origin" });
    const pair = calls.find((c) => c.path === "/api/auth/pair");
    expect(JSON.parse(String(pair?.init?.body))).toEqual(expect.objectContaining({ code: SELF_CODE, label: defaultDeviceLabel(), cookie: true }));
    expect(pairedCodes()).toEqual([SELF_CODE]);
    expect(address).toEqual(["/pair", "/"]);
  });

  it("keeps the pairing page with the link's code when the server does not trust this computer as its owner, asking nothing", async () => {
    open(`/pair#code=${LINK_CODE}`);
    expect(await enterFromPairLink(server({ session: [200, { kind: "loopback", trust: "service" }] }))).toEqual({ app: false, initialCode: LINK_CODE });
    expect(askedForCode()).toBe(false);
    expect(pairedCodes()).toEqual([]);
    expect(address).toEqual(["/pair"]);
  });

  it("keeps the pairing page with the link's code when the server cannot be reached", async () => {
    open(`/pair#code=${LINK_CODE}`);
    expect(await enterFromPairLink(server({ session: [502, { error: "bad gateway" }] }))).toEqual({ app: false, initialCode: LINK_CODE });
    expect(askedForCode()).toBe(false);
  });
});

const refusals: Array<[string, () => Answer]> = [
  ["a plain OpenMausBot's own page", page],
  ["404", () => json(404, { error: "not found" })],
  ["403 for a request that is not the page's own", () => json(403, { error: "forbidden" })],
  ["405", () => json(405, { error: "method not allowed" })],
  ["409", () => json(409, { error: "conflict" })],
  ["a network error", () => new Error("offline")],
  ["a body that is not JSON", () => new Response("XXXX-XXXX-XXXX", { status: 200 })],
  ["another kind", () => json(200, { kind: "t3code-pairing", code: SELF_CODE })],
  ["no kind", () => json(200, { code: SELF_CODE })],
  ["a code that is not a string", () => json(200, { kind: "mausbot-pairing", code: 42 })],
  ["a code without its groups", () => json(200, { kind: "mausbot-pairing", code: SELF_CODE.replace(/-/g, "") })],
  ["a lowercase code", () => json(200, { kind: "mausbot-pairing", code: SELF_CODE.toLowerCase() })],
  ["a code with characters the server never uses", () => json(200, { kind: "mausbot-pairing", code: "ABCD-EFGH-JK10" })],
  ["a code with more around it", () => json(200, { kind: "mausbot-pairing", code: ` ${SELF_CODE}` })],
  ["a JSON array", () => json(200, [SELF_CODE])],
];

describe("an answer that is not the Environment's pairing code", () => {
  it.each(refusals)("keeps the pairing page with the link's code: %s", async (_, answer) => {
    open(`/pair#code=${LINK_CODE}`);
    expect(await enterFromPairLink(server({ session: UNAUTHENTICATED, pairing: answer }))).toEqual({ app: false, initialCode: LINK_CODE });
    expect(pairedCodes()).toEqual([]);
    expect(address).toEqual(["/pair"]);
  });

  it.each(refusals)("pairs nothing from the app's address: %s", async (_, answer) => {
    expect(await fetchSelfPairingCode(server({ session: UNAUTHENTICATED, pairing: answer }))).toBeNull();
    expect(await selfPair(server({ session: UNAUTHENTICATED, pairing: answer }))).toBe(false);
    expect(pairedCodes()).toEqual([]);
  });

  it("keeps the pairing page when the server refuses the Environment's code", async () => {
    open(`/pair#code=${LINK_CODE}`);
    const fetchImpl = server({ session: UNAUTHENTICATED, pairing: () => json(200, { kind: "mausbot-pairing", code: SELF_CODE }), pair: [401, { error: "expired" }] });
    expect(await enterFromPairLink(fetchImpl)).toEqual({ app: false, initialCode: LINK_CODE });
    expect(pairedCodes()).toEqual([SELF_CODE]);
    expect(address).toEqual(["/pair"]);
  });
});

it("the app's address pairs a signed-out browser with the Environment's code", async () => {
  expect(await selfPair(server({ session: UNAUTHENTICATED, pairing: () => json(200, { kind: "mausbot-pairing", code: SELF_CODE, expiresAt: 1 }) }))).toBe(true);
  expect(pairedCodes()).toEqual([SELF_CODE]);
});

it("a conversation's address keeps the person's target: the Environment pairs the browser there and the address stays", async () => {
  const loc = open("/c/8b1b1d62-9d3c-4a1e-9f2a-3c5d7e9b1a04");
  expect(await selfPair(server({ session: UNAUTHENTICATED, pairing: () => json(200, { kind: "mausbot-pairing", code: SELF_CODE }) }))).toBe(true);
  expect(pairedCodes()).toEqual([SELF_CODE]);
  expect(address).toEqual([]);
  expect(loc.pathname).toBe("/c/8b1b1d62-9d3c-4a1e-9f2a-3c5d7e9b1a04");
});
