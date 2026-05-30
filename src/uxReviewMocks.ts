type ReviewSessionState =
  | "idle"
  | "live"
  | "saved"
  | "missing-summary"
  | "history";

type EventListenerRecord = {
  event: string;
  handler: number;
};

const reviewParams = new URLSearchParams(window.location.search);
const reviewState = (reviewParams.get("state") ||
  "saved") as ReviewSessionState;
const eventListeners = new Map<number, EventListenerRecord>();
const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallbackId = 1;
let nextEventId = 1;

const bindings = {
  transcribe: {
    name: "Transcribe Shortcut",
    description: "The keyboard shortcut to record and transcribe your voice.",
    default_binding: "ctrl+space",
    current_binding: "ctrl+space",
  },
  transcribe_full_system_audio: {
    name: "Meeting Recording Shortcut",
    description:
      "A dedicated shortcut that starts and stops meeting recording.",
    default_binding: "ctrl+fn",
    current_binding: "ctrl+fn",
  },
  transcribe_with_post_process: {
    name: "Post-Processing Hotkey",
    description:
      "Optional: A dedicated hotkey that always applies AI post-processing to your transcription.",
    default_binding: "ctrl+shift+space",
    current_binding: "ctrl+shift+space",
  },
  edit_mode: {
    name: "Edit Mode Shortcut",
    description: "Transforms selected text using a spoken instruction.",
    default_binding: "ctrl+shift+e",
    current_binding: "ctrl+shift+e",
  },
  cancel: {
    name: "Cancel Shortcut",
    description: "The keyboard shortcut to cancel the current recording.",
    default_binding: "escape",
    current_binding: "escape",
  },
};

const sampleSettings = {
  record_full_system_audio: false,
  always_on_microphone: false,
  selected_microphone: "Default",
  clamshell_microphone: "Default",
  selected_output_device: "Default",
  push_to_talk: false,
  onboarding_completed: true,
  keyboard_implementation: "tauri",
  post_process_enabled: false,
  byok_enabled: true,
  debug_mode: false,
  show_tray_icon: true,
  bindings,
};

const sampleHistoryEntries = [
  {
    id: 7,
    file_name: "uttr-session.wav",
    timestamp: 1_717_200_000,
    saved: false,
    title: "Session",
    transcription_text:
      "every single month. It makes it easier for people to at least hold Bitcoin or buy back into Bitcoin. And I think we are in this healing process.",
    post_processed_text:
      "## Current gist\nThe meeting is about market confidence and how recurring Bitcoin accumulation affects sentiment.\n\n## Key points\n- Recurring accumulation is framed as easier to maintain.\n  - Participants described monthly buying as a habit that can help people keep holding Bitcoin or return to it after stepping away.\n  - The point was less about a single trade and more about how repeated behavior can rebuild confidence over time.\n- Higher prices are connected to improving sentiment.\n  - The discussion treats price recovery as part of a broader healing process.\n  - Participants suggested that optimism improves when people see the market validating their patience.",
    post_process_prompt: "Live session summary via OpenAI after 2 chunk(s)",
    recording_source: "full_system_audio",
  },
  {
    id: 8,
    file_name: "uttr-dictation.wav",
    timestamp: 1_717_196_400,
    saved: true,
    title: "Dictation",
    transcription_text: "Send the updated session notes after lunch.",
    post_processed_text: null,
    post_process_prompt: null,
    recording_source: "dictation",
  },
];

const sessionStates = {
  idle: {
    stage: "idle",
    title: "Open Uttr",
    subtitle: "",
    progressLabel: "",
    progressValue: 0,
    summaryText: null,
    rawTranscriptText: null,
    historyEntryId: null,
  },
  live: {
    stage: "active",
    title: "Live session",
    subtitle: "Capturing system audio and microphone audio.",
    progressLabel: "Chunk 2 summarized",
    progressValue: 0,
    summaryText:
      "## Current gist\nThe meeting is about Bitcoin confidence, monthly accumulation, and whether the discussion belongs in market notes.\n\n## Key points\n- Monthly accumulation is being treated as a confidence signal.\n  - Participants connected recurring buying with a lower-friction way to stay exposed while sentiment recovers.\n  - The conversation frames this as a behavioral pattern rather than a one-time market call.\n- Price recovery is improving the tone of the discussion.\n  - Higher prices are described as making it easier for people to feel optimistic again.\n  - The group is still cautious, but the language suggests confidence is returning.",
    rawTranscriptText: null,
    historyEntryId: null,
  },
  saved: {
    stage: "complete",
    title: "Session saved",
    subtitle: "The transcript is ready under Meetings.",
    progressLabel: "Complete",
    progressValue: 1,
    summaryText: sampleHistoryEntries[0].post_processed_text,
    rawTranscriptText: sampleHistoryEntries[0].transcription_text,
    historyEntryId: sampleHistoryEntries[0].id,
  },
  "missing-summary": {
    stage: "complete",
    title: "Session saved",
    subtitle: "The transcript is ready under Meetings.",
    progressLabel: "Complete",
    progressValue: 1,
    summaryText: null,
    rawTranscriptText: sampleHistoryEntries[0].transcription_text,
    historyEntryId: sampleHistoryEntries[0].id,
  },
  history: {
    stage: "idle",
    title: "Open Uttr",
    subtitle: "",
    progressLabel: "",
    progressValue: 0,
    summaryText: null,
    rawTranscriptText: null,
    historyEntryId: null,
  },
} as const;

const dispatchTauriEvent = (event: string, payload: unknown) => {
  eventListeners.forEach((listener, id) => {
    if (listener.event !== event) {
      return;
    }

    callbacks.get(listener.handler)?.({
      event,
      id,
      payload,
    });
  });
};

const installUxReviewToolbar = () => {
  const toolbar = document.createElement("nav");
  toolbar.setAttribute("aria-label", "UX review states");
  toolbar.style.cssText = [
    "position:fixed",
    "left:16px",
    "bottom:16px",
    "z-index:9998",
    "display:flex",
    "gap:6px",
    "padding:8px",
    "border:1px solid rgba(255,255,255,0.12)",
    "border-radius:999px",
    "background:rgba(5,10,18,0.86)",
    "backdrop-filter:blur(14px)",
    "box-shadow:0 12px 34px rgba(0,0,0,0.32)",
    "font:12px Space Grotesk, Avenir Next, Segoe UI, sans-serif",
  ].join(";");

  const states: Array<[ReviewSessionState, string]> = [
    ["idle", "Idle"],
    ["live", "Live"],
    ["saved", "Saved"],
    ["missing-summary", "No summary"],
    ["history", "Transcriptions"],
  ];

  toolbar.innerHTML = states
    .map(([state, label]) => {
      const active = state === reviewState;
      const href = `/ux-review.html?state=${encodeURIComponent(state)}`;
      const style = [
        "display:inline-flex",
        "align-items:center",
        "height:28px",
        "padding:0 10px",
        "border-radius:999px",
        "text-decoration:none",
        active
          ? "background:rgba(103,215,163,0.18);color:#67d7a3"
          : "background:rgba(255,255,255,0.05);color:rgba(230,237,243,0.72)",
      ].join(";");
      return `<a href="${href}" style="${style}">${label}</a>`;
    })
    .join("");

  document.body.appendChild(toolbar);
};

const installInitialNavigation = () => {
  if (reviewState !== "history") {
    return;
  }

  window.setTimeout(() => {
    const transcriptionsButton = Array.from(
      document.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Transcriptions");
    transcriptionsButton?.click();
  }, 250);
};

(window as any).__UTTR_E2E__ = {
  settings: sampleSettings,
  defaultSettings: sampleSettings,
  installAccess: {
    install_id: "ux-review-install",
    device_fingerprint_hash: "ux-review-fingerprint",
    trial_state: "linked",
    access_state: "subscribed",
    entitlement_state: "active",
    byok_enabled: true,
    byok_validation_state: "unvalidated",
    has_byok_secret: true,
    has_install_token: false,
    dev_access_override: null,
  },
  customSounds: { start: true, stop: true },
  fullSystemAudio: {
    supportStatus: {
      supported: true,
      reason: "Full-system audio recording is supported in UX review mode.",
    },
    readinessStatus: {
      supported: true,
      ready: true,
      reason: "Screen Recording access is mocked in UX review mode.",
    },
  },
  historyEntries: sampleHistoryEntries,
  sessionWindowState: sessionStates[reviewState] || sessionStates.saved,
};

(window as any).isTauri = true;
(window as any).__TAURI_OS_PLUGIN_INTERNALS__ = {
  platform: "macos",
  os_type: "macos",
  family: "unix",
  arch: "aarch64",
  eol: "\n",
  version: "14.0",
  exe_extension: "",
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (_event: string, eventId: number) => {
    eventListeners.delete(eventId);
  },
};
(window as any).__TAURI_INTERNALS__ = {
  async invoke(cmd: string, args: Record<string, any> = {}) {
    const review = (window as any).__UTTR_E2E__;

    switch (cmd) {
      case "plugin:app|version":
        return `${__UTTR_APP_VERSION__}-ux-review`;
      case "plugin:macos-permissions|check_accessibility_permission":
      case "plugin:macos-permissions|check_microphone_permission":
        return true;
      case "plugin:macos-permissions|request_accessibility_permission":
      case "plugin:macos-permissions|request_microphone_permission":
        return null;
      case "plugin:event|listen": {
        const eventId = nextEventId++;
        eventListeners.set(eventId, {
          event: args.event,
          handler: args.handler,
        });
        return eventId;
      }
      case "plugin:event|unlisten":
        eventListeners.delete(args.eventId);
        return null;
      case "plugin:event|emit":
        dispatchTauriEvent(args.event, args.payload);
        return null;
      case "get_current_model":
      case "get_transcription_model_status":
        return "parakeet-tdt-0.6b-v3";
      case "has_any_models_available":
      case "initialize_enigo":
      case "initialize_shortcuts":
      case "is_recording":
        return cmd === "is_recording"
          ? review.sessionWindowState?.stage === "active"
          : true;
      case "get_available_models":
        return [
          {
            id: "parakeet-tdt-0.6b-v3",
            name: "Parakeet",
            description: "Local review model",
            filename: "parakeet.bin",
            url: null,
            size_mb: 1,
            is_downloaded: true,
            is_downloading: false,
            partial_size: 0,
            is_directory: false,
            engine_type: "speech",
            accuracy_score: 1,
            speed_score: 1,
            supports_translation: false,
            is_recommended: true,
            supported_languages: ["en"],
            is_custom: false,
          },
        ];
      case "get_app_settings":
      case "get_default_settings":
        return review.settings;
      case "get_install_access_snapshot":
        return review.installAccess;
      case "get_post_process_api_key_statuses":
        return { openai: true, groq: false };
      case "get_available_microphones":
      case "get_available_output_devices":
        return [];
      case "check_custom_sounds":
        return review.customSounds;
      case "get_full_system_audio_support_status":
        return review.fullSystemAudio.supportStatus;
      case "get_full_system_audio_readiness_status":
        return review.fullSystemAudio.readinessStatus;
      case "set_record_full_system_audio_enabled":
        review.settings = {
          ...review.settings,
          record_full_system_audio: Boolean(args.enabled),
        };
        return {
          requested_enabled: Boolean(args.enabled),
          stored_enabled: Boolean(args.enabled),
          support: review.fullSystemAudio.supportStatus,
          readiness: review.fullSystemAudio.readinessStatus,
        };
      case "get_history_entries":
        return review.historyEntries;
      case "get_audio_file_path":
        return `/tmp/${args.fileName || "uttr-review.wav"}`;
      case "start_full_system_audio_session":
        review.sessionWindowState = sessionStates.live;
        dispatchTauriEvent("session-window-state", review.sessionWindowState);
        return null;
      case "stop_full_system_audio_session":
        review.sessionWindowState = sessionStates.saved;
        dispatchTauriEvent("session-window-state", {
          ...sessionStates.saved,
          progressLabel: "Complete",
        });
        return null;
      case "toggle_history_entry_saved":
        review.historyEntries = review.historyEntries.map((entry: any) =>
          entry.id === args.id ? { ...entry, saved: !entry.saved } : entry,
        );
        dispatchTauriEvent("history-updated", null);
        return null;
      case "delete_history_entry":
        review.historyEntries = review.historyEntries.filter(
          (entry: any) => entry.id !== args.id,
        );
        dispatchTauriEvent("history-updated", null);
        return null;
      default:
        return null;
    }
  },
  transformCallback(callback: (payload: unknown) => void, once = false) {
    const id = nextCallbackId++;
    callbacks.set(id, (payload) => {
      if (once) {
        callbacks.delete(id);
      }
      callback(payload);
    });
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  runCallback(id: number, payload: unknown) {
    callbacks.get(id)?.(payload);
  },
  callbacks,
  convertFileSrc(filePath: string) {
    return filePath;
  },
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  },
};

window.addEventListener("DOMContentLoaded", () => {
  installUxReviewToolbar();
  installInitialNavigation();
});
