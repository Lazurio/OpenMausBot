import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

export const STAR_NOTICE = "github-star-dismissed";
export const PRODUCT_HUNT_NOTICE = "product-hunt-launch-2026-10";
export const PRODUCT_HUNT_URL = "https://www.producthunt.com/products/mausbot";
export const PRODUCT_HUNT_UNTIL = Date.UTC(2026, 10, 1);

export type NoticeId = typeof PRODUCT_HUNT_NOTICE | typeof STAR_NOTICE;

export const NOTICES: readonly NoticeId[] = [PRODUCT_HUNT_NOTICE, STAR_NOTICE];

export type NoticeFacts = Record<NoticeId, boolean | null>;

export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean): NoticeId | null {
  for (const id of NOTICES) {
    if (seen(id)) continue;
    if (facts[id] === null) return null;
    if (facts[id]) return id;
  }
  return null;
}

const stored = (id: string): string | null => { try { return localStorage.getItem(id); } catch { return null; } };
const store = (id: string, value: string) => { try { localStorage.setItem(id, value); } catch {} };

export function noticeSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return hintSeen(record, id) || stored(id) === "1";
}

export function dismissNotice(record: OnboardingStatus | undefined, id: string): { onboarding: { hintsSeen: string[] } } | null {
  store(id, "1");
  return hintSeenPatch(record, id);
}

export const LAUNCHED_AT = Date.now();

export function usedBefore(
  bots: ReadonlyArray<{ tasks?: ReadonlyArray<{ createdAt?: number; usage?: { turns: number } }> }>,
  launchedAt = LAUNCHED_AT,
): boolean {
  return bots.some(bot => bot.tasks?.some(task => (task.createdAt ?? Infinity) < launchedAt && (task.usage?.turns ?? 0) > 0) ?? false);
}
