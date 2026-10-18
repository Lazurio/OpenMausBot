import { Globe, Monitor, type LucideProps } from "lucide-react";
import type { Place } from "@/lib/place";

const ICONS = { local: Monitor, browser: Globe } as const;

export function PlaceIcon({ place, ...props }: { place: Place } & LucideProps) {
  const Icon = ICONS[place];
  return <Icon {...props} />;
}
