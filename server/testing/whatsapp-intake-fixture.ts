// Lazurio overlay: the WhatsApp intake in the isolated verification server
// (scripts/control-omb.ts). Security invariant: a fixture runs it only on the
// fake wacli and test files its caller hands over, never on the launcher's own
// OMB_WHATSAPP_INTAKE* settings, which on a configured Environment are the live
// ones. Nothing outside the temporary folder is accepted and no store is
// passed; wacli v0.25.1 keeps its default store under the home, which in a
// fixture is its own, so even a real wacli would find no pairing there.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

export interface WhatsappIntakeFixture {
  /** An executable fake wacli the caller wrote. */
  wacli: string;
  bot: string;
  /** The group map, with its notes next to it. */
  groups: string;
  operator: string;
  bundle: string;
}

function underTemp(path: string, temp: string): boolean {
  if (!isAbsolute(path)) return false;
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return false;
  }
  const rel = relative(temp, real);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The intake's settings for a fixture server; throws for a path that does not lead into the temporary folder. */
export function whatsappIntakeFixtureEnvironment(fixture: WhatsappIntakeFixture): Record<string, string> {
  const temp = realpathSync.native(tmpdir());
  for (const [name, path] of Object.entries({ wacli: fixture.wacli, groups: fixture.groups, bundle: fixture.bundle })) {
    if (!underTemp(path, temp)) throw new Error(`the WhatsApp intake fixture takes only test files under ${temp}, so not the ${name} "${path}"`);
  }
  return {
    OMB_WHATSAPP_INTAKE: "1",
    OMB_WHATSAPP_INTAKE_BOT: fixture.bot,
    OMB_WHATSAPP_INTAKE_GROUPS: fixture.groups,
    OMB_WHATSAPP_INTAKE_OPERATOR: fixture.operator,
    OMB_WHATSAPP_INTAKE_BUNDLE: fixture.bundle,
    OMB_WHATSAPP_INTAKE_WACLI: fixture.wacli,
  };
}
