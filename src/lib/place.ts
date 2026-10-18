import { cloudHomeOffersPlace } from "../../shared/cloud-home";
import { toolSurfaceKind } from "../../shared/tool-surface";
import type { Surface } from "../../shared/wire";
import type { LocaleKey } from "@/locales";

export type Place = Surface;
export const PLACES: readonly Place[] = ["local", "browser"];

export function placeOffered(place: Place, config: { cloudHome?: boolean } | null | undefined): boolean {
  return !config?.cloudHome || cloudHomeOffersPlace(place);
}

export function placeLabelKey(place: Place): LocaleKey {
  return `place.${place}` as LocaleKey;
}

/** Browser tools act in the built-in browser and computer tools on this computer's own screen. */
export function toolPlace(toolName: string): Place | null {
  const kind = toolSurfaceKind(toolName);
  if (kind === "browser") return "browser";
  if (kind === "computer") return "local";
  return null;
}
