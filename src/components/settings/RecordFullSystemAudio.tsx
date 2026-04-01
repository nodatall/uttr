import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import {
  commands,
  type FullSystemAudioReadinessStatus,
  type FullSystemAudioSupportStatus,
} from "@/bindings";
import type { BrowserE2ETestState } from "@/types/browserE2E";

interface RecordFullSystemAudioProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const getBrowserE2ETestState = () =>
  typeof window !== "undefined" ? window.__UTTR_E2E__ : undefined;

export const RecordFullSystemAudio: React.FC<RecordFullSystemAudioProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, refreshSettings } = useSettings();
    const [supportStatus, setSupportStatus] =
      useState<FullSystemAudioSupportStatus | null>(null);
    const [readinessStatus, setReadinessStatus] =
      useState<FullSystemAudioReadinessStatus | null>(null);
    const [statusLoaded, setStatusLoaded] = useState(false);
    const [isUpdating, setIsUpdating] = useState(false);
    const [pendingRetry, setPendingRetry] = useState(false);

    const recordFullSystemAudio =
      getSetting("record_full_system_audio") || false;

    const refreshStatus = useCallback(async () => {
      const testState = getBrowserE2ETestState();
      if (testState?.fullSystemAudio) {
        const support = testState.fullSystemAudio.supportStatus ?? null;
        const readiness = testState.fullSystemAudio.readinessStatus ?? null;
        setSupportStatus(support);
        setReadinessStatus(readiness);
        setStatusLoaded(true);
        return { support, readiness };
      }

      try {
        const [support, readiness] = await Promise.all([
          commands.getFullSystemAudioSupportStatus(),
          commands.getFullSystemAudioReadinessStatus(),
        ]);
        setSupportStatus(support);
        setReadinessStatus(readiness);
        return { support, readiness };
      } catch (error) {
        console.error("Failed to refresh full-system audio status:", error);
        return { support: null, readiness: null };
      } finally {
        setStatusLoaded(true);
      }
    }, []);

    const attemptEnable = useCallback(async () => {
      setIsUpdating(true);

      try {
        const result = await commands.setRecordFullSystemAudioEnabled(true);

        if (result.stored_enabled) {
          setPendingRetry(false);
          await refreshSettings();
        } else if (
          result.requested_enabled &&
          !result.stored_enabled &&
          result.readiness.supported &&
          !result.readiness.ready
        ) {
          setPendingRetry(true);
        } else {
          setPendingRetry(false);
        }

        setSupportStatus(result.support);
        setReadinessStatus(result.readiness);
      } catch (error) {
        console.error("Failed to enable full-system audio recording:", error);
      } finally {
        setIsUpdating(false);
      }
    }, [refreshSettings]);

    const disableFeature = useCallback(async () => {
      setIsUpdating(true);

      try {
        await commands.setRecordFullSystemAudioEnabled(false);
        setPendingRetry(false);
        await refreshSettings();
        await refreshStatus();
      } catch (error) {
        console.error("Failed to disable full-system audio recording:", error);
      } finally {
        setIsUpdating(false);
      }
    }, [refreshSettings, refreshStatus]);

    useEffect(() => {
      void refreshStatus();
    }, [refreshStatus]);

    useEffect(() => {
      if (recordFullSystemAudio) {
        setPendingRetry(false);
      }
    }, [recordFullSystemAudio]);

    useEffect(() => {
      const handleFocus = async () => {
        const latestStatus = await refreshStatus();

        if (pendingRetry && latestStatus.readiness?.ready) {
          await attemptEnable();
        }
      };

      window.addEventListener("focus", handleFocus);
      return () => window.removeEventListener("focus", handleFocus);
    }, [attemptEnable, pendingRetry, refreshStatus]);

    const effectiveSupport = useMemo(() => {
      if (supportStatus) {
        return supportStatus;
      }

      if (readinessStatus) {
        return {
          supported: readinessStatus.supported,
          reason: readinessStatus.reason,
        };
      }

      return null;
    }, [readinessStatus, supportStatus]);

    const isSupported = effectiveSupport?.supported ?? false;
    const isReady = readinessStatus?.ready ?? false;
    const permissionReason =
      readinessStatus?.reason ??
      t("settings.sound.fullSystemAudio.permissionRequired");
    const supportReason =
      effectiveSupport?.reason ??
      t("settings.sound.fullSystemAudio.unsupportedDescription");

    const description = !statusLoaded
      ? t("settings.sound.fullSystemAudio.loading")
      : !supportStatus && !readinessStatus
        ? t("settings.sound.fullSystemAudio.statusCheckFailed")
        : !isSupported
          ? supportReason
          : !readinessStatus
            ? t("settings.sound.fullSystemAudio.statusCheckFailed")
            : isReady
              ? t("settings.sound.fullSystemAudio.description")
              : pendingRetry
                ? t("settings.sound.fullSystemAudio.pendingDescription", {
                    reason: permissionReason,
                  })
                : permissionReason;
    const isDisabled = !statusLoaded || !isSupported || isUpdating;

    return (
      <SettingContainer
        title={t("settings.sound.fullSystemAudio.title")}
        description={description}
        descriptionMode={descriptionMode}
        grouped={grouped}
        disabled={isDisabled}
      >
        <div className="flex flex-col items-end gap-2">
          <div className="max-w-64 text-right text-xs leading-5 text-mid-gray">
            {description}
          </div>
          <label
            className={`inline-flex items-center ${isDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              aria-label={t("settings.sound.fullSystemAudio.title")}
              data-testid="record-full-system-audio-toggle"
              value=""
              className="sr-only peer"
              checked={recordFullSystemAudio}
              disabled={isDisabled}
              onChange={(e) => {
                if (e.target.checked) {
                  void attemptEnable();
                } else {
                  void disableFeature();
                }
              }}
            />
            <div className="relative h-6 w-11 rounded-full bg-white/[0.09] transition-colors peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-logo-primary/25 peer-checked:bg-background-ui/90 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-disabled:opacity-50 after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-white/14 after:bg-white after:shadow-[0_2px_8px_rgba(15,23,42,0.35)] after:transition-all after:content-['']" />
          </label>
        </div>
      </SettingContainer>
    );
  });
