import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type FC,
} from "react";
import { Toaster, toast } from "sonner";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import { listen } from "@tauri-apps/api/event";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import "./App.css";
import AccessibilityPermissions from "./components/AccessibilityPermissions";
import { OnboardingCompletionProvider } from "./components/onboarding/OnboardingCompletionContext";
import { Sidebar } from "./components/Sidebar";
import type { SidebarSection } from "./components/sidebarSections";
import { ApiKeysSettings } from "./components/settings/api-keys/ApiKeysSettings";
import { FileTranscriptionSettings } from "./components/settings/file-transcription/FileTranscriptionSettings";
import { HistorySettings } from "./components/settings/history/HistorySettings";
import { ModelsSettings } from "./components/settings/models/ModelsSettings";
import {
  HomeWorkspace,
  type SessionWindowStage,
  type SessionWindowState,
} from "./components/workspace/HomeWorkspace";
import { SettingsWorkspace } from "./components/workspace/SettingsWorkspace";
import RoseThreeLoader from "./components/shared/RoseThreeLoader";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands, type HistoryEntry } from "@/bindings";
import { logFrontendStartup } from "@/lib/startupLog";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";

type OnboardingStep = "accessibility" | "done";
const PERMISSION_CHECK_TIMEOUT_MS = 1500;

const AccessibilityOnboarding = lazy(() =>
  import("./components/onboarding/AccessibilityOnboarding"),
);

const SectionLoading = () => (
  <div className="flex min-h-[220px] items-center justify-center text-text">
    <RoseThreeLoader
      className="h-20 w-20 text-logo-primary drop-shadow-[0_0_24px_rgba(103,215,163,0.22)]"
      ariaLabel="Loading section"
    />
  </div>
);

type HistoryFocusRequest = {
  entryId: number | null;
  token: number;
};

const DEFAULT_SESSION_WINDOW_STATE: SessionWindowState = {
  stage: "idle",
  title: "Open Uttr",
  subtitle: "",
  progressLabel: "",
  progressValue: 0,
  summaryText: null,
  rawTranscriptText: null,
  historyEntryId: null,
};

const isLiveSessionStage = (stage: SessionWindowState["stage"]) =>
  stage === "active" ||
  stage === "preparing" ||
  stage === "transcribing" ||
  stage === "processing";

const isProcessingSessionStage = (stage: SessionWindowState["stage"]) =>
  stage === "preparing" || stage === "transcribing" || stage === "processing";

const getInitialSessionWindowState = (): SessionWindowState => ({
  ...DEFAULT_SESSION_WINDOW_STATE,
  ...(typeof window !== "undefined"
    ? window.__UTTR_E2E__?.sessionWindowState
    : null),
});

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), timeoutMs),
    ),
  ]);
}

interface SettingsContentProps {
  section: SidebarSection;
  historyFocusRequest: HistoryFocusRequest | null;
  sessionWindowState: SessionWindowState;
  sessionClock: SessionClockState;
  onOpenSessionEntry: (entry: HistoryEntry) => void;
}

const SettingsContent: FC<SettingsContentProps> = ({
  section,
  historyFocusRequest,
  sessionWindowState,
  sessionClock,
  onOpenSessionEntry,
}) => {
  switch (section) {
    case "home":
      return (
        <HomeWorkspace
          sessionState={sessionWindowState}
          sessionClock={sessionClock}
          onOpenSessionEntry={onOpenSessionEntry}
        />
      );
    case "files":
      return <FileTranscriptionSettings />;
    case "models":
      return <ModelsSettings />;
    case "apiKeys":
      return <ApiKeysSettings />;
    case "history":
      return (
        <HistorySettings
          focusRequest={historyFocusRequest}
          onOpenSessionEntry={onOpenSessionEntry}
          mode="dictations"
        />
      );
    case "settings":
      return <SettingsWorkspace />;
    default:
      return (
        <HomeWorkspace
          sessionState={sessionWindowState}
          sessionClock={sessionClock}
          onOpenSessionEntry={onOpenSessionEntry}
        />
      );
  }
};

type SessionClockState = {
  recordingStartedAt: number | null;
  recordingStoppedAt: number | null;
  clockNow: number;
};

interface AppState {
  onboardingStep: OnboardingStep | null;
  currentSection: SidebarSection;
  historyFocusRequest: HistoryFocusRequest | null;
  sessionWindowState: SessionWindowState;
  sessionClock: SessionClockState;
}

type AppAction =
  | { type: "onboarding_step"; onboardingStep: OnboardingStep }
  | { type: "section"; section: SidebarSection }
  | { type: "open_session_entry"; entry: HistoryEntry }
  | { type: "clock_tick"; now: number }
  | { type: "sync_clock_for_stage"; stage: SessionWindowStage; now: number }
  | { type: "show_history_entry"; entryId: number | null; token: number }
  | {
      type: "session_window_state";
      nextState: SessionWindowState;
      previousStage: SessionWindowStage;
      token: number;
    };

const getInitialAppState = (): AppState => ({
  onboardingStep: null,
  currentSection: "home",
  historyFocusRequest: null,
  sessionWindowState: getInitialSessionWindowState(),
  sessionClock: {
    recordingStartedAt: null,
    recordingStoppedAt: null,
    clockNow: Date.now(),
  },
});

const getClockForStage = (
  clock: SessionClockState,
  stage: SessionWindowStage,
  now: number,
): SessionClockState => {
  if (stage === "active") {
    return {
      ...clock,
      recordingStartedAt: clock.recordingStartedAt ?? now,
      recordingStoppedAt: null,
    };
  }

  if (isProcessingSessionStage(stage) || stage === "complete") {
    return clock.recordingStartedAt !== null &&
      clock.recordingStoppedAt === null
      ? { ...clock, recordingStoppedAt: now }
      : clock;
  }

  if (!isLiveSessionStage(stage)) {
    return {
      ...clock,
      recordingStartedAt: null,
      recordingStoppedAt: null,
    };
  }

  return clock;
};

const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case "onboarding_step":
      return { ...state, onboardingStep: action.onboardingStep };
    case "section":
      return { ...state, currentSection: action.section };
    case "open_session_entry":
      return {
        ...state,
        currentSection: "home",
        sessionClock: {
          ...state.sessionClock,
          recordingStartedAt: null,
          recordingStoppedAt: null,
        },
        sessionWindowState: {
          stage: "complete",
          title: "Session saved",
          subtitle: "The transcript is ready under Meetings.",
          progressLabel: "Complete",
          progressValue: 1,
          summaryText: action.entry.post_processed_text,
          rawTranscriptText: action.entry.transcription_text,
          historyEntryId: action.entry.id,
        },
      };
    case "clock_tick":
      return {
        ...state,
        sessionClock: { ...state.sessionClock, clockNow: action.now },
      };
    case "sync_clock_for_stage":
      return {
        ...state,
        sessionClock: getClockForStage(
          state.sessionClock,
          action.stage,
          action.now,
        ),
      };
    case "show_history_entry":
      return {
        ...state,
        currentSection: "history",
        historyFocusRequest: {
          entryId: action.entryId,
          token: action.token,
        },
      };
    case "session_window_state": {
      const shouldFocusHistory =
        action.nextState.historyEntryId !== null &&
        action.nextState.historyEntryId !== undefined;
      const shouldShowHome =
        action.previousStage === "idle" &&
        action.nextState.stage !== "idle" &&
        action.nextState.stage !== "complete";

      return {
        ...state,
        currentSection: shouldShowHome ? "home" : state.currentSection,
        historyFocusRequest: shouldFocusHistory
          ? {
              entryId: action.nextState.historyEntryId ?? null,
              token: action.token,
            }
          : state.historyFocusRequest,
        sessionWindowState: action.nextState,
      };
    }
  }
};

function useAppController() {
  const { i18n } = useTranslation();
  const [
    {
      onboardingStep,
      currentSection,
      historyFocusRequest,
      sessionWindowState,
      sessionClock,
    },
    dispatch,
  ] = useReducer(appReducer, undefined, getInitialAppState);
  const sessionStageRef = useRef(sessionWindowState.stage);
  const { settings, updateSetting } = useSettings();
  const direction = getLanguageDirection(i18n.language);
  const refreshInstallAccess = useSettingsStore(
    (state) => state.refreshInstallAccess,
  );
  const hasStartedOnboardingCheck = useRef(false);
  const hasCompletedPostOnboardingInit = useRef(false);

  const openSessionEntry = useCallback((entry: HistoryEntry) => {
    dispatch({ type: "open_session_entry", entry });
  }, []);

  useEffect(() => {
    if (sessionWindowState.stage !== "active") {
      return;
    }

    const timer = window.setInterval(() => {
      dispatch({ type: "clock_tick", now: Date.now() });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sessionWindowState.stage]);

  useEffect(() => {
    dispatch({
      type: "sync_clock_for_stage",
      stage: sessionWindowState.stage,
      now: Date.now(),
    });
  }, [sessionWindowState.stage]);

  useEffect(() => {
    if (hasStartedOnboardingCheck.current) {
      return;
    }
    hasStartedOnboardingCheck.current = true;
    logFrontendStartup("check onboarding start");
    checkOnboardingStatus();
  }, []);

  // Initialize RTL direction when language changes
  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  useEffect(() => {
    const refreshAccess = () => {
      void refreshInstallAccess();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshAccess();
      }
    };

    window.addEventListener("focus", refreshAccess);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.removeEventListener("focus", refreshAccess);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshInstallAccess]);

  // Initialize Enigo and shortcuts when main app loads.
  useEffect(() => {
    if (onboardingStep === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      logFrontendStartup("post onboarding init start");
      Promise.all([commands.initializeEnigo(), commands.initializeShortcuts()])
        .then(() => logFrontendStartup("post onboarding input init complete"))
        .catch((e) => {
          console.warn("Failed to initialize:", e);
          logFrontendStartup("post onboarding input init failed");
        });
    }
  }, [onboardingStep]);

  // Handle keyboard shortcuts for debug mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS)
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    // Add event listener when component mounts
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup event listener when component unmounts
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  // Surface backend transcription failures to the user.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    listen<string>("transcription-error", (event) => {
      const message = event.payload || "Transcription failed";
      toast.error(message);
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    listen<{ entryId?: number | null }>("show-history-entry", (event) => {
      dispatch({
        type: "show_history_entry",
        entryId: event.payload?.entryId ?? null,
        token: Date.now(),
      });
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    listen<SessionWindowState>("session-window-state", (event) => {
      const nextState = event.payload;
      const previousStage = sessionStageRef.current;
      sessionStageRef.current = nextState.stage;

      dispatch({
        type: "session_window_state",
        nextState,
        previousStage,
        token: Date.now(),
      });
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const checkOnboardingStatus = async () => {
    try {
      const settingsResult = await commands.getAppSettings();
      logFrontendStartup("settings loaded for onboarding");

      const onboardingCompleted =
        settingsResult.status === "ok" &&
        Boolean(settingsResult.data.onboarding_completed);

      if (onboardingCompleted) {
        // Returning user - but check if they need to grant permissions on macOS
        if (platform() === "macos") {
          try {
            const permissions = await withTimeout(
              Promise.all([
                checkAccessibilityPermission(),
                checkMicrophonePermission(),
              ]),
              PERMISSION_CHECK_TIMEOUT_MS,
            );
            if (permissions === null) {
              console.warn("Permission check timed out; continuing startup.");
              logFrontendStartup("permission check timed out");
            } else if (!permissions[0] || !permissions[1]) {
              // Missing permissions - show accessibility onboarding
              logFrontendStartup("permissions missing; showing onboarding");
              dispatch({
                type: "onboarding_step",
                onboardingStep: "accessibility",
              });
              return;
            }
            logFrontendStartup("permissions checked");
          } catch (e) {
            console.warn("Failed to check permissions:", e);
            logFrontendStartup("permission check failed");
            // If we can't check, proceed to main app and let them fix it there
          }
        }
        logFrontendStartup("onboarding done");
        dispatch({ type: "onboarding_step", onboardingStep: "done" });
      } else {
        // New user - start permissions onboarding
        logFrontendStartup("onboarding required");
        dispatch({ type: "onboarding_step", onboardingStep: "accessibility" });
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      logFrontendStartup("onboarding check failed");
      dispatch({ type: "onboarding_step", onboardingStep: "accessibility" });
    }
  };

  const handleAccessibilityComplete = useCallback(() => {
    commands
      .completeOnboarding()
      .catch((error) => {
        console.warn("Failed to mark onboarding complete:", error);
      })
      .finally(() => {
        dispatch({ type: "onboarding_step", onboardingStep: "done" });
      });
  }, []);

  const selectSection = useCallback((section: SidebarSection) => {
    dispatch({ type: "section", section });
  }, []);

  return {
    direction,
    onboardingStep,
    currentSection,
    historyFocusRequest,
    sessionWindowState,
    sessionClock,
    openSessionEntry,
    handleAccessibilityComplete,
    selectSection,
  };
}

function App() {
  const {
    direction,
    onboardingStep,
    currentSection,
    historyFocusRequest,
    sessionWindowState,
    sessionClock,
    openSessionEntry,
    handleAccessibilityComplete,
    selectSection,
  } = useAppController();

  // Still checking onboarding status
  if (onboardingStep === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-[linear-gradient(180deg,rgba(10,15,25,0.985),rgba(6,10,18,0.96))] text-text">
        <RoseThreeLoader
          className="h-28 w-28 text-logo-primary drop-shadow-[0_0_28px_rgba(103,215,163,0.28)]"
          ariaLabel="Loading settings"
        />
      </div>
    );
  }

  if (onboardingStep === "accessibility") {
    return (
      <OnboardingCompletionProvider onComplete={handleAccessibilityComplete}>
        <Suspense fallback={<SectionLoading />}>
          <AccessibilityOnboarding />
        </Suspense>
      </OnboardingCompletionProvider>
    );
  }

  return (
    <div
      dir={direction}
      className="relative h-screen overflow-hidden select-none cursor-default bg-[linear-gradient(180deg,rgba(10,15,25,0.985),rgba(6,10,18,0.96))] text-text"
    >
      <Toaster
        theme="system"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              "bg-background border border-mid-gray/20 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 text-sm",
            title: "font-medium",
            description: "text-mid-gray",
          },
        }}
      />
      <div className="flex h-full flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(10,15,25,0.985),rgba(6,10,18,0.96))] backdrop-blur-xl">
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 pt-1 sm:p-4 sm:pt-1 md:flex-row md:gap-4 md:p-5 md:pt-1">
          <Sidebar
            activeSection={currentSection}
            onSectionChange={selectSection}
          />
          <div className="min-w-0 flex-1 overflow-hidden rounded-[20px] border border-white/6 bg-[rgba(5,10,18,0.56)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="flex h-full flex-col overflow-x-hidden overflow-y-auto uttr-scrollbar">
              <div className="flex flex-col items-center gap-5 px-4 py-5 sm:px-5 sm:py-6 md:gap-6 md:px-6 md:py-7">
                <AccessibilityPermissions />
                <SettingsContent
                  section={currentSection}
                  historyFocusRequest={historyFocusRequest}
                  sessionWindowState={sessionWindowState}
                  sessionClock={sessionClock}
                  onOpenSessionEntry={openSessionEntry}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
