export function engineInvocation(codex, args) {
  const exact = (...expected) => JSON.stringify(args) === JSON.stringify(expected);
  if (exact("--version")) return "version";
  if (codex && exact("login", "status")) return "login-status";
  if (!codex && exact("auth", "status", "--json")) return "auth-status";
  if (!codex && exact("--help")) return "help";
  if (codex && exact("app-server")) return "app-server";
  return args.some((arg) => ["exec", "-p", "--print"].includes(arg)) ? "denied-generation-cli" : "denied-unknown-cli";
}

const discovery = new Set([
  "http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/v1/models/status",
  "http://127.0.0.1:11434/v1/models", "http://127.0.0.1:11434/api/ps",
  "http://127.0.0.1:52415/v1/models", "http://127.0.0.1:1234/v1/models",
  "http://127.0.0.1:1234/api/v0/models", "http://127.0.0.1:8888/v1/models",
]);

/** Synthetic discovery never opens a socket; all other candidate fetches fail closed. */
export function migrationFetch(record, healthFetch) {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body ?? (input instanceof Request ? input.body : null);
    if (method === "GET" && body == null && url === "http://127.0.0.1:19971/api/health" && healthFetch) {
      record("fixture-health");
      return healthFetch(input, { ...init, redirect: "error" });
    }
    if (method === "GET" && body == null && url === "https://registry.npmjs.org/@openai/codex/latest") {
      record("synthetic-release-offline");
      return Response.json({}, { status: 503 });
    }
    if (method !== "GET" || body != null || !discovery.has(url)) {
      record("denied-network-request");
      throw new Error("migration-network-request-denied");
    }
    record("synthetic-local-discovery");
    return Response.json({ data: [], models: [] });
  };
}

/** Only fixed error categories and the caller's fixed phase may leave the worker. */
export function migrationDiagnostic(error, phase) {
  const code = error?.code === "ERR_SQLITE_ERROR"
    ? (/locked|busy/i.test(error.message) ? "sqlite-busy" : "sqlite-error")
    : ["ENOENT", "EACCES", "EPERM", "EPIPE"].includes(error?.code) ? error.code.toLowerCase()
      : error instanceof TypeError ? "type-error" : error instanceof SyntaxError ? "syntax-error" : "unknown-error";
  return { phase, code };
}

export function validModelCache(cache) {
  const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
  if (!cache || Object.keys(cache).some((key) => !["default", "options"].includes(key)) || !text(cache.default)
    || !Array.isArray(cache.options) || !cache.options.length || cache.options.length > 1000) return false;
  return cache.options.every((option) => option && text(option.id) && text(option.label)
    && Object.entries(option).every(([key, value]) => ["id", "label"].includes(key) || key === "provider" && text(value)
      || ["custom", "loaded"].includes(key) && typeof value === "boolean"
      || key === "contextWindow" && Number.isSafeInteger(value) && value > 0
      || key === "variants" && Array.isArray(value) && value.length <= 100 && value.every((variant) => variant
        && Object.keys(variant).length === 2 && text(variant.id) && text(variant.label))));
}
