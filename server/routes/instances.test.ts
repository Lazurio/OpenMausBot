// An install changes what an engine reports: the next engine list probes its CLI again.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { json, readBody } from "../harness/http.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const fake = makeFakeDriver();
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ a: { driver: "fake" } });
  const installs: string[] = [];
  Object.assign(registry.get("a")!, { installRuntime: async () => { installs.push("a"); } });
  const deps = {
    store: { bots: [], tasks: () => [] },
    cfg: { instances: { a: { driver: "fake" } } } as unknown as AppConfig,
    registry,
    hostedModels: false,
    providerConfigBusy: { get: () => false, set: () => {} },
    providerInstancesChanging: new Set<string>(),
    describeInstances: () => registry.describe(),
    threadBusy: () => false,
    botForThread: () => null,
    activeGroupTurnForBot: () => null,
  } as unknown as InstanceRouteDeps;
  const routes = [createInstanceRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await send(method, path, body);
    expect(response.status, `${method} ${path}`).toBe(200);
    return response.json() as Promise<any>;
  };
  const probesAfterList = async () => {
    await call("GET", "/api/instances");
    return fake.probes.length;
  };
  return { installs, send, call, probesAfterList };
}

describe("engine routes", () => {
  it("probe the engine again after an install", async () => {
    const { installs, call, probesAfterList } = await serve();
    expect(await probesAfterList()).toBe(1);
    expect(await probesAfterList()).toBe(1);

    await call("POST", "/api/instances/a/install", {});
    expect(installs).toEqual(["a"]);
    expect(await probesAfterList()).toBe(2);
  });

  it("offer no engine sign-in of their own", async () => {
    const { send } = await serve();
    for (const [method, path] of [["GET", "/api/instances/a/auth/status?flowId=flow-1"], ["POST", "/api/instances/a/auth/start"],
      ["POST", "/api/instances/a/auth/complete"], ["POST", "/api/instances/a/auth/cancel"], ["POST", "/api/instances/a/auth/sign-out"]] as const) {
      const response = await send(method, path, method === "GET" ? undefined : {});
      expect(await response.json(), `${method} ${path}`).toEqual({ from: "inline routes" });
    }
  });
});
