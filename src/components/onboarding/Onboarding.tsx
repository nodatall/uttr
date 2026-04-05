import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Settings2 } from "lucide-react";
import WindowDragRegion from "@/components/ui/WindowDragRegion";
import { Button } from "@/components/ui/Button";

interface OnboardingProps {
  onModelSelected: () => void;
}

const Onboarding: FC<OnboardingProps> = ({ onModelSelected }) => {
  const { t } = useTranslation();

  return (
    <div className="relative flex h-screen w-screen flex-col inset-0">
      <WindowDragRegion />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[680px] rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(9,14,24,0.98),rgba(7,12,20,0.95))] px-6 py-7 shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
          <div className="flex flex-col gap-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                {/* eslint-disable-next-line i18next/no-literal-string */}
                <p className="text-[11px] uppercase tracking-[0.32em] text-logo-primary/70">
                  Uttr
                </p>
                <h1 className="text-2xl font-semibold tracking-tight text-text">
                  {t("onboarding.apiKey.title", {
                    defaultValue: "Add an API key before choosing a model.",
                  })}
                </h1>
                <p className="max-w-xl text-sm leading-relaxed text-text/66">
                  {t("onboarding.apiKey.subtitle", {
                    defaultValue:
                      "Uttr no longer selects a transcription model during onboarding. Add your API key first, then choose a model manually from Settings when you are ready.",
                  })}
                </p>
              </div>

              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-logo-primary/16 bg-logo-primary/10 text-logo-primary">
                <KeyRound className="h-5 w-5" />
              </div>
            </div>

            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-text">
                <Settings2 className="h-4 w-4 text-logo-primary" />
                {t("onboarding.apiKey.stepTitle", {
                  defaultValue: "Finish setup from Settings",
                })}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-text/60">
                {t("onboarding.apiKey.stepBody", {
                  defaultValue:
                    "Open the app, add your provider API key, and then select the transcription model you want to use. Nothing will be selected automatically.",
                })}
              </p>
            </div>

            <div className="flex justify-end">
              <Button variant="primary-soft" onClick={onModelSelected}>
                {t("common.continue", { defaultValue: "Continue" })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
