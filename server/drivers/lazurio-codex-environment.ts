// Lazurio: Codex follows the Environment's own Codex configuration, as Lazurio's T3 Code does. Lazurio
// Machines write it as Codex's system layer, /etc/codex/config.toml (the Organization's AI pool or gateway).
import type { ModelCatalog } from "../contracts.ts";
import { OFFICIAL_CODEX_PROVIDER } from "./codex-catalog.ts";

/** The model provider of the Environment's Codex configuration. Codex routes a bare model id to it
 * without a `modelProvider` override and runs without a `codex login`. */
export interface CodexEnvironmentProvider {
  provider: string;
  /** The effective configuration's `model`, the default of new bots; null when it names none. */
  model: string | null;
}

const MODEL_ID = /^[\w][\w./:+-]{0,255}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/i;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** From the answers of `config/read` and `account/read` on one app-server. codex-cli 0.163.0 names the
 * layer of each effective key in `origins` (with or without `includeLayers`) and sets
 * `requiresOpenaiAuth` from the effective provider's `requires_openai_auth`. Only a provider other than
 * `openai` that the system layer sets and that needs no OpenAI sign-in counts. The person's own
 * ~/.codex/config.toml (`user`), a project's `.codex`, `-c` flags and managed layers keep today's
 * routing, where a bare id is official and goes to `openai`, so a local provider such as oMLX never
 * takes an official model; so does any answer this cannot read. */
export function codexEnvironmentProvider(configRead: unknown, accountRead: unknown): CodexEnvironmentProvider | null {
  const answer = record(configRead);
  const config = record(answer?.config);
  const provider = config?.model_provider;
  const layer = record(record(record(answer?.origins)?.model_provider)?.name)?.type;
  if (typeof provider !== "string" || !PROVIDER_ID.test(provider) || provider === OFFICIAL_CODEX_PROVIDER) return null;
  if (layer !== "system" || record(accountRead)?.requiresOpenaiAuth !== false) return null;
  const model = config?.model;
  return { provider, model: typeof model === "string" && MODEL_ID.test(model) ? model : null };
}

/** Codex's catalog with the configuration's model as its default, listed even when model/list lacks it. */
export function codexEnvironmentCatalog(catalog: ModelCatalog, environment: CodexEnvironmentProvider | null | undefined): ModelCatalog {
  const model = environment?.model;
  if (!model) return catalog;
  return {
    default: model,
    options: catalog.options.some((option) => option.id === model) ? catalog.options : [{ id: model, label: model }, ...catalog.options],
  };
}
