import { expect, test, type Page } from "@playwright/test";

type FullSystemAudioTestState = {
  settings: {
    record_full_system_audio: boolean;
    always_on_microphone: boolean;
    selected_microphone: string;
    clamshell_microphone: string;
    selected_output_device: string;
    push_to_talk: boolean;
    onboarding_completed: boolean;
    keyboard_implementation: "tauri";
    post_process_enabled: boolean;
    byok_enabled: boolean;
    debug_mode: boolean;
    show_tray_icon: boolean;
    bindings: Record<
      string,
      {
        name: string;
        description: string;
        default_binding: string;
        current_binding: string;
      }
    >;
  };
  defaultSettings: {
    record_full_system_audio: boolean;
    always_on_microphone: boolean;
    selected_microphone: string;
    clamshell_microphone: string;
    selected_output_device: string;
    push_to_talk: boolean;
    onboarding_completed: boolean;
    keyboard_implementation: "tauri";
    post_process_enabled: boolean;
    byok_enabled: boolean;
    debug_mode: boolean;
    show_tray_icon: boolean;
    bindings: Record<
      string,
      {
        name: string;
        description: string;
        default_binding: string;
        current_binding: string;
      }
    >;
  };
  installAccess: {
    install_id: string;
    device_fingerprint_hash: string;
    trial_state: "linked";
    access_state: "subscribed";
    entitlement_state: "active";
    byok_enabled: boolean;
    byok_validation_state: "unvalidated";
    has_byok_secret: boolean;
    has_install_token: boolean;
    dev_access_override: string | null;
  };
  customSounds: { start: boolean; stop: boolean };
  invokedCommands: Array<{
    cmd: string;
    args: Record<string, unknown>;
  }>;
  startedFullSystemAudioSessions: number;
  stoppedFullSystemAudioSessions: number;
  historyEntries: Array<{
    id: number;
    file_name: string;
    timestamp: number;
    saved: boolean;
    title: string;
    transcription_text: string;
    post_processed_text: string | null;
    post_process_prompt: string | null;
    recording_source: string;
  }>;
  startFullSystemAudioSessionEvent?: {
    stage: string;
    title: string;
    subtitle: string;
    progressLabel: string;
    progressValue: number;
    summaryText: string | null;
    rawTranscriptText: string | null;
    historyEntryId: number | null;
  };
  sessionWindowState?: {
    stage: string;
    title: string;
    subtitle: string;
    progressLabel: string;
    progressValue: number;
    summaryText: string | null;
    rawTranscriptText: string | null;
    historyEntryId: number | null;
  };
  fullSystemAudio: {
    supportStatus: {
      supported: boolean;
      reason: string;
    };
    readinessStatus: {
      supported: boolean;
      ready: boolean;
      reason: string;
    };
  };
};

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
  cancel: {
    name: "Cancel Shortcut",
    description: "The keyboard shortcut to cancel the current recording.",
    default_binding: "escape",
    current_binding: "escape",
  },
};

const createTestState = (
  recordFullSystemAudio: boolean,
  supported: boolean,
): FullSystemAudioTestState => ({
  settings: {
    record_full_system_audio: recordFullSystemAudio,
    always_on_microphone: false,
    selected_microphone: "Default",
    clamshell_microphone: "Default",
    selected_output_device: "Default",
    push_to_talk: false,
    onboarding_completed: true,
    keyboard_implementation: "tauri",
    post_process_enabled: false,
    byok_enabled: false,
    debug_mode: false,
    show_tray_icon: true,
    bindings,
  },
  defaultSettings: {
    record_full_system_audio: false,
    always_on_microphone: false,
    selected_microphone: "Default",
    clamshell_microphone: "Default",
    selected_output_device: "Default",
    push_to_talk: false,
    onboarding_completed: true,
    keyboard_implementation: "tauri",
    post_process_enabled: false,
    byok_enabled: false,
    debug_mode: false,
    show_tray_icon: true,
    bindings,
  },
  installAccess: {
    install_id: "test-install-id",
    device_fingerprint_hash: "test-fingerprint",
    trial_state: "linked",
    access_state: "subscribed",
    entitlement_state: "active",
    byok_enabled: false,
    byok_validation_state: "unvalidated",
    has_byok_secret: false,
    has_install_token: false,
    dev_access_override: null,
  },
  customSounds: { start: true, stop: true },
  invokedCommands: [],
  startedFullSystemAudioSessions: 0,
  stoppedFullSystemAudioSessions: 0,
  historyEntries: [],
  fullSystemAudio: supported
    ? {
        supportStatus: {
          supported: true,
          reason: "Full-system audio recording is supported on this host.",
        },
        readinessStatus: {
          supported: true,
          ready: true,
          reason: "Screen Recording access is ready.",
        },
      }
    : {
        supportStatus: {
          supported: false,
          reason: "This feature is available only on macOS 13 or later.",
        },
        readinessStatus: {
          supported: false,
          ready: false,
          reason:
            "Screen Recording access is required before this can be enabled. Microphone access alone is not enough.",
        },
      },
});

async function installBrowserMocks(
  page: Page,
  state: FullSystemAudioTestState,
) {
  await page.addInitScript((testState) => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    const eventListeners = new Map<
      number,
      { event: string; handler: number }
    >();
    let nextCallbackId = 1;
    let nextEventId = 1;

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

    (
      window as unknown as { __UTTR_E2E__: FullSystemAudioTestState }
    ).__UTTR_E2E__ = testState;
    (window as unknown as { isTauri: boolean }).isTauri = true;
    (
      window as unknown as {
        __TAURI_OS_PLUGIN_INTERNALS__: {
          platform: string;
          os_type: string;
          family: string;
          arch: string;
          eol: string;
          version: string;
          exe_extension: string;
        };
      }
    ).__TAURI_OS_PLUGIN_INTERNALS__ = {
      platform: "macos",
      os_type: "macos",
      family: "unix",
      arch: "aarch64",
      eol: "\n",
      version: "14.0",
      exe_extension: "",
    };
    (
      window as unknown as {
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: () => void;
        };
      }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, eventId: number) => {
        eventListeners.delete(eventId);
      },
    };
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            cmd: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
          transformCallback: (
            callback: (payload: unknown) => void,
            once?: boolean,
          ) => number;
          unregisterCallback: (id: number) => void;
          runCallback: (id: number, payload: unknown) => void;
          callbacks: Map<number, (payload: unknown) => void>;
          convertFileSrc: (filePath: string) => string;
          metadata: {
            currentWindow: { label: string };
            currentWebview: { windowLabel: string; label: string };
          };
        };
      }
    ).__TAURI_INTERNALS__ = {
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        const e2eState = (
          window as unknown as { __UTTR_E2E__: FullSystemAudioTestState }
        ).__UTTR_E2E__;
        e2eState.invokedCommands.push({ cmd, args });

        switch (cmd) {
          case "plugin:app|version":
            return "0.1.2-test";
          case "plugin:macos-permissions|check_accessibility_permission":
          case "plugin:macos-permissions|check_microphone_permission":
            return true;
          case "plugin:macos-permissions|request_accessibility_permission":
          case "plugin:macos-permissions|request_microphone_permission":
            return null;
          case "plugin:event|listen": {
            const eventId = nextEventId++;
            eventListeners.set(eventId, {
              event: String(args.event),
              handler: Number(args.handler),
            });
            return eventId;
          }
          case "plugin:event|unlisten":
            eventListeners.delete(Number(args.eventId));
            return null;
          case "get_current_model":
            return "parakeet-tdt-0.6b-v3";
          case "has_any_models_available":
            return true;
          case "get_available_models":
            return [
              {
                id: "parakeet-tdt-0.6b-v3",
                name: "Parakeet",
                description: "Test model",
                filename: "parakeet.bin",
                url: null,
                size_mb: 1,
                is_downloaded: true,
                is_downloading: false,
                partial_size: 0,
                is_directory: false,
                engine_type: "speech" as const,
                accuracy_score: 1,
                speed_score: 1,
                supports_translation: false,
                is_recommended: true,
                supported_languages: ["en"],
                is_custom: false,
              },
            ];
          case "get_transcription_model_status":
            return "parakeet-tdt-0.6b-v3";
          case "get_app_settings":
            return e2eState.settings;
          case "get_default_settings":
            return e2eState.defaultSettings;
          case "get_install_access_snapshot":
            return e2eState.installAccess;
          case "get_history_entries":
            return e2eState.historyEntries;
          case "check_custom_sounds":
            return e2eState.customSounds;
          case "get_available_microphones":
          case "get_available_output_devices":
            return [];
          case "get_full_system_audio_support_status":
            return e2eState.fullSystemAudio.supportStatus;
          case "get_full_system_audio_readiness_status":
            return e2eState.fullSystemAudio.readinessStatus;
          case "set_record_full_system_audio_enabled":
            if (args.enabled) {
              e2eState.settings.record_full_system_audio = true;
            } else {
              e2eState.settings.record_full_system_audio = false;
            }

            return {
              requested_enabled: Boolean(args.enabled),
              stored_enabled: Boolean(args.enabled),
              support: e2eState.fullSystemAudio.supportStatus,
              readiness: e2eState.fullSystemAudio.readinessStatus,
            };
          case "start_full_system_audio_session":
            e2eState.startedFullSystemAudioSessions += 1;
            if (e2eState.startFullSystemAudioSessionEvent) {
              e2eState.sessionWindowState =
                e2eState.startFullSystemAudioSessionEvent;
              dispatchTauriEvent(
                "session-window-state",
                e2eState.startFullSystemAudioSessionEvent,
              );
            }
            return null;
          case "stop_full_system_audio_session":
            e2eState.stoppedFullSystemAudioSessions += 1;
            return null;
          case "change_binding":
            return { success: true, error: null };
          case "reset_binding":
            return { success: true, error: null };
          case "suspend_binding":
          case "resume_binding":
          case "initialize_enigo":
          case "initialize_shortcuts":
          case "change_ptt_setting":
          case "change_audio_feedback_setting":
          case "change_audio_feedback_volume_setting":
          case "change_sound_theme_setting":
          case "change_start_hidden_setting":
          case "change_autostart_setting":
          case "change_translate_to_english_setting":
          case "change_selected_language_setting":
          case "change_overlay_position_setting":
          case "change_word_correction_threshold_setting":
          case "change_paste_method_setting":
          case "change_typing_tool_setting":
          case "change_clipboard_handling_setting":
          case "change_auto_submit_setting":
          case "change_auto_submit_key_setting":
          case "change_post_process_enabled_setting":
          case "change_post_process_base_url_setting":
          case "change_post_process_api_key_setting":
          case "change_post_process_model_setting":
          case "set_post_process_provider":
          case "change_post_process_cleaning_prompt_preset":
          case "update_custom_words":
          case "change_post_process_timeout_setting":
          case "change_post_process_system_prompt_setting":
          case "change_mute_while_recording_setting":
          case "change_append_trailing_space_setting":
          case "change_app_language_setting":
          case "change_update_checks_setting":
          case "change_keyboard_implementation_setting":
          case "change_show_tray_icon_setting":
          case "update_microphone_mode":
          case "change_byok_enabled_setting":
          case "validate_byok_groq_key":
          case "set_selected_microphone":
          case "set_selected_output_device":
          case "set_clamshell_microphone":
          case "play_test_sound":
          case "get_available_typing_tools":
            return null;
          case "change_debug_mode_setting":
            e2eState.settings.debug_mode = Boolean(args.enabled);
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
  }, state);
}

test.describe("full-system audio settings", () => {
  test("starts a full-system session from Home without file or side cards", async ({
    page,
  }) => {
    await installBrowserMocks(page, createTestState(false, true));

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");

    await expect(
      workspace.getByRole("button", { name: /^Start$/i }),
    ).toBeVisible();
    await expect(
      workspace.getByRole("button", { name: /^Files$/i }),
    ).toHaveCount(0);
    await expect(
      workspace.getByRole("button", { name: /^History$/i }),
    ).toBeVisible();
    await expect(workspace.getByText("Past meetings")).toHaveCount(0);
    await expect(workspace.getByText("Capture")).toHaveCount(0);
    await expect(workspace.getByText("Recent surfaces")).toHaveCount(0);

    await workspace.getByRole("button", { name: /^Start$/i }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __UTTR_E2E__: FullSystemAudioTestState;
              }
            ).__UTTR_E2E__.startedFullSystemAudioSessions,
        ),
      )
      .toBe(1);
  });

  test("returns from Starting when a session start falls back to idle", async ({
    page,
  }) => {
    const state = createTestState(false, true);
    state.startFullSystemAudioSessionEvent = {
      stage: "idle",
      title: "Open Uttr",
      subtitle: "",
      progressLabel: "",
      progressValue: 0,
      summaryText: null,
      rawTranscriptText: null,
      historyEntryId: null,
    };
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await workspace.getByRole("button", { name: /^Start$/i }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __UTTR_E2E__: FullSystemAudioTestState;
              }
            ).__UTTR_E2E__.startedFullSystemAudioSessions,
        ),
      )
      .toBe(1);
    await expect(
      workspace.getByRole("button", { name: /^Start$/i }),
    ).toBeVisible();
    await expect(
      workspace.getByRole("button", { name: /^Starting$/i }),
    ).toHaveCount(0);
  });

  test("stops a live full-system session from Home", async ({ page }) => {
    const state = createTestState(false, true);
    state.sessionWindowState = {
      stage: "active",
      title: "Live session",
      subtitle: "Capturing system audio and microphone audio.",
      progressLabel: "Recording",
      progressValue: 0,
      summaryText: null,
      rawTranscriptText: null,
      historyEntryId: null,
    };
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await expect(
      workspace.getByRole("button", { name: /^Stop$/i }),
    ).toBeVisible();
    await expect(
      workspace.getByRole("button", { name: /^Start$/i }),
    ).toHaveCount(0);
    await expect(
      workspace.getByRole("button", { name: /^History$/i }),
    ).toHaveCount(0);

    await workspace.getByRole("button", { name: /^Stop$/i }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __UTTR_E2E__: FullSystemAudioTestState;
              }
            ).__UTTR_E2E__.stoppedFullSystemAudioSessions,
        ),
      )
      .toBe(1);
  });

  test("keeps the live meeting timer when switching tabs", async ({ page }) => {
    const state = createTestState(false, true);
    state.sessionWindowState = {
      stage: "active",
      title: "Live session",
      subtitle: "Capturing system audio and microphone audio.",
      progressLabel: "Recording",
      progressValue: 0,
      summaryText: null,
      rawTranscriptText: null,
      historyEntryId: null,
    };
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await expect(workspace.getByText(/^0:0[1-9]$/).first()).toBeVisible({
      timeout: 10000,
    });

    await page.getByRole("button", { name: /Settings/i }).click();
    await page.getByRole("button", { name: /^Meetings$/i }).click();

    const returnedWorkspace = page.getByTestId("home-workspace");
    await expect(returnedWorkspace.getByText(/^0:00$/)).toHaveCount(0);
    await expect(
      returnedWorkspace.getByText(/^0:0[1-9]$/).first(),
    ).toBeVisible();
  });

  test("shows saved session summary separately from the raw transcript", async ({
    page,
  }) => {
    const state = createTestState(false, true);
    state.sessionWindowState = {
      stage: "complete",
      title: "Session saved",
      subtitle: "The transcript is ready under Meetings.",
      progressLabel: "Complete",
      progressValue: 1,
      summaryText: "Bitcoin sentiment improved as recurring buying continued.",
      rawTranscriptText:
        "every single month. It makes it easier for people to at least hold Bitcoin or buy back into Bitcoin.",
      historyEntryId: 42,
    };
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await expect(
      workspace.getByText(
        "Bitcoin sentiment improved as recurring buying continued.",
      ),
    ).toBeVisible();
    await expect(workspace.getByText("every single month.")).toHaveCount(0);

    await workspace.getByRole("button", { name: /Raw transcript/i }).click();

    const dialog = page.getByRole("dialog", { name: /Raw transcript/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("every single month.")).toBeVisible();
  });

  test("hides legacy action and timeline sections in saved meetings", async ({
    page,
  }) => {
    const state = createTestState(false, true);
    state.sessionWindowState = {
      stage: "complete",
      title: "Session saved",
      subtitle: "The transcript is ready under Meetings.",
      progressLabel: "Complete",
      progressValue: 1,
      summaryText:
        "## Current gist\nLegacy meeting gist.\n\n## Key points\n- Keep this point.\n\n## Action items\n- Task: Old task that should not show.\n\n## Timeline\n- 00:10 - Old timeline item that should not show.",
      rawTranscriptText: "raw transcript",
      historyEntryId: 43,
    };
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await expect(workspace.getByText("Legacy meeting gist.")).toBeVisible();
    await expect(workspace.getByText("Keep this point.")).toBeVisible();
    await expect(
      workspace.getByText(/Old task that should not show/),
    ).toHaveCount(0);
    await expect(
      workspace.getByText(/Old timeline item that should not show/),
    ).toHaveCount(0);
  });

  test("opens a saved meeting from Meetings history with its summary", async ({
    page,
  }) => {
    const state = createTestState(false, true);
    state.historyEntries = [
      {
        id: 7,
        file_name: "session.wav",
        timestamp: 1_717_200_000,
        saved: false,
        title: "Session",
        transcription_text:
          "raw session words about bitcoin confidence returning over time.",
        post_processed_text:
          "Session summary: confidence improved as participants discussed recurring accumulation.",
        post_process_prompt: "Live session summary via OpenAI after 1 chunk(s)",
        recording_source: "full_system_audio",
      },
    ];
    await installBrowserMocks(page, state);

    await page.goto("/");
    await page.getByRole("button", { name: /^History$/i }).click();
    await page
      .getByRole("button", { name: /Session summary: confidence improved/i })
      .click();

    const workspace = page.getByTestId("home-workspace");
    await expect(
      workspace.getByRole("paragraph").filter({
        hasText:
          "Session summary: confidence improved as participants discussed recurring accumulation.",
      }),
    ).toBeVisible();
    await expect(workspace.getByText("raw session words")).toHaveCount(0);

    await workspace.getByRole("button", { name: /Raw transcript/i }).click();
    await expect(
      page
        .getByRole("dialog", { name: /Raw transcript/i })
        .getByText(
          "raw session words about bitcoin confidence returning over time.",
        ),
    ).toBeVisible();
  });

  test("keeps meetings on Meetings and dictations on Transcriptions", async ({
    page,
  }) => {
    const state = createTestState(false, true);
    state.historyEntries = [
      {
        id: 7,
        file_name: "session.wav",
        timestamp: 1_717_200_000,
        saved: false,
        title: "Session",
        transcription_text: "raw meeting transcript",
        post_processed_text:
          "## Current gist\nMeeting summary.\n\n## Key points\n- Meeting-only point.",
        post_process_prompt: "Live session summary via OpenAI after 1 chunk(s)",
        recording_source: "full_system_audio",
      },
      {
        id: 8,
        file_name: "dictation.wav",
        timestamp: 1_717_196_400,
        saved: false,
        title: "Dictation",
        transcription_text: "normal dictation transcript",
        post_processed_text: null,
        post_process_prompt: null,
        recording_source: "dictation",
      },
    ];
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await expect(
      workspace.getByRole("button", { name: /^Start$/i }),
    ).toBeVisible();
    await expect(workspace.getByText("Past meetings")).toHaveCount(0);
    await workspace.getByRole("button", { name: /^History$/i }).click();
    await expect(workspace.getByText("Past meetings")).toBeVisible();
    await expect(
      workspace.getByRole("button", { name: /^Start$/i }),
    ).toHaveCount(0);
    await expect(workspace.getByText(/Meeting summary/)).toBeVisible();
    await expect(
      workspace.getByText(/normal dictation transcript/),
    ).toHaveCount(0);

    await page.getByRole("button", { name: /^Transcriptions$/i }).click();
    await expect(
      page.getByRole("heading", { name: "Transcriptions" }),
    ).toBeVisible();
    await expect(page.getByText("normal dictation transcript")).toBeVisible();
    await expect(page.getByText(/Meeting summary/)).toHaveCount(0);
  });

  test("does not cap Meetings history at the transcription preview limit", async ({
    page,
  }) => {
    const state = createTestState(false, true);
    state.historyEntries = Array.from({ length: 21 }, (_, index) => {
      const id = index + 1;
      return {
        id,
        file_name: `session-${id}.wav`,
        timestamp: 1_717_200_000 + id,
        saved: false,
        title: `Session ${id}`,
        transcription_text: `raw meeting transcript ${id}`,
        post_processed_text: `Meeting summary ${id}`,
        post_process_prompt: "Live session summary via OpenAI after 1 chunk(s)",
        recording_source: "full_system_audio",
      };
    });
    await installBrowserMocks(page, state);

    await page.goto("/");

    const workspace = page.getByTestId("home-workspace");
    await workspace.getByRole("button", { name: /^History$/i }).click();

    await expect(
      workspace.getByRole("button", { name: "Meeting summary 21" }),
    ).toBeVisible();
    await expect(
      workspace.getByRole("button", { name: "Meeting summary 1", exact: true }),
    ).toBeVisible();
    await expect(workspace.getByText(/Showing latest/)).toHaveCount(0);
  });

  test("shows the supported toggle and reveals the dedicated shortcut without changing transcribe", async ({
    page,
  }) => {
    await installBrowserMocks(page, createTestState(false, true));

    await page.goto("/");
    await page.getByRole("button", { name: /Settings/i }).click();

    const toggle = page.getByTestId("record-full-system-audio-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeEnabled();
    await expect(page.getByText("Enable Meetings")).toBeVisible();
    await expect(page.getByText("Transcribe Shortcut")).toBeVisible();
    await expect(page.getByText("Meeting Recording Shortcut")).toHaveCount(0);
    await expect(page.getByText("Full-System Recording Shortcut")).toHaveCount(
      0,
    );
    await expect(page.getByText("Ctrl + fn")).toHaveCount(0);

    await page
      .locator('label:has([data-testid="record-full-system-audio-toggle"])')
      .click();

    await expect(toggle).toBeChecked();
    await expect(page.getByText("Meeting Recording Shortcut")).toBeVisible();
    await expect(page.getByText("Ctrl + fn")).toBeVisible();
    await expect(page.getByText("Transcribe Shortcut")).toBeVisible();
  });

  test("unlocks BYOK controls after five version taps", async ({ page }) => {
    const state = createTestState(false, true);
    await installBrowserMocks(page, state);

    await page.goto("/");

    await expect(page.getByRole("button", { name: /^API Keys$/i })).toHaveCount(
      0,
    );

    const versionButton = page.getByRole("button", { name: "App version" });
    await expect(versionButton).toBeVisible();

    for (let tap = 0; tap < 5; tap += 1) {
      await versionButton.click();
    }

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as {
              __UTTR_E2E__: FullSystemAudioTestState;
            }
          ).__UTTR_E2E__.invokedCommands.some(
            (command) =>
              command.cmd === "change_debug_mode_setting" &&
              command.args.enabled === true,
          ),
        ),
      )
      .toBe(true);

    await expect(
      page.getByRole("button", { name: /^API Keys$/i }),
    ).toBeVisible();
  });

  test("keeps the toggle disabled when support is unavailable and leaves transcribe visible", async ({
    page,
  }) => {
    await installBrowserMocks(page, createTestState(false, false));

    await page.goto("/");
    await page.getByRole("button", { name: /Settings/i }).click();

    const toggle = page.getByTestId("record-full-system-audio-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(page.getByText("Enable Meetings")).toBeVisible();
    await expect(
      page.getByText("This feature is available only on macOS 13 or later."),
    ).toBeVisible();
    await expect(page.getByText("Transcribe Shortcut")).toBeVisible();
    await expect(page.getByText("Ctrl + fn")).toHaveCount(0);
  });
});
