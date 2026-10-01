// Lazurio MausBot: Full access over the API, as an operator opt-in.
//
// Upstream lets Full (and Custom) be chosen only from the packaged desktop
// app, over a private process channel: a headless server trusts every
// loopback request as its owner, so any local process could otherwise raise
// a bot to Full. On a Lazurio Environment the Machine, with its one
// operator, is the boundary, and bot teams run without a sandbox there
// (Lazurio decision, issue #3). OMB_HEADLESS_FULL_ACCESS=1 at server start
// lets the loopback owner make exactly that change through the ordinary bot
// PATCH: entering Full from Ask, Edits or Auto. Custom, and leaving Custom,
// stay desktop-only. Full then means what it means on the desktop; nothing
// here changes how a provider runs a Full turn.
//
// Contract: server/headless-full-access.test.ts and its e2e test. Off unless
// set; upstream behaviour is otherwise unchanged.
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { RequestAuth } from "./request-auth.ts";

/** Whether the operator started the server with the opt-in. Unset, empty,
 * `0` or `false`: off. `1` or `true`: on. Anything else stops the server at
 * start. The desktop app keeps its own confirmation, so the opt-in is off
 * there, like upstream's shared-workspace Full access policy. */
export function headlessFullAccessFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.OMB_HEADLESS_FULL_ACCESS ?? "").trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false") return false;
  if (flag !== "1" && flag !== "true") {
    throw new Error(`OMB_HEADLESS_FULL_ACCESS must be 1 to allow Full access over the API, got "${env.OMB_HEADLESS_FULL_ACCESS}"`);
  }
  return env.OMB_DESKTOP_PARENT !== "1";
}

/** Whether a bot PATCH that upstream reserves for the desktop may go through:
 * the opt-in is on, the caller is the owner on loopback, and the change
 * enters Full from anything but Custom. */
export function headlessFullAccessPermits(input: {
  enabled: boolean;
  auth: RequestAuth;
  current: ApprovalMode;
  requested: ApprovalMode;
}): boolean {
  return input.enabled && input.auth.kind === "loopback" && input.auth.trust === undefined &&
    input.requested === "full" && input.current !== "custom";
}
