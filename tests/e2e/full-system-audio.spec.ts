import { expect, test, type Page } from "@playwright/test";

type FullSystemAudioTestState = {
  settings: {
    record_full_system_audio: boolean;
    always_on_microphone: boolean;
    selected_microphone: string;
    clamshell_microphone: string;
    selected_output_device: string;
    push_to_talk: boolean;
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
    access_state: "granted";
    entitlement_state: "active";
    byok_enabled: boolean;
    byok_validation_state: "unvalidated";
    has_byok_secret: boolean;
    has_install_token: boolean;
  };
  customSounds: { start: boolean; stop: boolean };
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
    name: "Full-System Recording Shortcut",
    description:
      "A dedicated toggle shortcut that starts and stops system audio plus microphone capture.",
    default_binding: "ctrl+alt+space",
    current_binding: "ctrl+alt+space",
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
    access_state: "granted",
    entitlement_state: "active",
    byok_enabled: false,
    byok_validation_state: "unvalidated",
    has_byok_secret: false,
    has_install_token: false,
  },
  customSounds: { start: true, stop: true },
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
    let nextCallbackId = 1;

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
      unregisterListener: () => {},
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

        switch (cmd) {
          case "plugin:app|version":
            return "0.1.2-test";
          case "plugin:macos-permissions|check_accessibility_permission":
          case "plugin:macos-permissions|check_microphone_permission":
            return true;
          case "plugin:macos-permissions|request_accessibility_permission":
          case "plugin:macos-permissions|request_microphone_permission":
            return null;
          case "plugin:event|listen":
            return Math.floor(Math.random() * 10000) + 1;
          case "plugin:event|unlisten":
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
          case "change_debug_mode_setting":
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
  test("shows the supported toggle and reveals the dedicated shortcut without changing transcribe", async ({
    page,
  }) => {
    await installBrowserMocks(page, createTestState(false, true));

    await page.goto("/");

    const toggle = page.getByTestId("record-full-system-audio-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeEnabled();
    await expect(page.getByText("Transcribe Shortcut")).toBeVisible();
    await expect(page.getByText("Full-System Recording Shortcut")).toHaveCount(
      0,
    );

    await toggle.check({ force: true });

    await expect(toggle).toBeChecked();
    await expect(
      page.getByText("Full-System Recording Shortcut"),
    ).toBeVisible();
    await expect(page.getByText("Transcribe Shortcut")).toBeVisible();
  });

  test("keeps the toggle disabled when support is unavailable and leaves transcribe visible", async ({
    page,
  }) => {
    await installBrowserMocks(page, createTestState(false, false));

    await page.goto("/");

    const toggle = page.getByTestId("record-full-system-audio-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(
      page.getByText("This feature is available only on macOS 13 or later."),
    ).toBeVisible();
    await expect(page.getByText("Transcribe Shortcut")).toBeVisible();
    await expect(page.getByText("Full-System Recording Shortcut")).toHaveCount(
      0,
    );
  });
});
