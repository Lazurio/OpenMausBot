import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { withTourReset } from "@/lib/guided-tour";
import { dismissNotice, nextNotice, noticeSeen, NOTICES, PRODUCT_HUNT_NOTICE, STAR_NOTICE, usedBefore, type NoticeFacts } from "./notices";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (star: boolean | null, launch: boolean | null = false): NoticeFacts => ({ [PRODUCT_HUNT_NOTICE]: launch, [STAR_NOTICE]: star });
const none = () => false;
const DAY = 86_400_000, NOON = new Date(2026, 9, 9, 12).getTime();

it("is one queue: the launch card, then the star", () => {
  expect(NOTICES).toEqual([PRODUCT_HUNT_NOTICE, STAR_NOTICE]);
  expect(nextNotice(facts(true, true), none)).toBe(PRODUCT_HUNT_NOTICE);
  expect(nextNotice(facts(true, null), none)).toBeNull();
  expect(nextNotice(facts(true, true), id => id === PRODUCT_HUNT_NOTICE)).toBe(STAR_NOTICE);
  expect(nextNotice(facts(true), none)).toBe(STAR_NOTICE);
  expect(nextNotice(facts(true, true), () => true)).toBeNull();
  expect(nextNotice(facts(false), none)).toBeNull();
});

it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, STAR_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", STAR_NOTICE] } });
  expect(storage.get(STAR_NOTICE)).toBe("1");
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(false);
  expect(noticeSeen(record([STAR_NOTICE]), STAR_NOTICE)).toBe(true);
  expect(dismissNotice(record([STAR_NOTICE]), STAR_NOTICE)).toBeNull();
  expect(withTourReset(record([CLOUD_INTRO, `${CLOUD_INTRO}:day-2`, STAR_NOTICE, "tour.done"]))).toEqual([CLOUD_INTRO, `${CLOUD_INTRO}:day-2`, STAR_NOTICE]);
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(false);
  expect(noticeSeen(record([STAR_NOTICE]), STAR_NOTICE)).toBe(true);
  expect(dismissNotice(record(), STAR_NOTICE)).toEqual({ onboarding: { hintsSeen: [STAR_NOTICE] } });
  expect(introStage(record(), NOON)).toBe("due");
  expect(introShown(record(), NOON)).toEqual({ onboarding: { hintsSeen: [`${CLOUD_INTRO}:day-1`] } });
});

it("the card after the update shows at most once a calendar day, on at most three days, then counts as dismissed", () => {
  let hints: string[] = [];
  const show = (at: number) => { const patch = introShown(record(hints), at); if (patch) hints = patch.onboarding.hintsSeen; };
  expect(introStage(record(hints), NOON)).toBe("due");
  show(NOON);
  expect(hints).toEqual([`${CLOUD_INTRO}:day-1`]);
  expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOON)]);
  expect(introStage(record(hints), NOON + 3 * 3600_000)).toBe("shown-today");
  expect(introShown(record(hints), NOON + 3 * 3600_000)).toBeNull();
  const midnight = new Date(2026, 9, 10, 0, 30).getTime();
  expect(introStage(record(hints), midnight)).toBe("due");
  show(midnight); show(NOON + 5 * DAY);
  expect(hints).toEqual([`${CLOUD_INTRO}:day-1`, `${CLOUD_INTRO}:day-2`, `${CLOUD_INTRO}:day-3`]);
  expect(introStage(record(hints), NOON + 5 * DAY + 3600_000)).toBe("shown-today");
  expect(introStage(record(hints), NOON + 6 * DAY)).toBe("done");
  storage.clear();
  expect(introStage(record(hints), NOON + 6 * DAY)).toBe("done");
  expect(introStage(record([`${CLOUD_INTRO}:day-3`]), NOON + 6 * DAY)).toBe("done");
  expect(introStage(record([`${CLOUD_INTRO}:day-2`]), NOON + 6 * DAY)).toBe("due");
  expect(introStage(record([CLOUD_INTRO]), NOON)).toBe("done");
  storage.set(CLOUD_INTRO, "1");
  expect(introStage(record(), NOON)).toBe("done");
});

it("someone who closed the earlier Pro card sees this one on one day only", () => {
  expect([...OLD_PRO_DISMISSALS]).toEqual(["pro-introduction-dismissed-v2", "pro-introduction-dismissed-v3"]);
  for (const earlier of OLD_PRO_DISMISSALS) {
    storage.clear();
    expect(introStage(record([earlier]), NOON)).toBe("due");
    const patch = introShown(record([earlier]), NOON)!;
    expect(introStage({ ...record(), hintsSeen: patch.onboarding.hintsSeen }, NOON + DAY)).toBe("done");
    storage.clear(); storage.set(earlier, "1");
    introShown(record(), NOON);
    expect(introStage(record(), NOON + DAY)).toBe("done");
  }
  storage.clear();
  introShown(record(["pro-introduction-dismissed"]), NOON);
  expect(introStage(record(["pro-introduction-dismissed"]), NOON + DAY)).toBe("due");
});

it("someone has used the app before when a conversation from before this launch has had a reply", () => {
  const launch = 1_000_000;
  const task = (createdAt: number, turns?: number) => ({ createdAt, ...(turns === undefined ? {} : { usage: { turns } }) });
  expect(usedBefore([], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 1)] }], launch)).toBe(true);
  expect(usedBefore([{ tasks: [task(launch, 3)] }], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 0), task(launch - 1)] }, {}], launch)).toBe(false);
  expect(usedBefore([{}, { tasks: [task(launch + 5, 2), task(launch - 9, 2)] }], launch)).toBe(true);
});
