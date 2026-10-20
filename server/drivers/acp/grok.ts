// Grok Build: the official `grok` CLI over ACP stdio (`grok … agent stdio`) on the grok.com
// subscription login (~/.grok/auth.json), not the xAI API key. Verified against grok 1.0.0.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { harnessHome } from "../../env-path.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { AcpQuestionRequest } from "./question-requests.ts";
import { MAX_QUESTIONS, parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById, repeatsQuestionText } from "../../../shared/ask-question.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** `$GROK_HOME`, else `~/.grok`: Grok's sign-in, config and catalog. */
export function grokHome(env: Record<string, string | undefined> = process.env): string {
  return env.GROK_HOME || harnessHome("grok", env);
}

export function grokSignedIn(env: Record<string, string | undefined>): boolean {
  return existsSync(join(grokHome(env), "auth.json"));
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, which `grok -m <slug>` accepts, plus the cloud defaults. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return slug;
}

/** Grok 1.0.25 consumes native image blocks but advertises image:false; other versions negotiate. */
export function grokAcceptsUnadvertisedImages(init: unknown): boolean {
  const meta = (init as { _meta?: { grokShell?: unknown; agentVersion?: unknown } } | null)?._meta;
  if (meta?.grokShell !== true || typeof meta.agentVersion !== "string") return false;
  const version = /^1\.0\.(\d+)$/.exec(meta.agentVersion);
  return Boolean(version && Number(version[1]) >= 25);
}

/** Grok's `ask_user_question` blocks its turn on this extension request (xai-org/grok-build ask_user_question/types.rs);
 * ACP's Rust SDK adds the `_` prefix on the wire. Answers are keyed by Grok's question text, one label per pick; own
 * words ride as "Other" with the text in annotations[].notes. */
export const GROK_ASK_USER_QUESTION: AcpQuestionRequest = {
  cancelled: { outcome: "cancelled" },
  parse(params) {
    const raw = (params as { questions?: unknown } | null)?.questions;
    // Refused whole: answering only the first ones would read the rest as accepted.
    if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return null;
    // The index is the id, so each card question maps back to Grok's exact text; `multi_select` is its model-facing name.
    const parsed = parseProtocolAskQuestions(raw.map((entry, index) =>
      entry && typeof entry === "object"
        ? { ...entry, id: String(index), multiSelect: entry.multiSelect === true || entry.multi_select === true }
        : entry));
    if (!parsed || repeatsQuestionText(parsed)) return null;
    return {
      questions: parsed.map(({ question }) => question),
      answered(message) {
        const byId = questionAnswersById(message, parsed);
        // Null prototype: a question text such as __proto__ is a real key.
        const answers: Record<string, string[]> = Object.create(null);
        const annotations: Record<string, { notes: string }> = Object.create(null);
        for (const { id, question } of parsed) {
          const reply = byId[id];
          if (reply === undefined) continue;
          const text = (raw[Number(id)] as { question: string }).question;
          const { labels, other } = pickedOptionLabels(reply, question);
          answers[text] = other === undefined ? labels : [...labels, "Other"];
          if (other !== undefined) annotations[text] = { notes: other };
        }
        if (!Object.keys(answers).length) return null;
        return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
      },
    };
  },
};

const support: AcpSupport = {
  driverKind: "grokAgent",
  questionRequests: {
    "_x.ai/ask_user_question": GROK_ASK_USER_QUESTION,
    "x.ai/ask_user_question": GROK_ASK_USER_QUESTION,
  },
  displayName: "Grok",
  images: true,
  acceptsUnadvertisedImages: grokAcceptsUnadvertisedImages,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's levels vary by model and the CLI validates lazily (a rejected level only logs); grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok is not signed in to your grok.com account — run grok login on this computer",

  // No Windows one-liner: the installer is a POSIX shell script.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },

  // With the instance HOME/GROK_HOME: ensureGrokInjectSlug defaults to process.env.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is global; -m and --reasoning-effort only apply between `agent` and `stdio`
  // (Grok 1.0.6; -m first is taken as a TUI option and ignored). Auto selects Grok's native
  // classifier, never bypassPermissions. xai-org/grok-build@37949780 crates/codegen/xai-grok-pager-bin/src/main.rs:1259-1273.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto
      ? "bypassPermissions"
      : turn.approvalMode === "auto" ? "auto" : turn.approvalMode === "edits" ? "acceptEdits" : "default",
    "agent",
    ...(turn.model ? ["-m", turn.model] : []),
    // Long form: `--effort` is only an alias.
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  // -m on argv is not enough: session/new still starts on [models].default.
  async configureSession({ request, sessionId, turn }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      throw new Error(
        `Grok rejected model "${turn.model}" via session/set_model: ${(e as Error).message}. ` +
          `Check that grok is current (1.0.6+ supports it) and that this slug exists in ~/.grok/config.toml.`,
      );
    }
  },

  // A leaked API key silently flips the grok.com subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },

  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: (env) => grokSignedIn(env),

  // `--append-system-prompt`/`--rules` do not reach the agent-stdio system prompt (1.0.0).
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
