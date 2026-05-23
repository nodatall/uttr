#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
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
const startupTimeoutMs = Number(args["startup-timeout-ms"] ?? 90_000);
const transcriptionTimeoutMs = Number(
  args["transcription-timeout-ms"] ?? 120_000,
);
const keepArtifacts = Boolean(args["keep-artifacts"]);
const preflightOnly = Boolean(args["preflight-only"]);

let tauriProcess = null;
let tauriStdioFds = [];
let scratchDir = "";

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

  await mkdir(appDataDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await seedSettings(appDataDir, provider);
  await prepareModelDirectory(appDataDir, provider);

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

  await openTextEditTarget();

  console.log("");
  console.log("When recording starts, speak this phrase clearly:");
  console.log(`  ${phrase}`);
  await promptEnter("Press Enter to start recording.");

  await triggerSmokeShortcut();
  await waitForLog(
    logPath,
    "overlay shown state=recording",
    15_000,
    "recording overlay",
  );

  for (let remaining = recordSeconds; remaining > 0; remaining -= 1) {
    process.stdout.write(`Recording... ${remaining}s remaining\r`);
    await sleep(1_000);
  }
  process.stdout.write("\n");

  await triggerSmokeShortcut();
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

  console.log(`Pasted text: ${pastedText.trim()}`);
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
    if (key === "keep-artifacts" || key === "preflight-only") {
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
profile. The test opens TextEdit, triggers the configured global shortcut,
records from the live microphone, waits for transcription, and verifies pasted
text.

Options:
  --phrase <text>                 Spoken phrase to ask the operator to say.
  --tokens <a,b,c>                Comma-separated tokens expected in pasted text.
  --record-seconds <seconds>      Recording duration. Default: 5.
  --preflight-only                Verify provider/settings setup without launching Uttr.
  --keep-artifacts                Keep scratch evidence after a successful run.

Provider setup:
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

  throw new Error(
    "No real transcription provider is available. Set UTTR_OPENAI_API_KEY, OPENAI_API_KEY, UTTR_GROQ_API_KEY, GROQ_API_KEY, or UTTR_RELEASE_SMOKE_MODEL_DIR.",
  );
}

function hasEnv(name) {
  return Boolean(process.env[name]?.trim());
}

async function seedSettings(appDataDir, provider) {
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
    settings: {
      bindings,
      push_to_talk: false,
      audio_feedback: false,
      onboarding_completed: true,
      selected_model: provider.selectedModel,
      anonymous_trial_state: "new",
      access_state: "blocked",
      entitlement_state: "inactive",
      byok_enabled: false,
      byok_validation_state: "unknown",
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
    },
  };

  await writeFile(
    path.join(appDataDir, "settings_store.json"),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf8",
  );
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

async function startTauriDev({ homeDir, stdoutPath, stderrPath, provider }) {
  const stdoutHandle = await openAppend(stdoutPath);
  const stderrHandle = await openAppend(stderrPath);
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
    VITE_PORT: process.env.UTTR_RELEASE_SMOKE_VITE_PORT ?? "1420",
    VITE_HMR_PORT: process.env.UTTR_RELEASE_SMOKE_VITE_HMR_PORT ?? "1421",
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
    if (tauriProcess === child) {
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
  await osascript([
    'tell application "TextEdit"',
    "activate",
    'make new document with properties {text:""}',
    "end tell",
    "delay 0.5",
  ]);
}

async function triggerSmokeShortcut() {
  await osascript([
    'tell application "System Events"',
    'keystroke "9" using {command down, shift down}',
    "end tell",
  ]);
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
      'if not (exists front document) then return ""',
      "return text of front document",
      "end tell",
    ]);
  } catch {
    return "";
  }
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

async function promptEnter(message) {
  process.stdout.write(`${message} `);
  process.stdin.resume();
  return new Promise((resolve) => {
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function cleanup(success) {
  if (tauriProcess) {
    try {
      process.kill(-tauriProcess.pid, "SIGTERM");
    } catch {}
    await sleep(1_000);
    try {
      process.kill(-tauriProcess.pid, "SIGKILL");
    } catch {}
    tauriProcess = null;
  }

  for (const fd of tauriStdioFds) {
    try {
      closeSync(fd);
    } catch {}
  }
  tauriStdioFds = [];

  if (success && scratchDir && !keepArtifacts) {
    await rm(scratchDir, { recursive: true, force: true });
  }
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
