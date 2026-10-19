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

/** Computer tools act on this computer's own screen. */
export function toolPlace(toolName: string): Place | null {
  return toolSurfaceKind(toolName) === "computer" ? "local" : null;
}
