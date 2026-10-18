import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { startControlPlaneStub } from "./testing/control-plane-stub.ts";
import { freePortBlock } from "./testing/ports.ts";
import {
  cleanupTunnelOrigin,
  createTunnelOrigin,
  describeTunnelState,
  fleetAccess,
  fleetCredential,
  guardianEntry,
  prepareEntry,
  startTunnel,
} from "./tunnel.ts";

const posix = process.platform !== "win32";

describe("where the pieces are", () => {
  it("prefers the bundled guardian and downloader", () => {
    const bundled = mkdtempSync(join(tmpdir(), "omb-tunnel-bundled-"));
    try {
      expect(guardianEntry(bundled)).toBeNull();
      writeFileSync(join(bundled, "tunnel-guardian.js"), "");
      expect(guardianEntry(bundled)).toBe(join(bundled, "tunnel-guardian.js"));
      expect(prepareEntry(bundled)).toMatch(/scripts[\\/]prepare-cloudflared\.mjs$/);
      writeFileSync(join(bundled, "prepare-cloudflared.js"), "");
      expect(prepareEntry(bundled)).toBe(join(bundled, "prepare-cloudflared.js"));
    } finally {
      void removeTempDir(bundled);
    }
    expect(guardianEntry()).toMatch(/managed-companion-guardian-main\.mjs$/);
  });

  it("describes tunnel states in one line each", () => {
    expect(describeTunnelState({ status: "starting", ready: false }, "https://c-1.example")).toBe("tunnel: connecting…");
    expect(describeTunnelState({ status: "ready", ready: true }, "https://c-1.example")).toBe("tunnel: live at https://c-1.example");
    expect(describeTunnelState({ status: "retrying", ready: false, error: "The secure connection could not be verified.", retryInMs: 4000 }, "x")).toBe(
      "tunnel: The secure connection could not be verified. retrying in 4s",
    );
    expect(describeTunnelState({ status: "unavailable", ready: false, error: "no connector" }, "x")).toBe("tunnel: no connector");
  });
});

describe.skipIf(!posix)("startTunnel: guardian, gateway and connector, verified through the gateway", () => {
  it("forwards the public address to the harness socket (no peer address = remote) and tears everything down on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-tunnel-run-"));
    const origin = createTunnelOrigin();
    const pidFile = join(dir, "connector.pid");
    const fake = join(dir, "cloudflared");
    writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`, { mode: 0o755 });
    const harness = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "openmausbot", url: req.url, peer: req.socket.remoteAddress ?? null }));
    });
    await new Promise<void>((done) => harness.listen(origin.socketPath, done));
    const originPort = await freePortBlock([0], 29_600);
    const endpoint = "https://c-stub.openmausbot.invalid";
    const guardian = guardianEntry();
    expect(guardian).toBeTruthy();
    const states: string[] = [];
    const tunnel = startTunnel({
      dataDir: dir,
      access: { endpoint, token: `connector-${"t".repeat(60)}` },
      originTarget: { pid: process.pid, socketPath: origin.socketPath },
      binaryPath: fake,
      guardian: guardian ?? "",
      env: { ...process.env, OMB_TUNNEL_ORIGIN_PORT: String(originPort) },
      fetchImpl: (input, init) => fetch(String(input).replace(endpoint, `http://127.0.0.1:${originPort}`), init),
      onState: (state) => states.push(state.status),
    });
    try {
      const settled = await tunnel.started;
      expect(settled.status, states.join(",")).toBe("ready");
      const viaGateway: any = await (await fetch(`http://127.0.0.1:${originPort}/api/health`)).json();
      expect(viaGateway.app).toBe("openmausbot");
      expect(viaGateway.peer).toBeNull();
      // the connector is spawned right after the gateway binds; its shell writes the pid a moment later
      const connectorPidOtherThan = async (previous: number) => {
        let pid = 0;
        for (let tries = 0; tries < 50 && (!pid || pid === previous); tries += 1) {
          pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
          if (!pid || pid === previous) await new Promise((r) => setTimeout(r, 100));
        }
        return pid === previous ? 0 : pid;
      };
      const firstPid = await connectorPidOtherThan(0);
      expect(firstPid).toBeGreaterThan(0);
      expect((await tunnel.restart({ endpoint, token: `connector-${"t".repeat(60)}` })).status).toBe("ready");
      expect(Number(readFileSync(pidFile, "utf8").trim())).toBe(firstPid);
      expect((await tunnel.restart({ endpoint, token: `connector-${"u".repeat(60)}` })).status).toBe("ready");
      const connectorPid = await connectorPidOtherThan(firstPid);
      expect(connectorPid).toBeGreaterThan(0);
      expect(() => process.kill(firstPid, 0)).toThrow();
      await tunnel.stop();
      expect(tunnel.state().status).toBe("stopped");
      await new Promise((r) => setTimeout(r, 300));
      expect(() => process.kill(connectorPid, 0)).toThrow();
      await expect(fetch(`http://127.0.0.1:${originPort}/api/health`)).rejects.toThrow();
    } finally {
      await tunnel.stop().catch(() => undefined);
      harness.close();
      cleanupTunnelOrigin(origin);
      await removeTempDir(dir);
    }
  }, 30_000);
});

describe("a fleet's credential in the environment", () => {
  it("gets the public address with no account file and no emailed code; a rejected credential is a clear error", async () => {
    const stub = await startControlPlaneStub();
    try {
      const env = { ...process.env, OMB_CONTROL_PLANE_URL: stub.url };
      expect(fleetCredential({})).toBeNull();
      expect(fleetCredential({ OMB_INSTALLATION_CREDENTIAL: "   " })).toBeNull();
      const credential = stub.seedInstallation("boat-1");
      expect(fleetCredential({ OMB_INSTALLATION_CREDENTIAL: ` ${credential} ` })).toBe(credential);
      const access = await fleetAccess({ credential, env, version: "9.8.7" });
      expect(access).toEqual({ endpoint: stub.endpointUrl, token: stub.connectorToken });
      expect(stub.calls).toContain("POST /v1/installations/self/endpoint");
      // The fleet created the installation without a version; the endpoint request reports this server's release.
      expect([...stub.installations.values()].find((inst) => inst.credential === credential)?.appVersion).toBe("9.8.7");
      expect(stub.calls.some((call) => call.includes("/api/auth/"))).toBe(false);
      await expect(fleetAccess({ credential: `omb_install_${"x".repeat(22)}.${"y".repeat(43)}`, env })).rejects.toThrow(/rejected/);
      await expect(fleetAccess({ credential, env: { ...env, OMB_CONTROL_PLANE_URL: "ftp://nope" } })).rejects.toThrow(/OMB_CONTROL_PLANE_URL/);
    } finally {
      await stub.close();
    }
  });
});
