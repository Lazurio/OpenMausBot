/** The approval levels exposed by the app. Each one is a provider's own
 * permission mode, passed through: OpenMausBot never decides a permission
 * itself (Full access aside, which answers residual prompts because that is
 * what the person granted). The order is the order the selector shows.
 * Lazurio overlay (DEV-6673): the four runtime modes of Lazurio's T3 Code
 * (approval-required, auto-accept-edits, auto, full-access); upstream's
 * Custom (Codex's own config.toml, entered only from the desktop app) is
 * removed with its desktop grant. */
export const APPROVAL_MODES = ["ask", "edits", "auto", "full"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Only providers with an implemented permission mapping may expose a level.
 * `edits` (auto-accept edits) exists where the engine has such a mode:
 * Claude and Grok `acceptEdits`, Antigravity `auto_edit`, Qwen `auto-edit`,
 * Gemini `auto_edit`. Codex's Ask already runs `workspace-write`, so an edits
 * level would change nothing there. Full access, the default level, runs on
 * every engine: in the engine's own most permissive mode, or, where it has
 * none, with the harness answering the permission requests it leaves (the
 * chat-completions family, ACP agents such as Kimi or Hermes, Pi's computer
 * confirms). */
export function supportsApprovalMode(driverKind: string | undefined, mode: ApprovalMode): boolean {
  if (mode === "edits") return ["claudeAgent", "grokAgent", "antigravityAgent", "qwenAgent", "geminiAgent"].includes(driverKind ?? "");
  return true;
}

/** Whether switching engines must first drop this level to Ask. Full
 * carries silently to any engine; Auto-accept edits stops at an engine
 * without it.
 * Adapted from tahodev's provider-switch guard. */
export function modelSwitchNeedsAsk(
  mode: ApprovalMode,
  _fromDriver: string | undefined,
  toDriver: string | undefined,
): boolean {
  return !supportsApprovalMode(toDriver, mode);
}

export function hasNativeAutoReview(driverKind: string | undefined): boolean {
  // Qwen Code's `--approval-mode auto` is an LLM classifier that approves
  // safe actions and blocks risky ones — a reviewer, not a rubber stamp.
  return ["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"].includes(driverKind ?? "");
}

const APPROVAL_RANK: Record<ApprovalMode, number> = { ask: 0, edits: 1, auto: 2, full: 3 };

export interface ApprovalFields {
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

export function threadApproval(thread: ApprovalFields, bot: ApprovalFields): ApprovalFields {
  return {
    approvalMode: thread.approvalMode ?? (thread.autoApprove === undefined ? bot.approvalMode : undefined),
    autoApprove: thread.autoApprove ?? bot.autoApprove,
    alwaysAllow: structuredClone(thread.alwaysAllow ?? bot.alwaysAllow),
  };
}

export function approvalModeWidens(from: ApprovalMode, to: ApprovalMode): boolean {
  return APPROVAL_RANK[to] > APPROVAL_RANK[from];
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** The level a bot or conversation runs at until a person picks one: Full
 * access, as in t3code (its DEFAULT_RUNTIME_MODE). Each provider maps it to
 * its own most permissive mode; a real question or a missing credential
 * still reaches a person. Lazurio overlay (DEV-6673): on every server,
 * hosted workspaces included; nothing lowers it for a person. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "full";

/** An unset level runs at the default, the pre-approvalMode Auto bit reads as
 * safe Auto, and an unknown persisted value fails closed to Ask. */
export function approvalModeFor(bot: {
  approvalMode?: unknown;
  autoApprove?: unknown;
}): ApprovalMode {
  if (isApprovalMode(bot.approvalMode)) return bot.approvalMode;
  if (bot.autoApprove === true) return "auto";
  return bot.approvalMode === undefined ? DEFAULT_APPROVAL_MODE : "ask";
}
