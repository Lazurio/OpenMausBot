// BM25 ranking of a tool list, for the agents bridge's own find tool.
// Lazurio overlay (DEV-6673 M3): the search_tools/describe_tool/call_tool directory over big MCP catalogs is removed
// with MausBot's own connected apps and MCP server registry; only the ranker stays.
type Json = Record<string, unknown>;

export interface CatalogTool {
  name: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cut(text: string, chars: number): string {
  const kept = text.slice(0, Math.max(0, chars));
  const last = kept.charCodeAt(kept.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept;
}

// Pydantic and FastMCP keep a tool's real fields in `$defs` behind local `$ref`s; only those are followed, never a URL.

function resolveRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try { key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return undefined; }
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const STOP_WORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "for", "from", "had", "has", "have", "having", "he", "her",
  "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "many", "me",
  "might", "more", "most", "much", "must", "my", "need", "no", "not", "of", "on", "or", "our", "ours",
  "please", "she", "should", "so", "some", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "those", "to", "too", "us", "very", "want", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "whose", "why", "will", "with", "would", "you", "your", "yours",
]);

export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 4 && /(?:[sxz]|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word && (word.length > 1 || !/^[a-z0-9]$/.test(word)) && !STOP_WORDS.has(word))
    .map((word) => /^[a-z0-9]+$/.test(word) ? stem(word) : word);
}

const SCHEMA_TEXT_CHARS = 4_000;
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

export function schemaText(schema: unknown, maxChars = SCHEMA_TEXT_CHARS): string {
  let text = "";
  const followed = new Set<string>();
  const add = (part: unknown) => {
    if ((typeof part === "string" || typeof part === "number") && text.length < maxChars) text = `${text} ${cut(String(part), maxChars - text.length)}`;
  };
  const visit = (node: unknown, depth: number) => {
    if (!isRecord(node) || depth > 8 || text.length >= maxChars) return;
    if (typeof node.$ref === "string" && !followed.has(node.$ref)) {
      followed.add(node.$ref);
      visit(resolveRef(schema, node.$ref), depth + 1);
    }
    add(node.description);
    if (Array.isArray(node.enum)) for (const value of node.enum) add(value);
    add(node.const);
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        add(key);
        visit(child, depth + 1);
      }
    }
    visit(node.items, depth + 1);
    visit(node.additionalProperties, depth + 1);
    for (const list of SUBSCHEMA_LISTS) if (Array.isArray(node[list])) for (const child of node[list]) visit(child, depth + 1);
  };
  visit(schema, 0);
  return text.trim();
}

export function toolArea(name: string): string {
  const prefix = name.slice(0, Math.max(0, name.indexOf("_")));
  if (prefix.trim()) return cut(prefix.toLowerCase(), 40);
  const head = name.split(/[\s_./:-]+/).find(Boolean) ?? name;
  const word = /^[A-Z]?[a-z0-9]+|^[A-Z]+(?![a-z])/.exec(head)?.[0] ?? head;
  return cut(word.toLowerCase(), 40);
}

export type ToolRanker = (query: string, tools: readonly CatalogTool[], limit: number) => readonly CatalogTool[] | Promise<readonly CatalogTool[]>;

const K1 = 1.2;
const B = 0.75;
const FIELD_WEIGHTS = { name: 2, text: 1, schema: 0.5 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];
const AREA_WEIGHT = FIELD_WEIGHTS.name;
const LIST_INTENT = new Set(["who", "which", "what", "show", "list", "recent", "newest", "latest", "all"]);
const LIST_WEIGHT = 0.5;

function counted(text: string): { counts: Map<string, number>; length: number } {
  const counts = new Map<string, number>();
  const words = terms(text);
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return { counts, length: words.length };
}

function fields(tool: CatalogTool): Record<Field, { counts: Map<string, number>; length: number }> {
  const text = [tool.title, tool.description].filter((part): part is string => typeof part === "string").join(" ");
  return {
    name: counted(tool.name),
    text: counted(text),
    schema: counted(schemaText(tool.inputSchema)),
  };
}

function lists(name: { counts: Map<string, number> }, description: unknown): boolean {
  return name.counts.has("list") || (typeof description === "string" && terms(description.slice(0, 40))[0] === "list");
}

const rarity = (total: number, holding: number) => Math.log(1 + (total - holding + 0.5) / (holding + 0.5));
const saturated = (tf: number) => (tf * (K1 + 1)) / (tf + K1);

function byName(a: CatalogTool, b: CatalogTool): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export const bm25Ranker: ToolRanker = (query, tools, limit) => {
  const wanted = [...new Set(terms(query))];
  const exact = query.trim().toLowerCase();
  const listing = !wanted.includes("list") && query.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => LIST_INTENT.has(word));
  const docs = tools.map((tool) => {
    const parts = fields(tool);
    return { tool, fields: parts, area: counted(toolArea(tool.name)), lists: lists(parts.name, tool.description) };
  });
  const average = Object.fromEntries(FIELDS.map((field) =>
    [field, docs.reduce((sum, doc) => sum + doc.fields[field].length, 0) / Math.max(1, docs.length) || 1])) as Record<Field, number>;
  const averageArea = docs.reduce((sum, doc) => sum + doc.area.length, 0) / Math.max(1, docs.length) || 1;
  const df = new Map<string, number>();
  const areaDf = new Map<string, number>();
  for (const doc of docs) {
    for (const term of wanted) {
      if (FIELDS.some((field) => doc.fields[field].counts.has(term))) df.set(term, (df.get(term) ?? 0) + 1);
      if (doc.area.counts.has(term)) areaDf.set(term, (areaDf.get(term) ?? 0) + 1);
    }
  }
  const listRarity = rarity(docs.length, docs.filter((doc) => doc.lists).length);
  const scored: Array<{ tool: CatalogTool; score: number }> = [];
  for (const doc of docs) {
    let score = doc.tool.name.toLowerCase() === exact ? 1_000 : 0;
    for (const term of wanted) {
      let tf = 0;
      for (const field of FIELDS) {
        const { counts, length } = doc.fields[field];
        const count = counts.get(term);
        if (count) tf += (FIELD_WEIGHTS[field] * count) / (1 - B + (B * length) / average[field]);
      }
      if (tf) score += rarity(docs.length, df.get(term) ?? 0) * saturated(tf);
      const inArea = doc.area.counts.get(term);
      if (inArea) score += rarity(docs.length, areaDf.get(term) ?? 0) * saturated((AREA_WEIGHT * inArea) / (1 - B + (B * doc.area.length) / averageArea));
    }
    if (score > 0 && listing && doc.lists) score += LIST_WEIGHT * listRarity;
    if (score > 0) scored.push({ tool: doc.tool, score });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.tool, b.tool));
  return scored.slice(0, limit).map((entry) => entry.tool);
};

