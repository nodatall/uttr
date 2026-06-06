import React, { useReducer, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import ProgressBar from "../shared/ProgressBar";
import { useSettings } from "../../hooks/useSettings";

const AUTO_UPDATE_CHECK_DELAY_MS = 6000;
let sharedUpdateCheckPromise: ReturnType<typeof check> | null = null;

const runSharedUpdateCheck = () => {
  if (!sharedUpdateCheckPromise) {
    sharedUpdateCheckPromise = check().finally(() => {
      sharedUpdateCheckPromise = null;
    });
  }

  return sharedUpdateCheckPromise;
};

interface UpdateCheckerProps {
  className?: string;
}

interface UpdateCheckerState {
  isChecking: boolean;
  updateAvailable: boolean;
  isInstalling: boolean;
  downloadProgress: number;
  showUpToDate: boolean;
}

type UpdateCheckerAction =
  | { type: "checking_started" }
  | { type: "checking_finished" }
  | { type: "update_available"; available: boolean }
  | { type: "show_up_to_date"; show: boolean }
  | { type: "install_started" }
  | { type: "install_finished" }
  | { type: "download_progress"; progress: number }
  | { type: "disabled" };

const initialUpdateCheckerState: UpdateCheckerState = {
  isChecking: false,
  updateAvailable: false,
  isInstalling: false,
  downloadProgress: 0,
  showUpToDate: false,
};

const updateCheckerReducer = (
  state: UpdateCheckerState,
  action: UpdateCheckerAction,
): UpdateCheckerState => {
  switch (action.type) {
    case "checking_started":
      return { ...state, isChecking: true };
    case "checking_finished":
      return { ...state, isChecking: false };
    case "update_available":
      return {
        ...state,
        updateAvailable: action.available,
        showUpToDate: action.available ? false : state.showUpToDate,
      };
    case "show_up_to_date":
      return { ...state, showUpToDate: action.show };
    case "install_started":
      return { ...state, isInstalling: true, downloadProgress: 0 };
    case "install_finished":
      return { ...state, isInstalling: false, downloadProgress: 0 };
    case "download_progress":
      return { ...state, downloadProgress: action.progress };
    case "disabled":
      return { ...state, ...initialUpdateCheckerState };
  }
};

const UpdateChecker: React.FC<UpdateCheckerProps> = ({ className = "" }) => {
  const { t } = useTranslation();
  const [
    { isChecking, updateAvailable, isInstalling, downloadProgress, showUpToDate },
    dispatch,
  ] = useReducer(updateCheckerReducer, initialUpdateCheckerState);

  const { settings, isLoading } = useSettings();
  const settingsLoaded = !isLoading && settings !== null;
  const updateChecksEnabled = settings?.update_checks_enabled ?? false;

  const upToDateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const autoCheckTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isCheckingRef = useRef(false);
  const isManualCheckRef = useRef(false);
  const downloadedBytesRef = useRef(0);
  const contentLengthRef = useRef(0);

  const clearUpToDateTimeout = useCallback(() => {
    if (upToDateTimeoutRef.current) {
      clearTimeout(upToDateTimeoutRef.current);
      upToDateTimeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => clearUpToDateTimeout, [clearUpToDateTimeout]);

  // Update checking functions
  const checkForUpdates = useCallback(async (manual = false) => {
    if (!updateChecksEnabled || isCheckingRef.current) return;

    try {
      isCheckingRef.current = true;
      isManualCheckRef.current = manual;
      dispatch({ type: "checking_started" });
      const update = await runSharedUpdateCheck();

      if (update) {
        dispatch({ type: "update_available", available: true });
      } else {
        dispatch({ type: "update_available", available: false });

        if (isManualCheckRef.current) {
          dispatch({ type: "show_up_to_date", show: true });
          clearUpToDateTimeout();
          upToDateTimeoutRef.current = setTimeout(() => {
            dispatch({ type: "show_up_to_date", show: false });
          }, 3000);
        }
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    } finally {
      isCheckingRef.current = false;
      dispatch({ type: "checking_finished" });
      isManualCheckRef.current = false;
    }
  }, [clearUpToDateTimeout, updateChecksEnabled]);

  const handleManualUpdateCheck = useCallback(() => {
    if (!updateChecksEnabled) return;
    if (autoCheckTimeoutRef.current) {
      clearTimeout(autoCheckTimeoutRef.current);
    }
    void checkForUpdates(true);
  }, [checkForUpdates, updateChecksEnabled]);

  useEffect(() => {
    // Wait for settings to load before doing anything
    if (!settingsLoaded) return;

    if (!updateChecksEnabled) {
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
      dispatch({ type: "disabled" });
      return;
    }

    const autoCheckTimeout = setTimeout(() => {
      void checkForUpdates();
    }, AUTO_UPDATE_CHECK_DELAY_MS);
    autoCheckTimeoutRef.current = autoCheckTimeout;

    // Listen for update check events
    const updateUnlisten = listen("check-for-updates", () => {
      handleManualUpdateCheck();
    });

    return () => {
      clearTimeout(autoCheckTimeout);
      if (autoCheckTimeoutRef.current === autoCheckTimeout) {
        autoCheckTimeoutRef.current = undefined;
      }
      updateUnlisten.then((fn) => fn());
    };
  }, [
    checkForUpdates,
    autoCheckTimeoutRef,
    dispatch,
    handleManualUpdateCheck,
    settingsLoaded,
    upToDateTimeoutRef,
    updateChecksEnabled,
  ]);

  const installUpdate = async () => {
    if (!updateChecksEnabled) return;
    try {
      dispatch({ type: "install_started" });
      downloadedBytesRef.current = 0;
      contentLengthRef.current = 0;
      const update = await check();

      if (!update) {
        console.log("No update available during install attempt");
        return;
      }

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            downloadedBytesRef.current = 0;
            contentLengthRef.current = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloadedBytesRef.current += event.data.chunkLength;
            const progress =
              contentLengthRef.current > 0
                ? Math.round(
                    (downloadedBytesRef.current / contentLengthRef.current) *
                      100,
                  )
                : 0;
            dispatch({
              type: "download_progress",
              progress: Math.min(progress, 100),
            });
            break;
        }
      });
      await relaunch();
    } catch (error) {
      console.error("Failed to install update:", error);
    } finally {
      dispatch({ type: "install_finished" });
      downloadedBytesRef.current = 0;
      contentLengthRef.current = 0;
    }
  };

  // Update status functions
  const getUpdateStatusText = () => {
    if (!updateChecksEnabled) {
      return t("footer.updateCheckingDisabled");
    }
    if (isInstalling) {
      return downloadProgress > 0 && downloadProgress < 100
        ? t("footer.downloading", {
            progress: downloadProgress.toString().padStart(3),
          })
        : downloadProgress === 100
          ? t("footer.installing")
          : t("footer.preparing");
    }
    if (isChecking) return t("footer.checkingUpdates");
    if (showUpToDate) return t("footer.upToDate");
    if (updateAvailable) return t("footer.updateAvailableShort");
    return t("footer.checkForUpdates");
  };

  const getUpdateStatusAction = () => {
    if (!updateChecksEnabled) return undefined;
    if (updateAvailable && !isInstalling) return installUpdate;
    if (!isChecking && !isInstalling && !updateAvailable)
      return handleManualUpdateCheck;
    return undefined;
  };

  const isUpdateDisabled = !updateChecksEnabled || isChecking || isInstalling;
  const isUpdateClickable =
    !isUpdateDisabled && (updateAvailable || (!isChecking && !showUpToDate));

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {isUpdateClickable ? (
        <button
          type="button"
          onClick={getUpdateStatusAction()}
          disabled={isUpdateDisabled}
          className={`transition-colors disabled:opacity-50 tabular-nums ${
            updateAvailable
              ? "text-logo-primary hover:text-logo-primary/80 font-medium"
              : "text-text/60 hover:text-text/80"
          }`}
        >
          {getUpdateStatusText()}
        </button>
      ) : (
        <span className="text-text/60 tabular-nums">
          {getUpdateStatusText()}
        </span>
      )}

      {isInstalling && downloadProgress > 0 && downloadProgress < 100 && (
        <ProgressBar
          progress={[
            {
              id: "update",
              percentage: downloadProgress,
            },
          ]}
          size="large"
        />
      )}
    </div>
  );
};

export default UpdateChecker;
