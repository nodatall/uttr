export const SHOW_MODEL_ONBOARDING_EVENT = "uttr:show-model-onboarding";

export const requestShowModelOnboarding = (): void => {
  window.dispatchEvent(new CustomEvent(SHOW_MODEL_ONBOARDING_EVENT));
};
