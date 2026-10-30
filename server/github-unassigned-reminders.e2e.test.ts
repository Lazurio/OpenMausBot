import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

describe.skipIf(process.platform === "win32")("unassigned reminders in an isolated server", () => {
  it("discovers an unrequested PR, posts once, and remains idle on the next poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-reminders-e2e-"));
    const gh = join(dir, "gh"); const comment = join(dir, "comment.json");
    const script = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[3]; const url = new URL(path, "https://api.github.test");
const page = Number(url.searchParams.get("page") || 1);
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const pr = {number: 42, title: "Change", html_url: "https://github.test/acme/app/pull/42", state: "open", draft: false, assignees: [], user: {login: "alice", id: 11}, head: {sha: "a".repeat(40)}};
if (url.pathname === "/user") out({login: "henry", id: 12});
if (url.pathname === "/search/issues") out({items: []});
if (url.pathname === "/user/repos") out(page === 1 ? [{full_name: "acme/app", archived: false, permissions: {push: true}}] : []);
if (url.pathname === "/repos/acme/app/pulls") out(page === 1 ? [pr] : []);
if (url.pathname === "/repos/acme/app/pulls/42") out(pr);
if (url.pathname === "/repos/acme/app/issues/42/comments") {
  if (process.argv.includes("-f")) {
    const body = process.argv[process.argv.indexOf("-f") + 1].slice(5);
    if (fs.existsSync(__COMMENT__)) { process.stderr.write("duplicate post"); process.exit(1); }
    fs.writeFileSync(__COMMENT__, JSON.stringify({user: {id: 12}, body}));
    out(JSON.parse(fs.readFileSync(__COMMENT__, "utf8")));
  }
  out(fs.existsSync(__COMMENT__) ? [JSON.parse(fs.readFileSync(__COMMENT__, "utf8"))] : []);
}
process.stderr.write("unexpected " + path); process.exit(1);
`;
    writeFileSync(gh, script.replaceAll("__COMMENT__", JSON.stringify(comment))); chmodSync(gh, 0o755);
    const server = await launchVerificationServer({ ...process.env, OMB_GITHUB_INTAKE: "1", OMB_GITHUB_INTAKE_BOT: "Henry", OMB_GITHUB_INTAKE_GH: gh, OMB_GITHUB_INTAKE_SCOPE: "requested", OMB_GITHUB_INTAKE_OWNERS: "acme", OMB_GITHUB_INTAKE_EXCLUDE: "", OMB_GITHUB_INTAKE_REMINDER_SIGNATURE: "Pablo" });
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${server.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: server.info.url }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
      return response.json() as Promise<any>;
    };
    try {
      await api("POST", "/api/bots", { name: "Henry", section: "Steward" });
      const first = await api("POST", "/api/github-intake/poll");
      expect(first.summary.state).toBe("ok");
      expect(JSON.parse(readFileSync(comment, "utf8")).body).toContain("— Pablo");
      expect((await api("POST", "/api/github-intake/poll")).summary.state).toBe("ok");
      const state = JSON.parse(readFileSync(join(server.info.dataDir, "github-intake.json.reminders"), "utf8"));
      expect(state.entries["acme/app#42"]).toBe("sent");
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
