import { useEffect, useState, useRef } from "react";
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
import Footer from "./components/footer";
import { AccessibilityOnboarding } from "./components/onboarding";
import { Sidebar, SidebarSection, SECTIONS_CONFIG } from "./components/Sidebar";
import { HistorySettings } from "./components/settings";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands } from "@/bindings";
import { logFrontendStartup } from "@/lib/startupLog";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";

type OnboardingStep = "accessibility" | "done";
const PERMISSION_CHECK_TIMEOUT_MS = 1500;

type HistoryFocusRequest = {
  entryId: number | null;
  token: number;
};

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

const renderSettingsContent = (
  section: SidebarSection,
  historyFocusRequest: HistoryFocusRequest | null,
) => {
  if (section === "history") {
    return <HistorySettings focusRequest={historyFocusRequest} />;
  }

  const ActiveComponent =
    SECTIONS_CONFIG[section]?.component || SECTIONS_CONFIG.general.component;
  return <ActiveComponent />;
};

function App() {
  const { i18n } = useTranslation();
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(
    null,
  );
  const [currentSection, setCurrentSection] =
    useState<SidebarSection>("general");
  const [historyFocusRequest, setHistoryFocusRequest] =
    useState<HistoryFocusRequest | null>(null);
  const { settings, updateSetting } = useSettings();
  const direction = getLanguageDirection(i18n.language);
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const refreshInstallAccess = useSettingsStore(
    (state) => state.refreshInstallAccess,
  );
  const hasCompletedPostOnboardingInit = useRef(false);

  useEffect(() => {
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

  // Initialize Enigo, shortcuts, and refresh audio devices when main app loads
  useEffect(() => {
    if (onboardingStep === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      logFrontendStartup("post onboarding init start");
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ])
        .then(() => logFrontendStartup("post onboarding input init complete"))
        .catch((e) => {
          console.warn("Failed to initialize:", e);
          logFrontendStartup("post onboarding input init failed");
        });
      refreshAudioDevices();
      refreshOutputDevices();
    }
  }, [onboardingStep, refreshAudioDevices, refreshOutputDevices]);

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
      setCurrentSection("history");
      setHistoryFocusRequest({
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
              setOnboardingStep("accessibility");
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
        setOnboardingStep("done");
      } else {
        // New user - start permissions onboarding
        logFrontendStartup("onboarding required");
        setOnboardingStep("accessibility");
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      logFrontendStartup("onboarding check failed");
      setOnboardingStep("accessibility");
    }
  };

  const handleAccessibilityComplete = () => {
    commands
      .completeOnboarding()
      .catch((error) => {
        console.warn("Failed to mark onboarding complete:", error);
      })
      .finally(() => {
        setOnboardingStep("done");
      });
  };

  // Still checking onboarding status
  if (onboardingStep === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-[linear-gradient(180deg,rgba(10,15,25,0.985),rgba(6,10,18,0.96))] text-text">
        <div className="h-8 w-8 rounded-lg bg-background-ui/80 shadow-[0_0_34px_rgba(29,155,100,0.28)]" />
      </div>
    );
  }

  if (onboardingStep === "accessibility") {
    return (
      <AccessibilityOnboarding
        onComplete={handleAccessibilityComplete}
        showScreenRecordingGuidance={platform() === "macos"}
      />
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
            onSectionChange={setCurrentSection}
          />
          <div className="min-w-0 flex-1 overflow-hidden rounded-[20px] border border-white/6 bg-[rgba(5,10,18,0.56)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="flex h-full flex-col overflow-x-hidden overflow-y-auto uttr-scrollbar">
              <div className="flex flex-col items-center gap-5 px-4 py-5 sm:px-5 sm:py-6 md:gap-6 md:px-6 md:py-7">
                <AccessibilityPermissions />
                {renderSettingsContent(currentSection, historyFocusRequest)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
