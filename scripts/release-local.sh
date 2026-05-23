#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: bun run release:local

Runs the local native transcription smoke test, then triggers:
  gh workflow run release.yml --ref main

The smoke test requires macOS and local automation permission. By default it
copies the current Uttr app profile into an isolated smoke profile, including
the configured transcription model and encrypted BYOK files. Optional provider
overrides:
  - UTTR_OPENAI_API_KEY or OPENAI_API_KEY
  - UTTR_GROQ_API_KEY or GROQ_API_KEY
  - UTTR_RELEASE_SMOKE_MODEL_DIR pointing to a local Parakeet v3 model directory
EOF
  exit 0
fi

current_branch="$(git branch --show-current)"
if [[ "${current_branch}" != "main" ]]; then
  echo "Error: release:local must be run from main. Current branch: ${current_branch:-detached HEAD}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "Error: working tree must be clean before triggering a release." >&2
  git status --short >&2
  exit 1
fi

git fetch origin main

local_main="$(git rev-parse main)"
remote_main="$(git rev-parse origin/main)"
if [[ "${local_main}" != "${remote_main}" ]]; then
  echo "Error: local main does not match origin/main. Push or pull before releasing." >&2
  echo "main:        ${local_main}" >&2
  echo "origin/main: ${remote_main}" >&2
  exit 1
fi

node <<'NODE'
const fs = require("fs");

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoLock = fs.readFileSync("src-tauri/Cargo.lock", "utf8");
const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];
const lockVersion = cargoLock.match(/^name = "handy"\nversion = "([^"]+)"/m)?.[1];

const versions = {
  "package.json": packageVersion,
  "src-tauri/tauri.conf.json": tauriVersion,
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/Cargo.lock handy package": lockVersion,
};

const missing = Object.entries(versions).filter(([, value]) => !value);
if (missing.length > 0) {
  console.error(`Error: could not read version from ${missing.map(([name]) => name).join(", ")}`);
  process.exit(1);
}

const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error("Error: release version files are out of sync:");
  for (const [name, value] of Object.entries(versions)) {
    console.error(`  ${name}: ${value}`);
  }
  process.exit(1);
}

console.log(`Release version: ${packageVersion}`);
NODE

bun run test:e2e:release-transcribe

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh is not installed or not on PATH." >&2
  exit 1
fi

gh auth status >/dev/null
gh workflow run release.yml --ref main
