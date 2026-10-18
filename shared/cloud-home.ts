// The places an OMB Cloud home offers, shared by the server and the app. A Cloud
// home is a headless Linux server: "This computer" would be the server itself,
// so it is never offered. Bots there work in the built-in browser.
import type { Surface } from "./wire.ts";

/** Whether a Cloud home offers this place at all. */
export function cloudHomeOffersPlace(place: Surface): boolean {
  return place !== "local";
}
