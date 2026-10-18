import { useEffect, useState } from "react";
import { Rocket, Star } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
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

const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;
const CLOUD_SETTINGS = { type: "toggleAppSettings", open: true, section: "cloudAccount" } as const;

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  // Asked once main has restored the Cloud sign-in, which it waits for before answering desktopState.
  const planBridge = !remote && (bridge || (viewer?.cloudHome && (desktopState || !desktop))) ? window.ogb?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const plan = useCloudPlanSnapshot(planBridge);
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  const [closed, setClosed] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [popupShown, setPopupShown] = useState(false);
  const consentHere = (local || viewer?.cloudHome === true) && brandStatus().source !== "file";
  const consent = useUpdatesConsent(consentHere ? updatesConsentBridge() : undefined);
  const [consentDone, setConsentDone] = useState(false);
  const updater = useUpdaterState();
  const intent = useCloudIntent();
  const moving = useMoveQuiet(now);
  const mausBot = useMausBotWelcomeDue(viewer);
  const lending = remote ? undefined : window.ogb?.cloudLending;
  const [macAsked, setMacAsked] = useState(false);
  const [macAsking, setMacAsking] = useState(false);
  const macDue = useUseMyComputerDue(lending, macAsked);
  const macBlocked = useOtherDialogOpen(macDue === true) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    const org = window.ogb?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer });
  const firstChat = firstReplyPending(state);
  const notice = !closed && !waits && cards ? nextNotice({
    [STAR_NOTICE]: brandStatus().source !== "file" && usedBefore(state.bots),
  }, id => noticeSeen(record, id)) : null;

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { setClosed(true); setTrialOpen(null); setFailed(false); };
  if (toast) return <NoticeToast text={toast} onDone={() => setToast(null)} />;
  if (!notice) return null;

  if (notice === CLOUD_PRO_UPDATE_NOTICE && popupView && desktop) {
    const report = (action: CloudProPopupAction) => reportCloudProPopup(action, popupView, page);
    const end = () => { void desktop.seen(CLOUD_PRO_UPDATE_NOTICE).catch(() => {}); close(); };
    const plans = (action: CloudProPopupAction) => { report(action); end(); dispatch({ type: "openCloudAdd", source: CLOUD_PRO_POPUP_SOURCE }); };
    const primary = popupView.primary.via === "add-cloud" ? () => plans("upgrade") : () => { report("manage"); end(); dispatch(CLOUD_SETTINGS); };
    return <CloudProPopup view={popupView}
      onPrimary={primary}
      onSeePlans={() => plans("see_plans")}
      onNotNow={() => { report("not_now"); end(); }}
      onClose={() => { report("close"); end(); }} />;
  }

  if (notice === UPDATES_CONSENT_NOTICE && consent.state) {
    const done = () => { setConsentDone(true); close(); };
    return <UpdatesConsentDialog signedIn={consent.state.signedIn}
      onYes={async email => { await consent.choose("opted_in", email); done(); }}
      onNo={() => { done(); void consent.choose("declined").catch(() => {}); }} />;
  }
  if (notice === CLOUD_INTRO && offer) {
    const done = (action: string) => { track("cloud_card_action", { action }); close(); save(CLOUD_INTRO); };
    return <CloudTrialIntroCard offer={offer}
      onStart={() => { done("start"); dispatch({ type: "openCloudAdd", source: "app_card" }); }}
      onHowTo={() => { done("howto"); dispatch({ type: "cloudHowTo", open: true }); }}
      onSignIn={view?.kind === "signed-out" ? () => { track("cloud_card_action", { action: "signin" }); close(); dispatch({ type: "openCloudAdd", source: "app_card", signIn: true }); } : undefined}
      onNotNow={() => { done("not_now"); setToast(t("cloudIntro.later")); }}
      onDismiss={() => { done("close"); setToast(t("cloudIntro.later")); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView(trial, plan?.credit);
    const act = () => { setFailed(false); void planBridge?.manage().then(close, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={shown} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(next => setAccount(next), () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(CLOUD_NOTICE_CARD[kind].dismissed); }} />;
  }
  if (notice === PRODUCT_HUNT_NOTICE) {
    return <ProductHuntCard onDone={action => { track("product_hunt_card", { action }); close(); save(PRODUCT_HUNT_NOTICE); }} />;
  }
  if (notice === STAR_NOTICE) return <StarCard onDismiss={() => { close(); save(STAR_NOTICE); }} />;
  return null;
}
