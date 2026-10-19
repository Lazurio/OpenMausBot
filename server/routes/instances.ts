import { providerIconError } from "../../shared/provider-icon.ts";
import { updateClaudeCli } from "../claude-update.ts";
import { persistableInstanceConfigs, saveConfig, withInstanceCli, type AppConfig } from "../config.ts";
import { addEndpoint, addEndpointSchema, isAddedEndpoint, withEndpointUrls } from "../openai-compat-endpoints.ts";
import type { InstanceConfigMap, ModelSelection } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { findCliCandidates, resetPathCache } from "../env-path.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { checkEngine } from "../engine-check.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { instanceSettingsSchema } from "../instance-settings.ts";
import { providerIconPatchSchema, withInstanceIcon } from "../provider-icon.ts";
import type { Store } from "../store.ts";
import type { BusyFlag, ConfigStatus } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InstanceRouteDeps {
  store: Pick<Store, "bots" | "tasks">;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "refreshModels" | "installRuntime" | "cliTarget" | "forgetSnapshots">;
  hostedModels: boolean;
  providerConfigBusy: BusyFlag;
  providerInstancesChanging: Pick<Set<string>, "add" | "delete">;
  describeInstances(): Promise<unknown>;
  persistProviderInstance(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  testCliBinary(cli: string, driver: (typeof BUILT_IN_DRIVERS)[number] | undefined): Promise<unknown>;
  cliProbeEnvironment(): NodeJS.ProcessEnv;
  threadBusy(botId: string, threadId: string): boolean;
  botForThread(botId: string, threadId: string): Pick<{ modelSelection: ModelSelection }, "modelSelection"> | null;
  activeGroupTurnForBot(botId: string): { threadId: string } | null;
}

export function createInstanceRoutes(deps: InstanceRouteDeps): RouteHandler {
  const {
    store, cfg, registry, hostedModels, providerConfigBusy, providerInstancesChanging,
    persistProviderInstance, configStatus, broadcast, testCliBinary, cliProbeEnvironment, threadBusy,
    botForThread, activeGroupTurnForBot,
  } = deps;
  const describeInstances = async () => hostedModels ? deps.describeInstances() : withEndpointUrls(await deps.describeInstances(), cfg.instances ?? {});
  // One updater per executable: Claude instances can share an install, and two self-updates would race its files.
  const claudeUpdatesInFlight = new Set<string>();
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/instances") {
      // Rescan PATH: Windows never pushes PATH changes into a live process, so a CLI installed since launch stays invisible.
      resetPathCache();
      return json(res, 200, { instances: await describeInstances() });
    }
    const companyMutation = /^\/api\/instances\/(company\.[\w.-]+)(?:\/|$)/.exec(path);
    if (hostedModels && path.startsWith("/api/instances/") && method !== "GET") return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });
    if (companyMutation && method !== "GET") return json(res, 403, { error: "Company accounts are read-only here. Manage this connection in desktop Settings." });

    const instanceIconPatch = /^\/api\/instances\/([\w.-]+)\/icon$/.exec(path);
    if (method === "PATCH" && instanceIconPatch) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        return json(res, 400, { error: detail && detail !== "Invalid input" ? detail : "Choose a built-in icon or upload a PNG, JPEG, or WebP image up to 128 KB." });
      }
      if (parsed.data.icon) {
        const invalid = providerIconError(parsed.data.icon);
        if (invalid) return json(res, 400, { error: invalid });
      }
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const changed = withInstanceIcon(cfg, instanceIconPatch[1], parsed.data.icon);
        if (!changed.ok) return json(res, 404, { error: `unknown instance "${instanceIconPatch[1]}"` });
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        broadcast({ kind: "config", ...configStatus() });
        return json(res, 200, { instances: await describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    if (method === "POST" && path === "/api/instances/openai-compat") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = addEndpointSchema.safeParse(await readBody(req, 8192));
      if (!parsed.success) return json(res, 400, { error: "Enter a display name (up to 80 characters), a base URL and an API key." });
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const instances = persistableInstanceConfigs(cfg);
        const added = addEndpoint(instances, parsed.data);
        if ("error" in added) return json(res, 400, { error: added.error });
        await persistProviderInstance(added.instanceId, instances);
        return json(res, 201, { instanceId: added.instanceId, instances: await describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|install|check)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      try {
        if (action === "check") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          res.setHeader("cache-control", "no-store");
          return json(res, 200, await checkEngine(instance));
        }
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) return json(res, 404, { error: "unknown instance" });
          return json(res, 200, { instances: await describeInstances() });
        }
        if (!(await registry.installRuntime(instanceId))) return json(res, 404, { error: "Installing this engine from Settings is not available on this server. Use the install command on the machine running OpenMausBot." });
        return json(res, 200, { instances: await describeInstances() });
      } catch (error) {
        const requestedStatus = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
        const status = typeof requestedStatus === "number" && [400, 401, 404, 409, 413, 415].includes(requestedStatus) ? requestedStatus : 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // ?name=claude → every `claude` on the augmented PATH, in PATH order (first = what a bare name runs).
    if (method === "GET" && path === "/api/cli-candidates") {
      const name = url.searchParams.get("name") ?? "";
      resetPathCache();
      return json(res, 200, { candidates: findCliCandidates(name) });
    }

    // POST {cli, driver} → spawn `<cli> --version` with the PATH a turn would use.
    if (method === "POST" && path === "/api/cli-test") {
      // JSON-only: this executes a local binary, so a hostile page must not send it as a simple cross-origin request.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
      if (!cli || /[\n\r]/.test(cli)) return json(res, 400, { error: "cli must be a non-empty path" });
      const driver = typeof body?.driver === "string" ? BUILT_IN_DRIVERS.find((d) => d.driverKind === body.driver) : undefined;
      // testCliBinary uses a credential-redacted environment, so wrapper arguments cannot read inherited secrets.
      const probe = await testCliBinary(cli, driver);
      return json(res, 200, probe);
    }

    // No command or path comes from the request: the registry supplies this instance's executable. JSON-only.
    const busyProviderSelections = () => store.bots.flatMap((bot) => {
      const busyTasks = store.tasks(bot.id).filter((task) => threadBusy(bot.id, task.threadId));
      const selections = busyTasks.map((task) => botForThread(bot.id, task.threadId)!.modelSelection);
      if (activeGroupTurnForBot(bot.id) || (bot.busy && busyTasks.length === 0)) selections.push(bot.modelSelection);
      return selections;
    });
    const claudeUpdate = /^\/api\/instances\/([\w.-]+)\/claude-update$/.exec(path);
    if (method === "POST" && claudeUpdate) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      const target = registry.cliTarget(claudeUpdate[1]);
      if (!target) return json(res, 404, { error: "no such provider instance" });
      if (target.driverKind !== "claudeAgent") {
        return json(res, 400, { error: "only Claude Code instances can be updated here" });
      }
      if (!target.cli) return json(res, 409, { error: "this Claude instance has no configured executable" });
      if (claudeUpdatesInFlight.has(target.cli)) {
        return json(res, 409, { error: "this Claude installation is already updating" });
      }
      const active = busyProviderSelections().some((selection) => registry.cliTarget(selection.instanceId)?.cli === target.cli);
      if (active) {
        return json(res, 409, { error: "wait for running Claude tasks to finish before updating" });
      }

      claudeUpdatesInFlight.add(target.cli);
      try {
        const result = await updateClaudeCli(target.cli, cliProbeEnvironment());
        resetPathCache();
        return json(res, 200, { ok: true, version: result.version });
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        claudeUpdatesInFlight.delete(target.cli);
        // Even a failed update may have replaced the executable.
        registry.forgetSnapshots();
      }
    }

    // PATCH /api/instances/:id {cli: "/path/to/cli" | ""}: "" reverts to the driver default.
    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      // JSON-only, so a hostile page cannot send it as a simple request.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = instanceSettingsSchema.safeParse(await readBody(req, 16384));
      if (!parsed.success) return json(res, 400, { error: "Supply a valid CLI path or boolean tools setting." });
      const body = parsed.data;
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      if (busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Wait for bots using this account to finish before changing its settings." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        const result = body.cli === undefined ? { ok: true, config: cfg } : withInstanceCli(cfg, instanceId, body.cli);
        const instances = persistableInstanceConfigs(result.config);
        if (!result.ok || !Object.hasOwn(instances, instanceId)) return json(res, 404, { error: `unknown instance "${instanceId}"` });
        const entry = instances[instanceId];
        if (body.tools !== undefined) {
          if (!["openai-compat", "grok", "minimax", "mistral", "cerebras", "groq", "meta"].includes(entry.driver)) {
            return json(res, 400, { error: "The tools setting is available for OpenAI-compatible, Grok API, MiniMax API, Mistral API, Cerebras API, Groq API and Meta API instances only." });
          }
          entry.config = { ...entry.config as Record<string, unknown>, tools: body.tools };
        }
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }

    if (method === "DELETE" && instancePatch) {
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      const instances = persistableInstanceConfigs(cfg);
      if (!Object.hasOwn(instances, instanceId)) return json(res, 404, { error: "unknown instance" });
      if (!isAddedEndpoint(instanceId, instances[instanceId])) {
        return json(res, 400, { error: "Only added OpenAI-compatible endpoints can be removed here." });
      }
      if (cfg.defaultModelSelection?.instanceId === instanceId || store.bots.some((bot) =>
        bot.modelSelection.instanceId === instanceId || bot.fallback?.some(candidate => candidate.instanceId === instanceId) || store.tasks(bot.id).some((task) => task.modelSelection?.instanceId === instanceId)) ||
        busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Choose another account for the bots and default model using this account before removing it." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        delete instances[instanceId];
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }
    return PASS;
  };
}
