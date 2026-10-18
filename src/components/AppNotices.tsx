import { useEffect, useState } from "react";
import { Rocket, Star } from "lucide-react";
import { api, useStore } from "@/state/store";
import { APP_REPOSITORY } from "@/lib/app-links";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { cornerPopupWaits, firstReplyPending } from "@/lib/corner-popup";
import { dismissNotice, nextNotice, noticeSeen, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, STAR_NOTICE, usedBefore } from "@/lib/notices";
import type { WelcomeViewer } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { LinkButton, NoticeCard, NotNowButton } from "./NoticeCard";
import { localDesktopPage } from "./onboarding/WelcomeGate";

function StarCard({ onDismiss }: { onDismiss: () => void }) {
  return <NoticeCard titleId="github-star-title" notice="github-star" icon={Star} title={t("star.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("star.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={APP_REPOSITORY} label={t("star.button")} onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}

function ProductHuntCard({ onDone }: { onDone: (action: "upvote" | "not_now" | "close") => void }) {
  return <NoticeCard titleId="product-hunt-title" notice="product-hunt" icon={Rocket} title={t("productHunt.title")} onDismiss={() => onDone("close")}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("productHunt.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={PRODUCT_HUNT_URL} label={t("productHunt.button")} onOpened={() => onDone("upvote")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  // Lazurio overlay (DEV-6673 M3): the MausBot Cloud cards are removed; the rest stays on this computer's own page.
  const cards = !remote && localDesktopPage();
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  const [closed, setClosed] = useState(false);
  const updater = useUpdaterState();
  useEffect(() => {
    const org = window.ogb?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const record = state.config?.onboarding;
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer });
  // Promotions never land on a new install's first chat: they wait for its first reply. Unknown (null) until the bots
  // have loaded, so nothing lower in the queue flashes up before them.
  const firstChat = firstReplyPending(state);
  const notice = !closed && !waits && cards ? nextNotice({
    [PRODUCT_HUNT_NOTICE]: firstChat === true || brandStatus().source === "file" || now() >= PRODUCT_HUNT_UNTIL ? false
      : organization === null || firstChat === null ? null : !organization,
    [STAR_NOTICE]: brandStatus().source !== "file" && usedBefore(state.bots),
  }, id => noticeSeen(record, id)) : null;

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => setClosed(true);
  if (!notice) return null;

  if (notice === PRODUCT_HUNT_NOTICE) {
    return <ProductHuntCard onDone={action => { track("product_hunt_card", { action }); close(); save(PRODUCT_HUNT_NOTICE); }} />;
  }
  if (notice === STAR_NOTICE) return <StarCard onDismiss={() => { close(); save(STAR_NOTICE); }} />;
  return null;
}
