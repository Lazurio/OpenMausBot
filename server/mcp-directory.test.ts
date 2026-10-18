import { describe, expect, it } from "vitest";

import { bm25Ranker, schemaText, stem, terms, toolArea, type CatalogTool } from "./mcp-directory.ts";

const tool = (name: string, description = "", inputSchema: unknown = { type: "object" }): CatalogTool => ({ name, description, inputSchema });

describe("BM25 ranking", () => {
  it("stems queries and tools the same way", () => {
    expect(stem("payments")).toBe(stem("payment"));
    expect(stem("listing")).toBe(stem("list"));
    expect(stem("updated")).toBe(stem("update"));
    expect(stem("companies")).toBe(stem("company"));
    expect(stem("statuses")).toBe(stem("status"));
    expect(terms("listPayments for the company_id")).toEqual(["list", "payment", "company", "id"]);
  });

  it("drops the words a request is phrased with, and keeps words in any script", () => {
    expect(terms("Which payments failed this month? How much revenue is there?")).toEqual(["payment", "fail", "month", stem("revenue")]);
    expect(terms("Список платежей · 支払い 一覧 · facturaciónMensual")).toEqual(["список", "платежей", "支払い", "一覧", "facturación", "mensual"]);
  });

  it("keeps words whole that carry combining marks, and normalizes what looks alike", () => {
    expect(terms("भुगतान सूची")).toEqual(["भुगतान", "सूची"]);
    // one Thai word, in its normalized form (NFKC splits SARA AM in two)
    expect(terms("การชำระเงิน")).toEqual(["การชำระเงิน".normalize("NFKC")]);
    expect(terms("cafe\u0301 menu")).toEqual(["café", "menu"]);
    expect(terms("ｐａｙｍｅｎｔｓ")).toEqual(["payment"]);
  });

  it("matches a word however its accents were typed", async () => {
    const tools = [tool("menus_get", "Gets the café menu."), tool("menus_list", "Lists menus.")];
    expect((await bm25Ranker("cafe\u0301", tools, 2)).map((entry) => entry.name)).toEqual(["menus_get"]);
    const hindi = [tool("bhugtan_list", "भुगतान सूची"), tool("bhugtan_get", "एक भुगतान")];
    expect((await bm25Ranker("सूची", hindi, 2)).map((entry) => entry.name)).toEqual(["bhugtan_list"]);
  });

  it("finds tools described in other scripts", async () => {
    const tools = [tool("platezhi_list", "Список платежей компании."), tool("shiharai_list", "支払い 一覧"), tool("payments_list", "Lists payments.")];
    expect((await bm25Ranker("платежей", tools, 3)).map((entry) => entry.name)).toEqual(["platezhi_list"]);
    expect((await bm25Ranker("支払い", tools, 3)).map((entry) => entry.name)).toEqual(["shiharai_list"]);
  });

  it("puts an exact tool name first and breaks ties by name", async () => {
    const names = [tool("payments_list", "Lists payments."), tool("payments_list_refunded", "Lists refunded payments."), tool("refunds_list", "Lists refunds.")];
    expect((await bm25Ranker("payments_list_refunded", names, 3))[0].name).toBe("payments_list_refunded");
    const twins = [tool("zeta_read", "Read the notes"), tool("alpha_read", "Read the notes")];
    expect((await bm25Ranker("notes", twins, 2)).map((entry) => entry.name)).toEqual(["alpha_read", "zeta_read"]);
  });

  it("names a tool's area by its prefix before the first underscore", () => {
    expect(toolArea("payments_list")).toBe("payments");
    expect(toolArea("promo-codes_create")).toBe("promo-codes");
    expect(toolArea("accounts_update-fees")).toBe("accounts");
    expect(toolArea("getUser")).toBe("get");
    expect(toolArea("_private_tool")).toBe("private");
  });

  it("puts the tools of an area a request names above tools that only mention it", async () => {
    const tools = [
      tool("payments_summary", "Summarizes."),
      tool("ledgers_payment", "Gets the ledger entry of a payment, with the payment's amount and the payment's date."),
      ...Array.from({ length: 20 }, (_, index) => tool(`area${index}_get`, `Gets item ${index} and its payment.`)),
    ];
    expect((await bm25Ranker("payments", tools, 3))[0].name).toBe("payments_summary");
    const areas = [tool("promo-codes_list", "Lists them."), tool("promo-banners_list", "Lists them."), tool("codes_list", "Lists them.")];
    expect((await bm25Ranker("promo codes", areas, 3))[0].name).toBe("promo-codes_list");
  });

  it("lifts listing tools a little when the request asks what there is", async () => {
    const tools = [tool("members_list", "Lists members."), tool("members_ban", "Bans a member."), tool("notes_get", "Gets a note.")];
    expect((await bm25Ranker("members", tools, 3)).map((entry) => entry.name)).toEqual(["members_ban", "members_list"]);
    for (const query of ["which members", "who are the members", "show members", "newest members", "all members"]) {
      expect((await bm25Ranker(query, tools, 3))[0].name).toBe("members_list");
    }
    const described = [tool("members_roster", "Lists the members of a company."), tool("members_ban", "Bans a member.")];
    expect((await bm25Ranker("which members", described, 2))[0].name).toBe("members_roster");
    expect((await bm25Ranker("which member should I ban", tools, 3))[0].name).toBe("members_ban");
  });

  it("counts a schema's words, at less weight than a name's or a description's", async () => {
    const said = tool("widgets_report", "Reports revenue for widgets.");
    const offered = tool("gizmos_get", "Gets one gizmo.", { type: "object", properties: { metric: { type: "string", enum: ["revenue", "units"] } } });
    expect((await bm25Ranker("revenue", [offered, said], 8)).map((entry) => entry.name)).toEqual(["widgets_report", "gizmos_get"]);
    const long = tool("payments_list", "Lists payments.", { type: "object", properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field_${index}`, { type: "string", description: "A filter." }])) });
    const short = tool("payments_archive", "Archives payments so they leave lists.");
    expect((await bm25Ranker("list payments", [short, long], 8))[0].name).toBe("payments_list");
  });

  it("reads property names, enum values and descriptions from a schema, bounded", () => {
    expect(schemaText({ type: "object", description: "Root.", properties: {
      metric: { type: "string", description: "What to total.", enum: ["net_revenue", "fees"] },
      filters: { type: "object", properties: { status: { type: "array", items: { enum: ["failed"] } } } },
      choice: { anyOf: [{ const: "this_week" }] },
    } })).toBe("Root. metric What to total. net_revenue fees filters status failed choice this_week");
    expect(schemaText({ type: "object", properties: { big: { description: "x".repeat(10_000) } } }).length).toBeLessThanOrEqual(4_001);
  });
});

describe("schemas that keep their fields in $defs", () => {
  const defs = {
    PaymentFilters: { type: "object", properties: { status: { type: "string", enum: ["failed", "paid"] }, created_after: { type: "string", format: "date-time" } }, required: ["status"] },
    Cursor: { type: "object", properties: { after: { type: "string" } } },
    Tree: { type: "object", properties: { label: { type: "string", enum: ["leaf"] }, children: { type: "array", items: { $ref: "#/$defs/Tree" } } } },
  };
  /** The shape Pydantic and FastMCP write. */
  const pydantic = {
    type: "object",
    properties: {
      params: { $ref: "#/$defs/PaymentFilters" },
      cursor: { anyOf: [{ $ref: "#/$defs/Cursor" }, { type: "null" }], default: null },
    },
    required: ["params"],
    $defs: defs,
  };

  it("reads the words its definitions hold, each once, never in a circle", () => {
    expect(schemaText(pydantic)).toBe("params status failed paid created_after cursor after");
    expect(schemaText({ type: "object", properties: { root: { $ref: "#/$defs/Tree" } }, $defs: defs }).match(/leaf/g)).toHaveLength(1);
    expect(schemaText({ $ref: "#" })).toBe("");
    expect(schemaText({ type: "object", properties: { x: { $ref: "https://example.test/remote.json" } } })).toBe("x");
    expect(schemaText({ type: "object", definitions: { Old: { enum: ["legacy"] } }, properties: { x: { $ref: "#/definitions/Old" } } })).toBe("x legacy");
  });

  it("ranks a tool on the words its definitions hold", async () => {
    const tools = [tool("payments_list", "Lists payments.", pydantic), tool("payouts_list", "Lists payouts.")];
    expect((await bm25Ranker("failed", tools, 2)).map((entry) => entry.name)).toEqual(["payments_list"]);
  });
});
