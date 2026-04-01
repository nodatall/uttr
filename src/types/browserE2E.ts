import type {
  AppSettings as Settings,
  AudioDevice,
  FullSystemAudioReadinessStatus,
  FullSystemAudioSupportStatus,
  InstallAccessSnapshot,
} from "@/bindings";

export type BrowserE2ETestState = {
  settings?: Partial<Settings>;
  defaultSettings?: Partial<Settings>;
  installAccess?: InstallAccessSnapshot;
  audioDevices?: AudioDevice[];
  outputDevices?: AudioDevice[];
  customSounds?: { start: boolean; stop: boolean };
  fullSystemAudio?: {
    supportStatus?: FullSystemAudioSupportStatus | null;
    readinessStatus?: FullSystemAudioReadinessStatus | null;
  };
};

declare global {
  interface Window {
    __UTTR_E2E__?: BrowserE2ETestState;
  }
}
