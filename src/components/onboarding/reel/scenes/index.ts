import type { ComponentType } from "react";
import { AgentChat } from "./AgentChat";
import { Automations } from "./Automations";
import { Channels } from "./Channels";
import { Setup } from "./Setup";
import type { SceneProps } from "./types";

export type { SceneProps };

const SCENES: Record<string, ComponentType<SceneProps>> = {
  agents: AgentChat,
  automations: Automations,
  channels: Channels,
  setup: Setup,
};

// Lazurio overlay (DEV-6673 M3): without upstream's "hands" (a computer and connected
// apps of the bot's own) and "terminal" (installing it with npx) scenes.
export const REEL = ["agents", "setup", "channels", "automations"] as const;

export function sceneFor(id: string): ComponentType<SceneProps> | null {
  return SCENES[id] ?? null;
}
