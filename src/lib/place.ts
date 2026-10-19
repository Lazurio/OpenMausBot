import { cloudHomeOffersPlace } from "../../shared/cloud-home";
import { toolSurfaceKind } from "../../shared/tool-surface";
import type { LocaleKey } from "@/locales";


export function placeOffered(place: Place, config: { cloudHome?: boolean } | null | undefined): boolean {
  return !config?.cloudHome || cloudHomeOffersPlace(place);
}

  return `place.${place}` as LocaleKey;
}

}
