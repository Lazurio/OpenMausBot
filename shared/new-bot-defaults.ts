import type { WireBot } from "./wire";
import type { RoutineInput } from "./routines";
import type { ToolScope } from "./tool-scope";

/** Data shared by the default template and an individual creation draft. */
export type BotDefaultsProfile = Partial<Pick<WireBot,
  "name" | "title" | "description" | "soul" | "notifications" | "avatarUrl" | "avatarCrop" |
  "mascotBody" | "color" | "voice" | "speakReplies" | "section" | "modelSelection" |
  "approvalMode" | "alwaysAllow" | "chiefOfStaff" |
  "managedSections" | "browser"
>> & {
  mascotExpression?: string | null;
  cwd?: string | null;
  peers?: string[] | null;
  browserProfile?: string | null;
  toolScope?: ToolScope | null;
  parkDirectMessages?: boolean;
  helperModel?: boolean;
};

export type BotRoutineTemplate = Omit<RoutineInput, "botId" | "target" | "groupId" | "resultsThreadId">;
export interface BotSkillTemplate {
  name: string;
  description: string;
  source: string;
  text: string;
  enabled: boolean;
  warnings: string[];
}
export interface NewBotDefaults {
  profile: BotDefaultsProfile;
  memory: Record<string, string>;
  skills: BotSkillTemplate[];
  routines: BotRoutineTemplate[];
}
