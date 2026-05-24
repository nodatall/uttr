#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import net from "node:net";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const artifactRoot = path.join(
  repoRoot,
  "agents-scratch",
  "release-transcribe-smoke",
);
const appIdentifier = "com.pais.uttr";
const defaultPhrase = "release smoke test";
const defaultTokens = ["release", "smoke", "test"];
const defaultShortcut = "command+shift+9";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const phrase = String(
  args.phrase ?? process.env.UTTR_RELEASE_SMOKE_PHRASE ?? defaultPhrase,
);
const expectedTokens = String(
  args.tokens ??
    process.env.UTTR_RELEASE_SMOKE_EXPECTED_TOKENS ??
    defaultTokens.join(","),
)
  .split(",")
  .map((token) => normalizeForMatch(token))
  .filter(Boolean);
const recordSeconds = Number(
  args["record-seconds"] ?? process.env.UTTR_RELEASE_SMOKE_RECORD_SECONDS ?? 5,
);
const startupTimeoutMs = Number(args["startup-timeout-ms"] ?? 180_000);
const transcriptionTimeoutMs = Number(
  args["transcription-timeout-ms"] ?? 120_000,
);
const keepArtifacts = Boolean(args["keep-artifacts"]);
const screenshotsEnabled = !Boolean(args["no-screenshots"]);
const preflightOnly = Boolean(args["preflight-only"]);
const smokeDocumentMarker = `uttr-release-smoke-${Date.now()}`;

let tauriProcess = null;
let tauriStdioFds = [];
let scratchDir = "";
let cleaningUpTauri = false;
let preserveArtifacts = false;
let smokeDocumentCreated = false;
let smokeDocumentName = null;
let smokeDocumentPath = null;
let lastScreenshotPath = null;

main().catch(async (error) => {
  await cleanup(false);
  console.error(`release-transcribe-smoke failed: ${error.message}`);
  if (scratchDir) {
    console.error(`Evidence kept at: ${scratchDir}`);
  }
  process.exit(1);
});

async function main() {
  if (process.platform !== "darwin") {
    throw new Error(
      "The release transcription smoke test currently requires macOS.",
    );
  }

  if (!Number.isFinite(recordSeconds) || recordSeconds < 2) {
    throw new Error("--record-seconds must be at least 2.");
  }

  const provider = resolveProvider();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  scratchDir = path.join(artifactRoot, runId);
  const homeDir = path.join(scratchDir, "home");
  const appDataDir = path.join(
    homeDir,
    "Library",
    "Application Support",
    appIdentifier,
  );
  const logDir = path.join(homeDir, "Library", "Logs", appIdentifier);
  const stdoutPath = path.join(scratchDir, "tauri-dev.stdout.log");
  const stderrPath = path.join(scratchDir, "tauri-dev.stderr.log");
  const logPath = path.join(logDir, "uttr.log");
  const smokeAudioPath = path.join(scratchDir, "release-smoke-phrase.wav");

  await mkdir(appDataDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await seedSettings(appDataDir, provider);
  await prepareModelDirectory(appDataDir, provider);
  await prepareSmokeAudio(smokeAudioPath, phrase);

  console.log(`Smoke provider: ${provider.label}`);
  console.log(`Expected phrase: "${phrase}"`);
  console.log(`Expected tokens: ${expectedTokens.join(", ")}`);
  console.log(`Isolated app data: ${appDataDir}`);

  if (preflightOnly) {
    console.log(
      "Preflight passed. Skipping native app launch because --preflight-only was set.",
    );
    await cleanup(true);
    return;
  }

  await ensureLocalAutomationCanSendKeys();
  await ensureNoRunningUttrInstance();

  tauriProcess = await startTauriDev({
    homeDir,
    stdoutPath,
    stderrPath,
    provider,
    smokeAudioPath,
  });

  await waitForLog(
    logPath,
    "Shortcuts initialized successfully",
    startupTimeoutMs,
    "shortcut initialization",
  );
  await waitForLog(
    logPath,
    "Enigo initialized successfully",
    startupTimeoutMs,
    "input initialization",
  );
  await waitForLog(
    logPath,
    "Registered handy-keys shortcut: transcribe",
    startupTimeoutMs,
    "transcribe shortcut registration",
  );

  await openTextEditTarget();

  console.log("");
  console.log(`Starting recording with generated smoke audio: "${phrase}"`);

  await focusTextEditTarget();
  const recordingStartedAt = Date.now();
  await triggerSmokeShortcut();
  await waitForLog(
    logPath,
    "overlay shown state=recording",
    15_000,
    "recording overlay",
  );
  await focusTextEditTarget();
  await captureScreenshot("01-recording", { expectedFrontmost: "TextEdit" });

  await sleep(500);

  const elapsedMs = Date.now() - recordingStartedAt;
  const remainingMs = Math.max(0, recordSeconds * 1_000 - elapsedMs);
  if (remainingMs > 0) {
    console.log(
      `Waiting ${Math.ceil(remainingMs / 1_000)}s before stopping recording...`,
    );
    await sleep(remainingMs);
  }

  await focusTextEditTarget();
  await triggerSmokeShortcut();
  await waitForLog(
    logPath,
    "overlay shown state=transcribing",
    15_000,
    "transcribing overlay",
  );
  await captureScreenshot("02-transcribing", { expectedFrontmost: "TextEdit" });
  await focusTextEditTarget();
  await waitForLog(
    logPath,
    "Transcription completed",
    transcriptionTimeoutMs,
    "transcription completion",
  );
  await waitForLog(
    logPath,
    "Text pasted successfully",
    20_000,
    "paste completion",
  );

  const pastedText = await waitForPastedText(
    expectedTokens,
    transcriptionTimeoutMs,
  );
  await writeFile(path.join(scratchDir, "pasted-text.txt"), pastedText, "utf8");
  await focusTextEditTarget();
  await captureScreenshot("03-pasted-result", {
    expectedFrontmost: "TextEdit",
  });

  const historyEntry = await waitForHistoryEntry(appDataDir, expectedTokens);
  await waitForLog(
    logPath,
    `Release smoke history entry saved id=${historyEntry.id}`,
    20_000,
    "release smoke history entry",
  );
  await openGeneralSettingsInUttr();
  await captureScreenshot("04-settings", { expectedFrontmost: "uttr" });
  await openHistoryInUttr();
  await waitForLog(
    logPath,
    `history settings visible id=${historyEntry.id}`,
    10_000,
    "History settings visible entry",
  );
  await captureScreenshot("05-history", { expectedFrontmost: "uttr" });
  await closeTextEditDocumentsContaining(pastedText);
  await closeEmptyTextEditDocuments();
  await quitTextEditIfNoDocuments();

  console.log(`Pasted text: ${pastedText.trim()}`);
  if (screenshotsEnabled) {
    console.log(`Screenshot evidence: ${path.join(scratchDir, "screenshots")}`);
  }
  console.log("Release transcription smoke test passed.");

  await cleanup(true);
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (
      key === "keep-artifacts" ||
      key === "preflight-only" ||
      key === "no-screenshots"
    ) {
      parsed[key] = true;
      continue;
    }
    const value = rawArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/release-transcribe-smoke.mjs [options]

Runs the local native Uttr transcription smoke test against an isolated app
profile. The test opens TextEdit, triggers the release smoke transcription
toggle, records generated smoke audio through the app's microphone path, waits
for transcription, and verifies pasted text.

Options:
  --phrase <text>                 Phrase to render into generated smoke audio.
  --tokens <a,b,c>                Comma-separated tokens expected in pasted text.
  --record-seconds <seconds>      Recording duration. Default: 5.
  --preflight-only                Verify provider/settings setup without launching Uttr.
  --no-screenshots                Skip desktop screenshot evidence capture.
  --keep-artifacts                Keep scratch evidence after a successful run.

Provider setup:
  By default, the smoke test copies your current Uttr app profile, including
  stored provider settings and encrypted BYOK files, into an isolated test
  profile. The real profile is not modified.

Explicit provider overrides:
  UTTR_OPENAI_API_KEY or OPENAI_API_KEY
  UTTR_GROQ_API_KEY or GROQ_API_KEY
  UTTR_RELEASE_SMOKE_MODEL_DIR=/path/to/parakeet-tdt-0.6b-v3-int8
`);
}

function resolveProvider() {
  if (process.env.UTTR_RELEASE_SMOKE_MODEL_DIR) {
    return {
      type: "local",
      label: "local Parakeet model",
      selectedModel: "parakeet-tdt-0.6b-v3",
      sourceModelDir: path.resolve(process.env.UTTR_RELEASE_SMOKE_MODEL_DIR),
    };
  }

  if (hasEnv("UTTR_OPENAI_API_KEY") || hasEnv("OPENAI_API_KEY")) {
    return {
      type: "openai",
      label: "OpenAI direct transcription",
      selectedModel: "openai-gpt-4o-transcribe",
    };
  }

  if (hasEnv("UTTR_GROQ_API_KEY") || hasEnv("GROQ_API_KEY")) {
    return {
      type: "groq",
      label: "Groq direct transcription",
      selectedModel: "groq-whisper-large-v3",
    };
  }

  const currentProfileDir = currentAppDataDir();
  return {
    type: "app_profile",
    label: "current Uttr app profile",
    selectedModel: null,
    sourceProfileDir: currentProfileDir,
  };
}

function currentAppDataDir() {
  if (!process.env.HOME) {
    throw new Error(
      "HOME is not set, so the current Uttr app profile cannot be located.",
    );
  }

  return path.join(
    process.env.HOME,
    "Library",
    "Application Support",
    appIdentifier,
  );
}

async function copyCurrentAppProfile(appDataDir, provider) {
  if (provider.type !== "app_profile") {
    return;
  }

  const sourceSettings = path.join(
    provider.sourceProfileDir,
    "settings_store.json",
  );
  const settingsStat = await stat(sourceSettings).catch(() => null);
  if (!settingsStat?.isFile()) {
    throw new Error(
      `No current Uttr settings profile was found at ${sourceSettings}. Open Uttr once or set a provider override.`,
    );
  }

  for (const fileName of [
    "settings_store.json",
    "byok_secrets.json",
    "byok_secrets.key",
    "byok.vault",
  ]) {
    const sourcePath = path.join(provider.sourceProfileDir, fileName);
    const sourceStat = await stat(sourcePath).catch(() => null);
    if (sourceStat?.isFile()) {
      await copyFile(sourcePath, path.join(appDataDir, fileName));
    }
  }
}

function selectedModelForProvider(provider, existingSettings) {
  if (provider.selectedModel) {
    return provider.selectedModel;
  }

  const selectedModel = existingSettings?.selected_model;
  if (typeof selectedModel === "string" && selectedModel.trim()) {
    return selectedModel;
  }

  throw new Error(
    "No selected transcription model was found in the current Uttr app profile. Select a transcription model in Uttr or set a provider override.",
  );
}

function hasEnv(name) {
  return Boolean(process.env[name]?.trim());
}

async function seedSettings(appDataDir, provider) {
  await copyCurrentAppProfile(appDataDir, provider);
  const settingsPath = path.join(appDataDir, "settings_store.json");
  const existingStore = await readSettingsStore(settingsPath);
  const existingSettings = existingStore.settings ?? {};
  const bindings = {
    transcribe: {
      id: "transcribe",
      name: "Transcribe",
      description: "Converts your speech into text.",
      default_binding: "option+space",
      current_binding: defaultShortcut,
    },
    transcribe_with_post_process: {
      id: "transcribe_with_post_process",
      name: "Post-Processing Shortcut",
      description: "Toggles AI post-processing on or off.",
      default_binding: "shift+fn",
      current_binding: "command+shift+8",
    },
    transcribe_full_system_audio: {
      id: "transcribe_full_system_audio",
      name: "Transcribe Full System Audio",
      description: "Converts your full-system and microphone audio into text.",
      default_binding: "ctrl+fn",
      current_binding: "command+shift+7",
    },
    copy_last_transcript: {
      id: "copy_last_transcript",
      name: "Copy Last Transcript",
      description:
        "Copies the newest transcript from history to your clipboard.",
      default_binding: "command+fn",
      current_binding: "command+shift+6",
    },
    cancel: {
      id: "cancel",
      name: "Cancel",
      description: "Cancels the current recording.",
      default_binding: "escape",
      current_binding: "escape",
    },
  };

  const store = {
    ...existingStore,
    settings: {
      ...existingSettings,
      bindings,
      push_to_talk: false,
      audio_feedback: false,
      onboarding_completed: true,
      selected_model: selectedModelForProvider(provider, existingSettings),
      always_on_microphone: false,
      selected_microphone: null,
      clamshell_microphone: null,
      selected_output_device: null,
      translate_to_english: false,
      selected_language: "en",
      overlay_position: "bottom",
      debug_mode: true,
      log_level: "debug",
      post_process_enabled: false,
      mute_while_recording: false,
      append_trailing_space: false,
      incremental_transcription_enabled: false,
      keyboard_implementation: "handy_keys",
      show_tray_icon: true,
      paste_method: "direct",
      clipboard_handling: "dont_modify",
      auto_submit: false,
      auto_submit_key: "enter",
      start_hidden: false,
      autostart_enabled: false,
      update_checks_enabled: false,
      app_language: "en",
    },
  };

  await writeFile(
    path.join(appDataDir, "settings_store.json"),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf8",
  );
}

async function readSettingsStore(settingsPath) {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(
        `Failed to read smoke settings profile: ${error.message}`,
      );
    }
    return {};
  }
}

async function prepareModelDirectory(appDataDir, provider) {
  if (provider.type !== "local") {
    return;
  }

  const sourceStat = await stat(provider.sourceModelDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(
      `UTTR_RELEASE_SMOKE_MODEL_DIR must point to an existing Parakeet v3 model directory: ${provider.sourceModelDir}`,
    );
  }

  const targetDir = path.join(
    appDataDir,
    "models",
    "parakeet-tdt-0.6b-v3-int8",
  );
  await mkdir(path.dirname(targetDir), { recursive: true });
  await symlink(provider.sourceModelDir, targetDir, "dir");
}

async function ensureLocalAutomationCanSendKeys() {
  try {
    await osascript([
      'tell application "System Events" to get name of first process',
    ]);
  } catch (error) {
    throw new Error(
      `Local keyboard automation is unavailable. Grant Accessibility permission to your terminal or script runner, then rerun. ${error.message}`,
    );
  }
}

async function ensureNoRunningUttrInstance() {
  const script = [
    'tell application "System Events"',
    `set matchingProcesses to every process whose bundle identifier is "${appIdentifier}"`,
    "return count of matchingProcesses",
    "end tell",
  ];
  const count = Number((await osascript(script)).trim());
  if (count > 0) {
    throw new Error(
      "Uttr is already running. Quit Uttr before running the release smoke test so the isolated test instance can start.",
    );
  }

  const processList = await execFileText("ps", ["-axo", "pid=,args="]);
  const running = processList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (line.includes("scripts/release-transcribe-smoke.mjs")) {
        return false;
      }
      return (
        line.includes("/target/debug/uttr") ||
        line.includes("/Contents/MacOS/uttr") ||
        line.includes("/Contents/MacOS/Uttr") ||
        line.includes("node_modules/.bin/tauri dev")
      );
    });

  if (running.length > 0) {
    throw new Error(
      `Uttr or Tauri dev is already running. Quit it before running the isolated release smoke test:\n${running.join("\n")}`,
    );
  }
}

async function startTauriDev({
  homeDir,
  stdoutPath,
  stderrPath,
  provider,
  smokeAudioPath,
}) {
  const stdoutHandle = await openAppend(stdoutPath);
  const stderrHandle = await openAppend(stderrPath);
  const vitePort =
    process.env.UTTR_RELEASE_SMOKE_VITE_PORT ??
    String(await findAvailableTcpPort(1420));
  const viteHmrPort =
    process.env.UTTR_RELEASE_SMOKE_VITE_HMR_PORT ??
    String(
      await findAvailableTcpPort(Number(vitePort) + 1, [Number(vitePort)]),
    );
  console.log(`Using isolated Vite dev port: ${vitePort}`);

  const env = {
    ...process.env,
    HOME: homeDir,
    CARGO_HOME:
      process.env.CARGO_HOME ??
      path.join(process.env.HOME ?? homeDir, ".cargo"),
    RUSTUP_HOME:
      process.env.RUSTUP_HOME ??
      path.join(process.env.HOME ?? homeDir, ".rustup"),
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    UTTR_RELEASE_SMOKE: "1",
    UTTR_RELEASE_SMOKE_AUDIO_FILE: smokeAudioPath,
    UTTR_RELEASE_SMOKE_TRANSCRIBING_HOLD_MS:
      process.env.UTTR_RELEASE_SMOKE_TRANSCRIBING_HOLD_MS ?? "3000",
    VITE_PORT: vitePort,
    VITE_HMR_PORT: viteHmrPort,
    RUST_LOG: process.env.RUST_LOG ?? "info",
  };

  if (provider.type === "local") {
    delete env.UTTR_OPENAI_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.UTTR_GROQ_API_KEY;
    delete env.GROQ_API_KEY;
  }

  const child = spawn("bun", ["run", "tauri:dev"], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ["ignore", stdoutHandle, stderrHandle],
  });

  child.on("exit", (code, signal) => {
    if (tauriProcess === child && !cleaningUpTauri) {
      console.error(
        `tauri dev exited unexpectedly: code=${code} signal=${signal}`,
      );
    }
  });

  await sleep(500);
  if (child.exitCode !== null) {
    throw new Error(`tauri dev exited during startup. See ${stderrPath}`);
  }
  return child;
}

async function openAppend(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  tauriStdioFds.push(fd);
  return fd;
}

async function openTextEditTarget() {
  smokeDocumentName = `release-smoke-textedit-target-${process.pid}.txt`;
  smokeDocumentPath = path.join(scratchDir, smokeDocumentName);
  await writeFile(smokeDocumentPath, smokeDocumentMarker, "utf8");
  await execFileText("open", ["-a", "TextEdit", smokeDocumentPath]);
  smokeDocumentCreated = true;
  await osascript([
    'tell application "TextEdit"',
    "activate",
    `set targetName to ${appleScriptString(smokeDocumentName)}`,
    `set targetMarker to ${appleScriptString(smokeDocumentMarker)}`,
    "set targetDocument to missing value",
    "repeat 50 times",
    "repeat with docRef in documents",
    "try",
    "if (name of docRef is targetName) and (text of docRef contains targetMarker) then",
    "set targetDocument to docRef",
    "exit repeat",
    "end if",
    "end try",
    "end repeat",
    "if targetDocument is not missing value then exit repeat",
    "delay 0.1",
    "end repeat",
    'if targetDocument is missing value then error "TextEdit smoke target document did not open"',
    'set text of targetDocument to ""',
    "end tell",
    "delay 0.5",
  ]);
  await waitForFrontmostApplication("TextEdit", 5_000);
}

async function focusTextEditTarget() {
  if (smokeDocumentPath) {
    await execFileText("open", ["-a", "TextEdit", smokeDocumentPath]);
  } else {
    await execFileText("open", ["-a", "TextEdit"]);
  }
  await osascript([
    'tell application "TextEdit"',
    "activate",
    `set targetName to ${appleScriptString(smokeDocumentName || "")}`,
    'if targetName is not "" then',
    "repeat 50 times",
    "if exists window targetName then exit repeat",
    "delay 0.1",
    "end repeat",
    'if not (exists window targetName) then error "TextEdit target window not found"',
    "set index of window targetName to 1",
    "set bounds of window targetName to {120, 120, 920, 620}",
    "end if",
    "end tell",
    'tell application "System Events"',
    'set textEditProcess to process "TextEdit"',
    "set frontmost of textEditProcess to true",
    `set targetName to ${appleScriptString(smokeDocumentName || "")}`,
    "set targetWindow to missing value",
    "repeat 50 times",
    "repeat with windowRef in windows of textEditProcess",
    'if targetName is not "" and (name of windowRef is targetName) then',
    "set targetWindow to windowRef",
    "exit repeat",
    "end if",
    "end repeat",
    "if targetWindow is not missing value then exit repeat",
    "delay 0.1",
    "end repeat",
    "if targetWindow is missing value then",
    'if targetName is not "" then error "TextEdit target window not found"',
    "if exists window 1 of textEditProcess then",
    "set targetWindow to window 1 of textEditProcess",
    "else",
    'error "TextEdit target window not found"',
    "end if",
    "end if",
    'perform action "AXRaise" of targetWindow',
    "set windowPosition to position of targetWindow",
    "set windowSize to size of targetWindow",
    "set clickX to (item 1 of windowPosition) + ((item 1 of windowSize) / 2)",
    "set clickY to (item 2 of windowPosition) + 120",
    "click at {clickX, clickY}",
    "end tell",
    "delay 0.5",
  ]);
  await waitForFrontmostApplication("TextEdit", 15_000);
}

async function openSettingsInUttr() {
  const pid = await findUttrProcessId();
  await osascript([
    'tell application "System Events"',
    `set targetProcesses to every process whose unix id is ${pid}`,
    'if (count of targetProcesses) is 0 then error "Uttr process not found"',
    "set targetProcess to item 1 of targetProcesses",
    "set frontmost of targetProcess to true",
    "repeat 20 times",
    "if exists window 1 of targetProcess then exit repeat",
    "delay 0.25",
    "end repeat",
    "end tell",
    "delay 0.75",
  ]);
  await waitForFrontmostApplication("uttr", 5_000);
}

async function openGeneralSettingsInUttr() {
  await openSettingsInUttr();
  const clicked = await clickUttrSidebarButton("General", 1);
  if (!clicked.includes("clicked")) {
    throw new Error(
      "Could not find the General settings navigation button in Uttr.",
    );
  }
}

async function openHistoryInUttr() {
  await openSettingsInUttr();
  const clicked = await clickUttrSidebarButton("History", 4);
  if (!clicked.includes("clicked")) {
    throw new Error("Could not find the History navigation button in Uttr.");
  }
}

async function clickUttrSidebarButton(buttonName, visibleIndex) {
  const accessibleClick = await clickUttrButtonByName(buttonName).catch(
    () => "missing",
  );
  if (accessibleClick.includes("clicked")) {
    return accessibleClick;
  }
  return clickUttrSidebarButtonByIndex(visibleIndex);
}

async function clickUttrButtonByName(buttonName) {
  return osascript([
    "on clickButtonNamed(container, targetName)",
    'tell application "System Events"',
    "try",
    "repeat with child in UI elements of container",
    "try",
    "set childRole to role of child as text",
    "set childName to name of child as text",
    'if (childRole is "AXButton" or childRole is "button") and childName is targetName then',
    "click child",
    'return "clicked"',
    "end if",
    "end try",
    "try",
    "set nestedResult to my clickButtonNamed(child, targetName)",
    'if nestedResult is "clicked" then return "clicked"',
    "end try",
    "end repeat",
    "end try",
    "end tell",
    'return "missing"',
    "end clickButtonNamed",
    'tell application "System Events"',
    `set targetProcesses to every process whose unix id is ${await findUttrProcessId()}`,
    'if (count of targetProcesses) is 0 then error "Uttr process not found"',
    "set targetProcess to item 1 of targetProcesses",
    "set clickResult to my clickButtonNamed(window 1 of targetProcess, " +
      appleScriptString(buttonName) +
      ")",
    "end tell",
    "delay 0.75",
    "return clickResult",
  ]);
}

async function clickUttrSidebarButtonByIndex(visibleIndex) {
  return osascript([
    'tell application "System Events"',
    `set targetProcesses to every process whose unix id is ${await findUttrProcessId()}`,
    'if (count of targetProcesses) is 0 then error "Uttr process not found"',
    "set targetProcess to item 1 of targetProcesses",
    "set windowPosition to position of window 1 of targetProcess",
    "set windowX to item 1 of windowPosition",
    "set windowY to item 2 of windowPosition",
    "set clickX to windowX + 116",
    `set clickY to windowY + 103 + (${visibleIndex - 1} * 43)`,
    "click at {clickX, clickY}",
    "end tell",
    "delay 0.75",
    'return "clicked-coordinate"',
  ]);
}

async function triggerSmokeShortcut() {
  const helperPath = path.join(scratchDir, "send-smoke-shortcut.swift");
  await writeFile(
    helperPath,
    `
import CoreGraphics
import Foundation

let source = CGEventSource(stateID: .hidSystemState)
let commandKey: CGKeyCode = 55
let shiftKey: CGKeyCode = 56
let num9Key: CGKeyCode = 25
let chordFlags: CGEventFlags = [.maskCommand, .maskShift]

func post(_ event: CGEvent) {
    event.post(tap: .cghidEventTap)
    usleep(50_000)
}

func flagsChanged(_ keyCode: CGKeyCode, _ flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) else {
        fatalError("Could not create flagsChanged event")
    }
    event.type = .flagsChanged
    event.flags = flags
    post(event)
}

func key(_ keyCode: CGKeyCode, down: Bool, _ flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else {
        fatalError("Could not create key event")
    }
    event.flags = flags
    post(event)
}

flagsChanged(commandKey, [.maskCommand])
flagsChanged(shiftKey, chordFlags)
key(num9Key, down: true, chordFlags)
key(num9Key, down: false, chordFlags)
flagsChanged(shiftKey, [.maskCommand])
flagsChanged(commandKey, [])
`,
    "utf8",
  );
  await execFileText("swift", [helperPath]);
  await sleep(250);
}

async function findUttrProcessId() {
  const processList = await execFileText("ps", ["-axo", "pid=,args="]);
  const targetSuffixes = [
    path.join("src-tauri", "target", "debug", "uttr"),
    path.join("target", "debug", "uttr"),
  ];
  const match = processList
    .split("\n")
    .map((line) => line.trim())
    .find((line) =>
      targetSuffixes.some(
        (targetSuffix) =>
          line.includes(targetSuffix) && !line.includes("ps -axo"),
      ),
    );

  if (!match) {
    throw new Error("Could not find the running Uttr smoke app process.");
  }

  const pid = Number(match.split(/\s+/, 1)[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not parse Uttr smoke app process id from: ${match}`);
  }

  return pid;
}

async function prepareSmokeAudio(outputPath, text) {
  const aiffPath = path.join(
    path.dirname(outputPath),
    "release-smoke-phrase.aiff",
  );
  await execFileText("say", ["-o", aiffPath, text]);
  await execFileText("afconvert", [
    aiffPath,
    "-f",
    "WAVE",
    "-d",
    "LEI16@16000",
    outputPath,
  ]);
}

async function captureScreenshot(label, options = {}) {
  if (!screenshotsEnabled) {
    return;
  }

  if (options.expectedFrontmost) {
    await waitForFrontmostApplication(options.expectedFrontmost, 5_000);
  }

  const screenshotsDir = path.join(scratchDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const screenshotPath = path.join(screenshotsDir, `${label}.png`);
  await execFileText("screencapture", ["-x", screenshotPath]);
  const screenshotStat = await stat(screenshotPath).catch(() => null);
  if (!screenshotStat?.isFile() || screenshotStat.size === 0) {
    throw new Error(`Screenshot capture failed for ${label}.`);
  }
  if (lastScreenshotPath) {
    const identical = await filesAreIdentical(
      lastScreenshotPath,
      screenshotPath,
    );
    if (identical) {
      throw new Error(
        `Screenshot ${label} is identical to the previous state; visual evidence did not change.`,
      );
    }
  }
  lastScreenshotPath = screenshotPath;
  preserveArtifacts = true;
  console.log(`Captured screenshot: ${screenshotPath}`);
}

async function filesAreIdentical(leftPath, rightPath) {
  const result = await execFileText("cmp", ["-s", leftPath, rightPath]).then(
    () => true,
    (error) => {
      const message = error.message || "";
      if (message.includes("differ")) {
        return false;
      }
      return false;
    },
  );
  return result;
}

async function waitForHistoryEntry(appDataDir, tokens, timeoutMs = 20_000) {
  const dbPath = path.join(appDataDir, "history.db");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const output = await execFileText("sqlite3", [
      "-json",
      dbPath,
      "SELECT id, transcription_text, COALESCE(post_processed_text, '') AS post_processed_text FROM transcription_history ORDER BY timestamp DESC LIMIT 1;",
    ]).catch(() => "");
    if (output.trim()) {
      const [entry] = JSON.parse(output);
      const text = `${entry.transcription_text ?? ""} ${entry.post_processed_text ?? ""}`;
      if (containsExpectedTokens(text, tokens)) {
        return entry;
      }
    }
    await sleep(500);
  }

  throw new Error("Timed out waiting for matching transcript in history.");
}

async function waitForPastedText(tokens, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await getTextEditText();
    if (containsExpectedTokens(text, tokens)) {
      return text;
    }
    await sleep(1_000);
  }

  const text = await getTextEditText();
  throw new Error(
    `Timed out waiting for pasted transcript. Last TextEdit content: "${text.trim()}"`,
  );
}

async function getTextEditText() {
  try {
    return await osascript([
      'tell application "TextEdit"',
      `set targetName to ${appleScriptString(smokeDocumentName || "")}`,
      'if targetName is not "" then',
      "repeat with docRef in documents",
      "if name of docRef is targetName then return text of docRef",
      "end repeat",
      'return ""',
      "end if",
      'if not (exists front document) then return ""',
      "return text of front document",
      "end tell",
    ]);
  } catch {
    return "";
  }
}

async function waitForFrontmostApplication(expectedName, timeoutMs) {
  const started = Date.now();
  const expected = expectedName.toLowerCase();
  while (Date.now() - started < timeoutMs) {
    const frontmost = (
      await osascript([
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]).catch(() => "")
    )
      .trim()
      .toLowerCase();
    if (frontmost === expected) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${expectedName} to be frontmost.`);
}

async function closeTextEditDocumentsContaining(text) {
  const needle = String(text).trim();
  if (!needle) {
    return;
  }

  const result = await osascript([
    'tell application "TextEdit"',
    "set closedCount to 0",
    "repeat with docRef in documents",
    "try",
    `if text of docRef contains ${appleScriptString(needle)} then`,
    "close docRef saving no",
    "set closedCount to closedCount + 1",
    "end if",
    "end try",
    "end repeat",
    "return closedCount",
    "end tell",
  ]);
  const closedCount = Number(result.trim());
  console.log(`Closed ${closedCount} matching TextEdit smoke document(s).`);
  return Number.isFinite(closedCount) ? closedCount : 0;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function containsExpectedTokens(text, tokens) {
  const normalized = normalizeForMatch(text);
  return tokens.every((token) => normalized.includes(token));
}

function normalizeForMatch(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForLog(logPath, needle, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = await readTextIfExists(logPath);
    if (log.includes(needle)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${label}: missing log line "${needle}" in ${logPath}`,
  );
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function osascript(lines) {
  const args = lines.flatMap((line) => ["-e", line]);
  return execFileText("osascript", args);
}

async function execFileText(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function findAvailableTcpPort(preferredPort, reservedPorts = []) {
  const reserved = new Set(reservedPorts);
  for (let port = preferredPort; port < preferredPort + 100; port += 1) {
    if (reserved.has(port)) {
      continue;
    }
    if (await canListenOnLocalhost(port)) {
      return port;
    }
  }
  throw new Error(
    `Could not find an available local TCP port starting at ${preferredPort}.`,
  );
}

async function canListenOnLocalhost(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: "localhost" });
  });
}

async function cleanup(success) {
  if (!success) {
    await closeSmokeTextEditDocument().catch(() => {});
  }
  if (success) {
    await closeSmokeTextEditDocument().catch(() => {});
  }
  if (!success && smokeDocumentCreated) {
    await closeEmptyFrontTextEditDocument().catch(() => {});
    await closeTextEditDocumentsContaining(phrase).catch(() => {});
    await closeTextEditDocumentsContaining(smokeDocumentMarker).catch(() => {});
  }
  await closeEmptyTextEditDocuments().catch(() => {});
  await quitTextEditIfNoDocuments().catch(() => {});

  if (tauriProcess) {
    cleaningUpTauri = true;
    try {
      process.kill(-tauriProcess.pid, "SIGTERM");
    } catch {}
    await sleep(1_000);
    try {
      process.kill(-tauriProcess.pid, "SIGKILL");
    } catch {}
    tauriProcess = null;
    cleaningUpTauri = false;
  }

  for (const fd of tauriStdioFds) {
    try {
      closeSync(fd);
    } catch {}
  }
  tauriStdioFds = [];

  if (scratchDir) {
    await scrubSensitiveProfileArtifacts();
  }

  if (success && scratchDir && !keepArtifacts && !preserveArtifacts) {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function scrubSensitiveProfileArtifacts() {
  const appDataDir = path.join(
    scratchDir,
    "home",
    "Library",
    "Application Support",
    appIdentifier,
  );
  for (const fileName of [
    "byok_secrets.json",
    "byok_secrets.key",
    "byok.vault",
    "settings_store.json",
  ]) {
    await rm(path.join(appDataDir, fileName), { force: true }).catch(() => {});
  }
}

async function closeEmptyFrontTextEditDocument() {
  await osascript([
    'tell application "TextEdit"',
    "if exists front document then",
    'if text of front document is "" then close front document saving no',
    "end if",
    "end tell",
  ]);
}

async function closeSmokeTextEditDocument() {
  if (!smokeDocumentPath && !smokeDocumentName) {
    return;
  }

  const result = await osascript([
    'tell application "TextEdit"',
    "set closedCount to 0",
    `set targetPath to ${appleScriptString(smokeDocumentPath || "")}`,
    `set targetName to ${appleScriptString(smokeDocumentName || "")}`,
    "repeat with docRef in documents",
    "set shouldClose to false",
    "try",
    "set docPath to POSIX path of (file of docRef as alias)",
    "if docPath is targetPath then set shouldClose to true",
    "end try",
    'if (shouldClose is false) and (targetName is not "") and (name of docRef is targetName) then set shouldClose to true',
    "if shouldClose then",
    "close docRef saving no",
    "set closedCount to closedCount + 1",
    "end if",
    "end repeat",
    "return closedCount",
    "end tell",
  ]);
  const closedCount = Number(result.trim());
  console.log(
    `Closed ${Number.isFinite(closedCount) ? closedCount : 0} TextEdit smoke target document(s).`,
  );
}

async function closeEmptyTextEditDocuments() {
  if (!smokeDocumentCreated) {
    return;
  }

  const result = await osascript([
    'tell application "TextEdit"',
    "set closedCount to 0",
    "repeat with docRef in documents",
    "try",
    'if text of docRef is "" then',
    "close docRef saving no",
    "set closedCount to closedCount + 1",
    "end if",
    "end try",
    "end repeat",
    "return closedCount",
    "end tell",
  ]);
  const closedCount = Number(result.trim());
  console.log(
    `Closed ${Number.isFinite(closedCount) ? closedCount : 0} empty TextEdit document(s).`,
  );
}

async function quitTextEditIfNoDocuments() {
  if (!smokeDocumentCreated) {
    return;
  }

  await osascript([
    'tell application "TextEdit"',
    "if (count of documents) is 0 then quit",
    "end tell",
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await cleanup(false);
    process.exit(130);
  });
}
