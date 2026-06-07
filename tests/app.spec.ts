import { test, expect, type Page } from "@playwright/test";

type HiddenUnlockTestState = {
  settings: Record<string, unknown>;
  defaultSettings: Record<string, unknown>;
  installAccess: Record<string, unknown>;
  debugModeUpdates: boolean[];
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

const createHiddenUnlockTestState = (): HiddenUnlockTestState => {
  const settings = {
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
    update_checks_enabled: false,
    bindings,
  };

  return {
    settings,
    defaultSettings: { ...settings },
    installAccess: {
      install_id: "hidden-unlock-test-install",
      device_fingerprint_hash: "hidden-unlock-test-fingerprint",
      trial_state: "expired",
      access_state: "free",
      entitlement_state: "inactive",
      byok_enabled: false,
      byok_validation_state: "unvalidated",
      has_byok_secret: false,
      has_install_token: false,
      dev_access_override: null,
    },
    debugModeUpdates: [],
  };
};

async function installHiddenUnlockMocks(
  page: Page,
  state: HiddenUnlockTestState,
) {
  await page.addInitScript((testState) => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    const eventListeners = new Map<
      number,
      { event: string; handler: number }
    >();
    let nextCallbackId = 1;
    let nextEventId = 1;

    (
      window as unknown as { __UTTR_E2E__: HiddenUnlockTestState }
    ).__UTTR_E2E__ = testState;
    (window as unknown as { isTauri: boolean }).isTauri = true;
    (
      window as unknown as {
        __TAURI_OS_PLUGIN_INTERNALS__: Record<string, string>;
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
          unregisterListener: (_event: string, eventId: number) => void;
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
          window as unknown as { __UTTR_E2E__: HiddenUnlockTestState }
        ).__UTTR_E2E__;

        switch (cmd) {
          case "plugin:app|version":
            return "0.1.12-test";
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
          case "get_app_settings":
            return e2eState.settings;
          case "get_default_settings":
            return e2eState.defaultSettings;
          case "get_install_access_snapshot":
            return e2eState.installAccess;
          case "get_current_model":
          case "get_transcription_model_status":
            return "parakeet-tdt-0.6b-v3";
          case "has_any_models_available":
          case "initialize_enigo":
          case "initialize_shortcuts":
          case "is_recording":
            return false;
          case "get_available_models":
          case "get_available_microphones":
          case "get_available_output_devices":
          case "get_history_entries":
            return [];
          case "check_custom_sounds":
            return { start: true, stop: true };
          case "get_full_system_audio_support_status":
            return { supported: true, reason: "Supported in test." };
          case "get_full_system_audio_readiness_status":
            return {
              supported: true,
              ready: true,
              reason: "Ready in test.",
            };
          case "get_post_process_api_key_statuses":
            return { openai: false, groq: false };
          case "change_debug_mode_setting":
            e2eState.settings = {
              ...e2eState.settings,
              debug_mode: Boolean(args.enabled),
            };
            e2eState.debugModeUpdates.push(Boolean(args.enabled));
            return null;
          case "change_binding":
          case "reset_binding":
          case "suspend_binding":
          case "resume_binding":
            return { success: true, error: null };
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

test.describe("Handy App", () => {
  test("dev server responds", async ({ page }) => {
    // Just verify the dev server is running and responds
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
  });

  test("page has html structure", async ({ page }) => {
    await page.goto("/");

    // Verify basic HTML structure exists
    const html = await page.content();
    expect(html).toContain("<html");
    expect(html).toContain("<body");
  });

  test("unlocks BYOK surfaces after five fast version clicks", async ({
    page,
  }) => {
    await installHiddenUnlockMocks(page, createHiddenUnlockTestState());
    await page.goto("/");

    await expect(page.getByRole("button", { name: /^API Keys$/i })).toHaveCount(
      0,
    );

    const versionButton = page.getByRole("button", { name: "App version" });
    await expect(versionButton).toBeVisible();

    for (let clickIndex = 0; clickIndex < 5; clickIndex += 1) {
      await versionButton.click();
    }

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __UTTR_E2E__: HiddenUnlockTestState })
              .__UTTR_E2E__.debugModeUpdates,
        ),
      )
      .toEqual([true]);
    await expect(
      page.getByRole("button", { name: /^API Keys$/i }),
    ).toBeVisible();
  });
});
