// Lazurio MausBot GitHub intake: its settings, read from OMB_GITHUB_INTAKE and
// friends (docs/lazurio-github-intake.md).
import { deploymentReposFromEnv } from "./github-intake-deployments.ts";

export interface GithubIntakeConfig {
  /** Id or exact name (case-insensitive) of the bot that receives the work. */
  bot: string;
  /** requested: review requests and pull requests reviewed before.
   * organization: additionally every ready pull request in pushable repos. */
  scope: "requested" | "organization";
  /** Lowercase owner logins; empty means any. Applies to every trigger. */
  owners: string[];
  /** Lowercase `owner/repo` patterns with `*`, excluded from organization scope. */
  exclude: string[];
  intervalMs: number;
  /** The gh executable (OMB_GITHUB_INTAKE_GH); absent means `gh` on PATH. */
  ghPath?: string;
  /** Explicit activation of assignment-as-completion; existing assignments are not retroactive. */
  assignmentHandoff?: boolean;
  /** Exact lowercase `owner/repo` list whose waiting deployments this account may approve (OMB_GITHUB_INTAKE_DEPLOYMENTS). */
  deployments?: string[];
  /** Attempts per review obligation (OMB_GITHUB_INTAKE_REVIEW_ATTEMPTS); absent means `INTAKE_DEFAULTS`. */
  reviewAttempts?: number;
  /** Minutes an active run may go without a sign of progress (OMB_GITHUB_INTAKE_RUN_IDLE_MINUTES). */
  runIdleMinutes?: number;
  /** Minutes after its start an active run is stopped regardless (OMB_GITHUB_INTAKE_RUN_MAX_MINUTES). */
  runMaxMinutes?: number;
  /** Minutes after which a pull request whose `updated_at` did not change is judged again (OMB_GITHUB_INTAKE_RESETTLE_MINUTES). */
  resettleMinutes?: number;
  /** The GitHub login an escalation comment mentions (OMB_GITHUB_INTAKE_ESCALATE). */
  escalate?: string;
}

type Bounded = "intervalSeconds" | "reviewAttempts" | "runIdleMinutes" | "runMaxMinutes" | "resettleMinutes";
export const INTAKE_DEFAULTS: Record<Bounded, number> = { intervalSeconds: 90, reviewAttempts: 3, runIdleMinutes: 45, runMaxMinutes: 480, resettleMinutes: 30 };
const BOUNDED: Record<Bounded, { variable: string; min: number; max: number }> = {
  intervalSeconds: { variable: "OMB_GITHUB_INTAKE_INTERVAL_SECONDS", min: 30, max: 3_600 },
  reviewAttempts: { variable: "OMB_GITHUB_INTAKE_REVIEW_ATTEMPTS", min: 1, max: 5 },
  runIdleMinutes: { variable: "OMB_GITHUB_INTAKE_RUN_IDLE_MINUTES", min: 15, max: 240 },
  runMaxMinutes: { variable: "OMB_GITHUB_INTAKE_RUN_MAX_MINUTES", min: 60, max: 1_440 },
  resettleMinutes: { variable: "OMB_GITHUB_INTAKE_RESETTLE_MINUTES", min: 5, max: 1_440 },
};

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[a-z0-9*][a-z0-9*-]{0,38}\/[a-z0-9._*-]{1,100}$/;

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/** A whole number clamped to its bounds; undefined when unset. */
function bounded(env: NodeJS.ProcessEnv, field: Bounded): number | undefined {
  const { variable, min, max } = BOUNDED[field];
  const raw = (env[variable] ?? "").trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${variable} must be a whole number${field === "intervalSeconds" ? " of seconds" : ""}, got "${raw}"`);
  return Math.min(max, Math.max(min, Number(raw)));
}

/** OMB_GITHUB_INTAKE and friends. Unset (or 0/false) keeps the intake off;
 * a value the server does not understand stops it at start with the reason. */
export function githubIntakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GithubIntakeConfig | null {
  const flag = (env.OMB_GITHUB_INTAKE ?? "").trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false") return null;
  if (flag !== "1" && flag !== "true") throw new Error(`OMB_GITHUB_INTAKE must be 1 to enable the GitHub intake, got "${env.OMB_GITHUB_INTAKE}"`);
  const bot = (env.OMB_GITHUB_INTAKE_BOT ?? "").trim();
  if (!bot) throw new Error("OMB_GITHUB_INTAKE=1 needs OMB_GITHUB_INTAKE_BOT: the id or exact name of the bot that receives GitHub work");
  const scope = (env.OMB_GITHUB_INTAKE_SCOPE ?? "").trim().toLowerCase() || "requested";
  if (scope !== "requested" && scope !== "organization") {
    throw new Error(`OMB_GITHUB_INTAKE_SCOPE must be requested or organization, got "${env.OMB_GITHUB_INTAKE_SCOPE}"`);
  }
  const owners = list(env.OMB_GITHUB_INTAKE_OWNERS);
  const badOwner = owners.find((owner) => !OWNER.test(owner));
  if (badOwner) throw new Error(`OMB_GITHUB_INTAKE_OWNERS: "${badOwner}" is not a GitHub account or organization login`);
  const exclude = list(env.OMB_GITHUB_INTAKE_EXCLUDE);
  const badPattern = exclude.find((pattern) => !REPO_PATTERN.test(pattern));
  if (badPattern) throw new Error(`OMB_GITHUB_INTAKE_EXCLUDE: "${badPattern}" is not an owner/repo pattern`);
  const seconds = bounded(env, "intervalSeconds") ?? INTAKE_DEFAULTS.intervalSeconds;
  const assignmentFlag = (env.OMB_GITHUB_INTAKE_ASSIGNMENTS ?? "").trim().toLowerCase();
  if (!["", "0", "false", "1", "true"].includes(assignmentFlag)) throw new Error("OMB_GITHUB_INTAKE_ASSIGNMENTS must be 0 or 1");
  const assignmentHandoff = assignmentFlag === "1" || assignmentFlag === "true";
  const ghPath = (env.OMB_GITHUB_INTAKE_GH ?? "").trim();
  const deployments = deploymentReposFromEnv(env.OMB_GITHUB_INTAKE_DEPLOYMENTS);
  const escalate = (env.OMB_GITHUB_INTAKE_ESCALATE ?? "").trim().replace(/^@/, "");
  if (escalate && !OWNER.test(escalate.toLowerCase())) throw new Error(`OMB_GITHUB_INTAKE_ESCALATE: "${escalate}" is not a GitHub login`);
  const limits = Object.fromEntries((["reviewAttempts", "runIdleMinutes", "runMaxMinutes", "resettleMinutes"] as const)
    .flatMap((field) => { const value = bounded(env, field); return value === undefined ? [] : [[field, value]]; }));
  return {
    bot, scope, owners, exclude, intervalMs: seconds * 1_000, ...limits, ...(escalate ? { escalate } : {}),
    ...(ghPath ? { ghPath } : {}), ...(assignmentHandoff ? { assignmentHandoff } : {}), ...(deployments.length ? { deployments } : {}),
  };
}
