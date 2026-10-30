// The WhatsApp intake's output contract and the guards that turn a reply into a
// draft. Every name, login and chat id here is synthetic; the bundle and the
// other client's note next to it are temporary files.
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { GroupMap, WhatsappGroup } from "./whatsapp-intake-config.ts";
import {
  commercialKinds, foreignLinks, mentionsOtherClient, otherClientTerms, parseRunOutput, rateViolations, sendGuards, toolViolations,
  type GuardInput, type RunCapture,
} from "./whatsapp-intake-guards.ts";

const ROOT = mkdtempSync(join(tmpdir(), "omb-whatsapp-guards-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const BUNDLE = join(ROOT, "bundle");
const OTHER_NOTE = join(ROOT, "notes", "b.md");
mkdirSync(join(BUNDLE, "guides"), { recursive: true });
mkdirSync(join(ROOT, "notes"));
for (const file of ["a.md", "guide.md", join("guides", "start.md")]) writeFileSync(join(BUNDLE, file), "# Integrace\n");
writeFileSync(OTHER_NOTE, "Note of group B: never for group A.");

function group(chat: string, key: string, name: string, clientNames: string[], owners: string[]): WhatsappGroup {
  return { chat, key, name, mode: "auto", note: `/srv/support/notes/${key}.md`, address: "vy", clientNames, owners };
}

const A = group("120363000000000001@g.us", "a", "Group A", ["Contoso"], ["contoso-labs"]);
const B = group("120363000000000002@g.us", "b", "Group B", ["Fabrikam Česko"], ["fabrikam-ltd"]);
const MAP: GroupMap = {
  groups: [A, B],
  team: ["15550000003@s.whatsapp.net"],
  allowedLinks: ["https://github.com/example-provider/handbook", "https://www.example.test/help"],
  environmentDomains: ["lazurio.io"],
};
const CLEAN: RunCapture = { provider: "claudeAgent", tools: [{ name: "Read", input: JSON.stringify({ file_path: `${BUNDLE}/guide.md` }) }] };

function input(reply: string, overrides: Partial<GuardInput> = {}): GuardInput {
  const output = parseRunOutput(JSON.stringify({ action: "reply", reply, reply_to: "m1", commitment: false, confidence: "high" }))!;
  return {
    group: A, map: MAP, reply, output, capture: CLEAN, bundle: BUNDLE, sent: { groupLastHour: 0, groupLastDay: 0, allLastDay: 0 }, paused: false,
    ...overrides,
  };
}

describe("parseRunOutput", () => {
  it("reads the contract, also inside a code fence or after a sentence", () => {
    const body = { action: "reply_and_escalate", reply: " Dobrý den ", reply_to: "m1", escalation: { urgency: "high", summary: "s", next_step: "n" }, commitment: false, confidence: "medium", sources: ["a.md"], digest_line: "d" };
    expect(parseRunOutput(JSON.stringify(body))).toMatchObject({ action: "reply_and_escalate", reply: "Dobrý den", confidence: "medium", commitment: false, escalation: { urgency: "high" } });
    expect(parseRunOutput("```json\n" + JSON.stringify(body) + "\n```")?.action).toBe("reply_and_escalate");
    expect(parseRunOutput("Here it is: " + JSON.stringify(body))?.reply).toBe("Dobrý den");
  });

  it("is null for anything but the contract, a field it does not know included", () => {
    expect(parseRunOutput("Sure, I will answer them.")).toBeNull();
    expect(parseRunOutput("{not json}")).toBeNull();
    expect(parseRunOutput(JSON.stringify({ action: "send_to_group_b", reply: "x" }))).toBeNull();
    expect(parseRunOutput(JSON.stringify({ action: "reply", reply: "x", commitment: false, confidence: "high", to: "Group B" }))).toBeNull();
    expect(parseRunOutput(JSON.stringify({ action: "escalate", escalation: { urgency: "high", summary: "s", next_step: "n", notify: "Group B" } }))).toBeNull();
    expect(parseRunOutput(undefined)).toBeNull();
  });

  it("fails closed on a missing or odd confidence and commitment", () => {
    expect(parseRunOutput(JSON.stringify({ action: "reply", reply: "x" }))).toMatchObject({ confidence: "low", commitment: true });
    expect(parseRunOutput(JSON.stringify({ action: "reply", reply: "x", confidence: "high" }))).toMatchObject({ confidence: "high", commitment: true });
    expect(parseRunOutput(JSON.stringify({ action: "reply", reply: "x", confidence: "very high", commitment: "maybe" }))).toMatchObject({ confidence: "low", commitment: true });
    expect(parseRunOutput(JSON.stringify({ action: "reply", reply: "x", confidence: "High", commitment: "false" }))).toMatchObject({ confidence: "high", commitment: false });
  });
});

describe("the commercial guard", () => {
  it("catches prices, discounts, contracts, invoices, deadlines and SLAs in Czech and English", () => {
    expect(commercialKinds("Cena za Prostředí je 4 900 Kč měsíčně.")).toEqual(expect.arrayContaining(["price"]));
    expect(commercialKinds("It costs 120 EUR")).toContain("price");
    expect(commercialKinds("Dáme vám slevu 20 %.")).toContain("discount");
    expect(commercialKinds("To je ve smlouvě.")).toContain("contract");
    expect(commercialKinds("Fakturu pošleme zítra.")).toContain("invoice");
    expect(commercialKinds("Hotové to bude do pátku.")).toContain("deadline");
    expect(commercialKinds("Termín vydání potvrdí kolega.")).toContain("deadline");
    expect(commercialKinds("We guarantee 99.9% uptime under the SLA.")).toEqual(expect.arrayContaining(["deadline", "sla"]));
  });

  it("leaves ordinary support answers alone", () => {
    expect(commercialKinds("Otevřete Nastavení, v nabídce vyberte Integrace a klikněte na Připojit.")).toEqual([]);
    expect(commercialKinds("Disk je plný z 90 procent, smažte staré soubory.")).toEqual([]);
    expect(commercialKinds("Restartujte Prostředí a zkuste to znovu.")).toEqual([]);
  });
});

describe("the cross-client guard", () => {
  it("names every other group, client and owner login, less what this group shares", () => {
    expect(otherClientTerms(A, MAP)).toEqual(["group b", "fabrikam cesko", "fabrikam-ltd"]);
    const shared = { ...MAP, groups: [A, { ...B, clientNames: ["Contoso", "Fabrikam Česko"] }] };
    expect(otherClientTerms(A, shared)).not.toContain("contoso");
  });

  it("matches whole words, without case or diacritics", () => {
    const terms = otherClientTerms(A, MAP);
    expect(mentionsOtherClient("U FABRIKAM CESKO to fungovalo.", terms)).toBe(true);
    expect(mentionsOtherClient("Viz github.com/fabrikam-ltd/app", terms)).toBe(true);
    expect(mentionsOtherClient("Jak to řešila group   B?", terms)).toBe(true);
    expect(mentionsOtherClient("Contoso má vše v pořádku.", terms)).toBe(false);
    expect(mentionsOtherClient("fabrikamovi", terms)).toBe(false);
  });

  it("flags repository and Environment links outside the allowed prefixes", () => {
    expect(foreignLinks("Návod: https://github.com/example-provider/handbook/blob/main/start.md", MAP)).toEqual([]);
    expect(foreignLinks("Viz https://www.example.test/help#prihlaseni a https://lazurio.io/.", MAP)).toEqual([]);
    expect(foreignLinks("Viz https://github.com/example-provider/handbook-internal", MAP)).toEqual(["https://github.com/example-provider/handbook-internal"]);
    expect(foreignLinks("Repo je github.com/someone/private-app.", MAP)).toEqual(["github.com/someone/private-app"]);
    expect(foreignLinks("Otevřete https://launchpad.vm1.someorg.lazurio.io/settings", MAP)).toHaveLength(1);
    expect(foreignLinks("Odkaz http://gitlab.com/x/y", MAP)).toHaveLength(1);
  });
});

describe("the tool-log guard", () => {
  const read = (path: string) => ({ name: "Read", input: JSON.stringify({ file_path: path }) });

  it("lets read-only file tools inside the bundle pass", () => {
    expect(toolViolations({ provider: "claudeAgent", tools: [read(`${BUNDLE}/a.md`), { name: "TodoWrite" }] }, BUNDLE, undefined)).toEqual([]);
    expect(toolViolations({ provider: "claudeAgent", tools: [{ name: "Grep", input: JSON.stringify({ pattern: "Prostředí" }) }] }, BUNDLE, BUNDLE)).toEqual([]);
    expect(toolViolations({ provider: "claudeAgent", tools: [{ name: "Glob", input: JSON.stringify({ pattern: "**/*.md", path: `${BUNDLE}/guides` }) }] }, BUNDLE, undefined)).toEqual([]);
    expect(toolViolations({ provider: "claudeAgent", tools: [] }, BUNDLE, undefined)).toEqual([]);
  });

  it("catches a shell, gh, wacli, any other tool and reads outside the bundle", () => {
    const check = (tools: RunCapture["tools"], cwd?: string) => toolViolations({ provider: "claudeAgent", tools }, BUNDLE, cwd);
    expect(check([{ name: "Bash", summary: "gh repo list some-client" }])).toEqual(["tools:gh"]);
    expect(check([{ name: "Bash", summary: "wacli messages list --chat 120363000000000002@g.us" }])).toEqual(["tools:wacli"]);
    expect(check([{ name: "Bash", summary: "cat notes.md" }])).toEqual(["tools:shell"]);
    expect(check([read("/etc/hosts")])).toEqual(["tools:read_outside"]);
    expect(check([read(`${BUNDLE}/../notes/b.md`)])).toEqual(["tools:read_outside"]);
    expect(check([read("~")])).toEqual(["tools:read_outside"]);
    expect(check([{ name: "Grep", input: JSON.stringify({ pattern: "x" }) }], homedir())).toEqual(["tools:read_outside"]);
    expect(check([{ name: "Glob", input: JSON.stringify({ pattern: "../**/*.md", path: BUNDLE }) }])).toEqual(["tools:read_unverified"]);
    expect(check([{ name: "Read", input: "{\"file_path\": \"[redacted]\"}" }])).toEqual(["tools:read_unverified"]);
    expect(check([{ name: "mcp__agents__post_to_room", input: "{}" }])).toEqual(["tools:mcp__agents__post_to_room"]);
    expect(check([{ name: "WebFetch", input: JSON.stringify({ url: "https://example.test" }) }])).toEqual(["tools:WebFetch"]);
  });

  it("cannot vouch for an engine that does not report its tool calls, or a run it did not see start", () => {
    expect(toolViolations({ provider: "piAgent", tools: [] }, BUNDLE, undefined)).toEqual(["no_tool_log"]);
    expect(toolViolations({ tools: [] }, BUNDLE, undefined)).toEqual(["no_tool_log"]);
    expect(toolViolations({ provider: "mixed", tools: [] }, BUNDLE, undefined)).toEqual(["no_tool_log"]);
  });
});

describe.skipIf(process.platform === "win32")("the tool-log guard and links", () => {
  const read = (path: string) => ({ name: "Read", input: JSON.stringify({ file_path: path }) });
  const grep = (path?: string) => ({ name: "Grep", input: JSON.stringify({ pattern: "Note", ...(path ? { path } : {}) }) });
  const check = (tools: RunCapture["tools"], bundle: string) => toolViolations({ provider: "claudeAgent", tools }, bundle, bundle);
  const bundle = (name: string) => {
    const dir = join(ROOT, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "guide.md"), "# Integrace\n");
    return dir;
  };

  it("reads the file a link leads to, so another client's note behind a link in the bundle is a read outside", () => {
    const linked = bundle("file-link");
    symlinkSync(OTHER_NOTE, join(linked, "faq.md"));
    expect(check([read(join(linked, "faq.md"))], linked)).toEqual(["tools:read_outside"]);
    expect(check([read("faq.md")], linked)).toEqual(["tools:read_outside"]);
    expect(check([read(join(linked, "guide.md"))], linked)).toEqual([]);
  });

  it("follows a linked folder, and cannot vouch for a search that could enter it", () => {
    const linked = bundle("folder-link");
    symlinkSync(join(ROOT, "notes"), join(linked, "shared"));
    writeFileSync(join(ROOT, "guide.md"), "Another client's guide.");
    expect(check([read(join(linked, "shared", "b.md"))], linked)).toEqual(["tools:read_outside"]);
    expect(check([read(`${linked}/shared/../guide.md`)], linked)).toEqual(["tools:read_outside"]);
    for (const search of [grep(), grep(linked), { name: "Glob", input: JSON.stringify({ pattern: "**/*.md", path: linked }) }, { name: "LS", input: JSON.stringify({ path: linked }) }]) {
      expect(check([search], linked), search.input).toEqual(["tools:read_unverified"]);
    }
    expect(check([read(join(linked, "guide.md"))], linked)).toEqual([]);
  });

  it("cannot vouch for a dangling link, a missing file or a file with another hard link", () => {
    const dangling = bundle("dangling-link");
    symlinkSync(join(ROOT, "gone.md"), join(dangling, "gone.md"));
    expect(check([grep()], dangling)).toEqual(["tools:read_unverified"]);
    expect(check([read(join(dangling, "gone.md"))], dangling)).toEqual(["tools:read_unverified"]);
    expect(check([read(join(dangling, "missing.md"))], dangling)).toEqual(["tools:read_unverified"]);
    const hard = bundle("hard-link");
    linkSync(OTHER_NOTE, join(hard, "faq.md"));
    expect(check([read(join(hard, "faq.md"))], hard)).toEqual(["tools:read_unverified"]);
    expect(check([grep()], hard)).toEqual(["tools:read_unverified"]);
  });

  it("lets links that stay inside the bundle pass", () => {
    const inner = bundle("inner-link");
    mkdirSync(join(inner, "guides"));
    symlinkSync(join(inner, "guide.md"), join(inner, "guides", "start.md"));
    symlinkSync(join(inner, "guides"), join(inner, "návody"));
    expect(check([read(join(inner, "návody", "start.md")), grep(), grep(join(inner, "návody"))], inner)).toEqual([]);
  });
});

describe("the rate guard", () => {
  it("stops at 6 an hour and 30 a day per group, and 80 a day overall", () => {
    expect(rateViolations({ groupLastHour: 5, groupLastDay: 29, allLastDay: 79 })).toEqual([]);
    expect(rateViolations({ groupLastHour: 6, groupLastDay: 6, allLastDay: 6 })).toEqual(["rate:hour"]);
    expect(rateViolations({ groupLastHour: 0, groupLastDay: 30, allLastDay: 30 })).toEqual(["rate:day"]);
    expect(rateViolations({ groupLastHour: 0, groupLastDay: 0, allLastDay: 80 })).toEqual(["rate:all"]);
  });
});

describe("sendGuards", () => {
  it("passes a clean, confident answer that read only the bundle", () => {
    expect(sendGuards(input("Dobrý den, otevřete Nastavení → Integrace a klikněte na Připojit."))).toEqual([]);
  });

  it("collects every reason at once", () => {
    const output = parseRunOutput(JSON.stringify({ action: "reply", reply: "x", commitment: true, confidence: "low" }))!;
    const reasons = sendGuards(input("U Fabrikam Česko to stojí 100 EUR, viz https://github.com/fabrikam-ltd/app", {
      output, paused: true, capture: { provider: "claudeAgent", tools: [{ name: "Bash", summary: "gh api user" }] },
      sent: { groupLastHour: 6, groupLastDay: 6, allLastDay: 6 },
    }));
    expect(reasons).toEqual(["paused", "low_confidence", "commitment", "commercial:price", "other_client", "link", "tools:gh", "rate:hour"]);
  });

  it("drafts a reply over 1,200 characters", () => {
    expect(sendGuards(input("a".repeat(1_200)))).toEqual([]);
    expect(sendGuards(input("a".repeat(1_201)))).toEqual(["too_long"]);
  });
});
