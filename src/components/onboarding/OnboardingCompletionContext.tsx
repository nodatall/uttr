import {
  createContext,
  useContext,
  type FC,
  type PropsWithChildren,
} from "react";

const OnboardingCompletionContext = createContext<(() => void) | null>(null);

interface OnboardingCompletionProviderProps extends PropsWithChildren {
  onComplete: () => void;
}

export const OnboardingCompletionProvider: FC<
  OnboardingCompletionProviderProps
> = ({ children, onComplete }) => (
  <OnboardingCompletionContext.Provider value={onComplete}>
    {children}
  </OnboardingCompletionContext.Provider>
);

export const useOnboardingCompletion = () => {
  const onComplete = useContext(OnboardingCompletionContext);
  if (onComplete === null) {
    throw new Error("useOnboardingCompletion must be used inside its provider");
  }

  return onComplete;
};
