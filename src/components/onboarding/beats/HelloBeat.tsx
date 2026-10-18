import { t } from "@/lib/i18n";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

// Lazurio overlay (DEV-6673 M3): no name and e-mail form. Upstream asks for them
// here and sends the e-mail to its own analytics ("we'll let you know when big
// things ship"); an Environment's people never go to upstream.
export function HelloBeat({ onNext, hosted = false }: BeatProps & { hosted?: boolean }) {
  return (
    <div className="stagger flex flex-col items-center">
      {hosted && (
        <p className="animate-rise mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
          {t("onboarding.hosted.intro")}
        </p>
      )}
      <PrimaryButton onClick={onNext} className="animate-rise mt-5" style={staggerIndex(hosted ? 1 : 0)}>
        {t("onboarding.continue")}
      </PrimaryButton>
    </div>
  );
}
