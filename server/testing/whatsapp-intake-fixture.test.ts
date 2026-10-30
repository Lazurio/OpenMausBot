// Lazurio overlay: what of the WhatsApp intake reaches an isolated verification
// server. The launcher's settings below stand for a configured Environment's
// live ones; every chat id is synthetic and every file temporary.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { whatsappIntakeFixtureEnvironment } from "./whatsapp-intake-fixture.ts";

const OPERATOR = "15550000002@s.whatsapp.net";
const dir = mkdtempSync(join(tmpdir(), "omb-whatsapp-fixture-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the WhatsApp intake in a verification fixture", () => {
  it("never inherits the launcher's OMB_WHATSAPP_INTAKE settings", () => {
    const live = {
      OMB_WHATSAPP_INTAKE: "1", OMB_WHATSAPP_INTAKE_BOT: "Support", OMB_WHATSAPP_INTAKE_GROUPS: "/srv/support/groups.json",
      OMB_WHATSAPP_INTAKE_OPERATOR: OPERATOR, OMB_WHATSAPP_INTAKE_BUNDLE: "/srv/support/bundle",
      OMB_WHATSAPP_INTAKE_WACLI: "/usr/local/bin/wacli", OMB_WHATSAPP_INTAKE_STORE: "/srv/support/wacli-store",
    };
    const env = verificationServerEnvironment(live, join(dir, "data"), 9100);
    expect(Object.keys(env).filter((key) => key.startsWith("OMB_WHATSAPP_INTAKE"))).toEqual([]);
  });

  it("runs only on the caller's fake wacli and test files under the temporary folder, and never names a store", () => {
    const wacli = join(dir, "wacli");
    const groups = join(dir, "groups.json");
    const bundle = join(dir, "bundle");
    writeFileSync(wacli, "#!/usr/bin/env node\n");
    chmodSync(wacli, 0o755);
    writeFileSync(groups, "{}");
    mkdirSync(bundle);
    symlinkSync(process.execPath, join(dir, "installed-wacli"));
    const fixture = { wacli, bot: "Support", groups, operator: OPERATOR, bundle };
    expect(whatsappIntakeFixtureEnvironment(fixture)).toEqual({
      OMB_WHATSAPP_INTAKE: "1", OMB_WHATSAPP_INTAKE_BOT: "Support", OMB_WHATSAPP_INTAKE_GROUPS: groups, OMB_WHATSAPP_INTAKE_OPERATOR: OPERATOR,
      OMB_WHATSAPP_INTAKE_BUNDLE: bundle, OMB_WHATSAPP_INTAKE_WACLI: wacli,
    });
    for (const real of ["wacli", process.execPath, join(dir, "installed-wacli"), join(dir, "missing-wacli"), tmpdir()]) {
      expect(() => whatsappIntakeFixtureEnvironment({ ...fixture, wacli: real }), real).toThrow(/takes only test files under/);
    }
    expect(() => whatsappIntakeFixtureEnvironment({ ...fixture, groups: join(process.cwd(), "package.json") })).toThrow(/the groups/);
    expect(() => whatsappIntakeFixtureEnvironment({ ...fixture, bundle: process.cwd() })).toThrow(/the bundle/);
  });
});
