// A copy's restrictions go in the request that creates it: a later patch that failed would leave it unrestricted.
import { helperModelAllowed } from "../../shared/wire";
import type { Bot } from "@/state/store";

export type RestrictedSource = Pick<Bot, "visibility" | "helperModel">;

export interface RestrictedCopyRequest {
  visibility?: Bot["visibility"];
  settings?: { helperModel?: false };
}

export function restrictedCopyRequest(source: RestrictedSource): RestrictedCopyRequest {
  return {
    ...(source.visibility && source.visibility !== "everyone" ? { visibility: source.visibility } : {}),
    ...(helperModelAllowed(source) ? {} : { settings: { helperModel: false as const } }),
  };
}
