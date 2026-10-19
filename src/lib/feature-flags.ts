export interface FeatureFlagConfig {
  features?: { skillAuthoring?: boolean; skillReview?: boolean; skillReviewSteps?: number; showToolCalls?: boolean; claudeUserMcp?: boolean; claudeUserSkills?: boolean; routinesInConversation?: boolean; llmThreadTitles?: boolean; skillsLibrary?: boolean; shareLearnedSkills?: "off" | "ask" | "auto"; roomMemoryCapture?: boolean };
}

export function skillAuthoringEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillAuthoring !== false;
}

export const DEFAULT_SKILL_REVIEW_STEPS = 10;
export const MIN_SKILL_REVIEW_STEPS = 3;
export const MAX_SKILL_REVIEW_STEPS = 100;

export function skillReviewEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return skillAuthoringEnabled(config) && config?.features?.skillReview === true;
}

export function skillReviewSteps(config: FeatureFlagConfig | null | undefined): number {
  const raw = config?.features?.skillReviewSteps;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SKILL_REVIEW_STEPS;
  return Math.min(MAX_SKILL_REVIEW_STEPS, Math.max(MIN_SKILL_REVIEW_STEPS, value));
}

export function skillReviewUnavailableEngines(
  bots: ReadonlyArray<{ modelSelection?: { instanceId?: string } }>,
  instances: ReadonlyArray<{ instanceId: string; displayName: string; capabilities?: { backgroundText?: boolean; agentsMcp?: boolean } }>,
): string[] {
  const used = new Set(bots.map((bot) => bot.modelSelection?.instanceId).filter(Boolean));
  return [...new Set(instances
    .filter((instance) => used.has(instance.instanceId))
    .filter((instance) => instance.capabilities?.backgroundText !== true || instance.capabilities?.agentsMcp !== true)
    .map((instance) => instance.displayName))];
}

export function parseSkillReviewSteps(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const steps = Number(trimmed);
  return steps >= MIN_SKILL_REVIEW_STEPS && steps <= MAX_SKILL_REVIEW_STEPS ? steps : null;
}

export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

export function routinesInConversationEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.routinesInConversation === true;
}

export function claudeUserMcpEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserMcp === true;
}

export function claudeUserSkillsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserSkills === true;
}

export function llmThreadTitlesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.llmThreadTitles === true;
}

export function skillsLibraryEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillsLibrary === true;
}

export function shareLearnedSkillsMode(config: FeatureFlagConfig | null | undefined): "off" | "ask" | "auto" {
  if (!skillsLibraryEnabled(config)) return "off";
  return config?.features?.shareLearnedSkills ?? "ask";
}

export function roomMemoryCaptureEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.roomMemoryCapture === true;
}
