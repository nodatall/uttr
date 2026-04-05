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
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands } from "@/bindings";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";

type OnboardingStep = "accessibility" | "done";
const SHORTCUT_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

const renderSettingsContent = (section: SidebarSection) => {
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
  const { settings, updateSetting } = useSettings();
  const direction = getLanguageDirection(i18n.language);
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const hasCompletedPostOnboardingInit = useRef(false);

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  // Initialize RTL direction when language changes
  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  // Initialize Enigo, shortcuts, and refresh audio devices when main app loads
  useEffect(() => {
    if (onboardingStep === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]).catch((e) => {
        console.warn("Failed to initialize:", e);
      });
      refreshAudioDevices();
      refreshOutputDevices();
    }
  }, [onboardingStep, refreshAudioDevices, refreshOutputDevices]);

  useEffect(() => {
    if (onboardingStep !== "done") {
      return;
    }

    const refreshShortcuts = () => {
      commands.initializeShortcuts().catch((e) => {
        console.warn("Failed to refresh shortcuts:", e);
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshShortcuts();
      }
    };

    const intervalId = window.setInterval(
      refreshShortcuts,
      SHORTCUT_REFRESH_INTERVAL_MS,
    );

    window.addEventListener("focus", refreshShortcuts);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshShortcuts);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
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

  const checkOnboardingStatus = async () => {
    try {
      const settingsResult = await commands.getAppSettings();

      const onboardingCompleted =
        settingsResult.status === "ok" &&
        Boolean(settingsResult.data.onboarding_completed);

      if (onboardingCompleted) {
        // Returning user - but check if they need to grant permissions on macOS
        if (platform() === "macos") {
          try {
            const [hasAccessibility, hasMicrophone] = await Promise.all([
              checkAccessibilityPermission(),
              checkMicrophonePermission(),
            ]);
            if (!hasAccessibility || !hasMicrophone) {
              // Missing permissions - show accessibility onboarding
              setOnboardingStep("accessibility");
              return;
            }
          } catch (e) {
            console.warn("Failed to check permissions:", e);
            // If we can't check, proceed to main app and let them fix it there
          }
        }
        setOnboardingStep("done");
      } else {
        // New user - start permissions onboarding
        setOnboardingStep("accessibility");
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
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
    return null;
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
                {renderSettingsContent(currentSection)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
