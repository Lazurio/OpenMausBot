import { useState } from "react";
import { Check, Loader2, LockKeyhole, LogIn, RefreshCw, X } from "lucide-react";

import { signInOutcome } from "../../shared/sign-in-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { answerSignIn, signInHostIsHere } from "@/lib/sign-in";
import type { Message } from "@/state/store";
import { LazurioSignInWhere } from "./LazurioBrowser";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_PRIMARY_BUTTON, ASK_QUIET_BUTTON, AskCard, AskSettledLine, returnFocusToComposer } from "./AskCard";

const WHERE = {
  browser: "signIn.where.browser",
  local: "signIn.where.local",
  host: "signIn.where.host",
} as const;

export function SignInRequestCard({
  botId,
  botName,
  threadId,
  message,
}: {
  botId: string;
  botName: string;
  threadId: string;
  message: Message;
}) {
  const card = message.signIn!;
  const [pending, setPending] = useState<"done" | "cancel" | null>(null);
  const [explained, setExplained] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? card.error;
  const outcome = signInOutcome(card);
  const ref = { botId, threadId, messageId: message.id, place: card.place };
  const here = signInHostIsHere();

  const answer = async (choice: "done" | "cancel") => {
    if (pending) return;
    setPending(choice);
    setLocalError(null);
    try {
      await answerSignIn(ref, choice);
      returnFocusToComposer();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const stopped = card.stopped === true;

  if (card.superseded || (stopped && !outcome)) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={t("signIn.title")}>
        <span className="text-ink-secondary">{card.site}</span>
        <span> · {t(card.superseded ? "signIn.superseded" : "chat.turnStopped")}</span>
      </AskSettledLine>
    );
  }

  if (outcome) {
    const retry = !card.resumed && !stopped && error ? (
      <button type="button" onClick={() => void answer(outcome === "done" ? "done" : "cancel")} disabled={pending !== null}
        className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {pending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {t("signIn.retry")}
      </button>
    ) : undefined;
    return (
      <AskSettledLine
        ariaLabel={t("signIn.title")}
        icon={outcome === "cancelled" ? <X size={13} className="text-ink-tertiary" /> : card.resumed || stopped ? undefined : error ? <LogIn size={13} /> : <Loader2 size={13} className="animate-spin" />}
        action={retry}
        detail={error && <p role="alert" className="ms-[19px] mt-1 text-[12px] text-danger">{error}</p>}
      >
        <span className="text-ink-secondary">{t(outcome === "done" ? "signIn.settled.done" : "signIn.settled.cancelled", { site: card.site })}</span>
        <span> · {card.resumed ? t("signIn.settled.resumed", { name: botName }) : stopped ? t("chat.turnStopped") : error ? t("signIn.settled.failed") : t("signIn.settled.waiting")}</span>
      </AskSettledLine>
    );
  }

  const where = WHERE[card.place === "local" && !here ? "host" : card.place];
  return (
    <AskCard
      ariaLabel={t("signIn.cardLabel", { name: botName, site: card.site })}
      icon={<LogIn size={15} />}
      title={t("signIn.title")}
      footer={<>
        <button type="button" onClick={() => void answer("cancel")} disabled={pending !== null} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          {pending === "cancel" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          {t("signIn.cancel")}
        </button>
        {card.place === "local" && (
          <button type="button" onClick={() => setExplained(true)} disabled={pending !== null} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            <LogIn size={14} />
            {t("signIn.open")}
          </button>
        )}
        <button type="button" onClick={() => void answer("done")} disabled={pending !== null} className={ASK_PRIMARY_BUTTON}>
          {pending === "done" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t("signIn.done")}
        </button>
      </>}
    >
      <div dir="ltr" className="break-all text-[20px] font-semibold leading-7 text-ink" data-testid="sign-in-site">{card.site}</div>
      {card.reason && (
        <blockquote className="mt-1.5 border-s-2 border-hairline ps-2.5 text-[13px] leading-snug text-ink-secondary">
          <bdi dir="auto">“{card.reason}”</bdi> <span className="text-ink-tertiary">— {botName}</span>
        </blockquote>
      )}
      <LazurioSignInWhere botId={botId} card={card} fallback={<p className="mt-2 text-[12.5px] leading-snug text-ink-secondary">{t(where, { name: botName })}</p>} />
      {explained && (
        <p role="note" className="mt-1.5 text-[12.5px] leading-snug text-ink">{t(here ? "signIn.local.explain" : "signIn.local.explainHost", { name: botName })}</p>
      )}
      <p className="mt-2 flex items-center gap-1 text-[11.5px] text-ink-tertiary">
        <LockKeyhole size={11} aria-hidden="true" /> {t("signIn.private")}
      </p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </AskCard>
  );
}
