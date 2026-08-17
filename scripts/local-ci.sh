#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

RUN_INSTALL=0
FULL_NATIVE_TRANSCRIBE=0
SKIP_TRANSCRIBE=0
SKIP_EVALS=0

usage() {
  cat <<'EOF'
Usage: bun run ci:local [--] [options]

Runs the local pre-merge validation gate. This is meant to cover the checks
that should pass before merging a PR, including local-only checks that GitHub
Actions cannot fully exercise.

Options:
  --install                  Refresh root and marketing-site dependencies first.
  --full-native-transcribe   Run the invasive native transcription smoke test.
  --skip-transcribe          Skip the transcription smoke preflight.
  --skip-evals               Skip the optional LLM eval hook.
  -h, --help                 Show this help.

Default transcription behavior:
  Runs the release transcription smoke preflight only:
    bun run test:e2e:release-transcribe -- --preflight-only --no-screenshots

The full native transcription smoke test launches Uttr, opens TextEdit, sends
shortcuts, waits for pasted text, and requires local macOS automation access.

Future LLM evals:
  If scripts/llm-evals-local.sh exists and is executable, this gate runs it.
  Keep expensive/provider-backed evals behind that script so the merge gate has
  one stable entrypoint.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      RUN_INSTALL=1
      ;;
    --full-native-transcribe)
      FULL_NATIVE_TRANSCRIBE=1
      ;;
    --skip-transcribe)
      SKIP_TRANSCRIBE=1
      ;;
    --skip-evals)
      SKIP_EVALS=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

run_step() {
  local label="$1"
  shift
  echo ""
  echo "==> ${label}"
  "$@"
}

run_shell_step() {
  local label="$1"
  shift
  echo ""
  echo "==> ${label}"
  bash -lc "$*"
}

if [[ "${RUN_INSTALL}" == "1" ]]; then
  run_step "Install root dependencies" bun install --frozen-lockfile
  run_shell_step "Install marketing-site dependencies" "cd marketing-site && npm ci"
fi

run_step "Format check" bun run format:check
run_step "Translation check" bun run check:translations
run_step "Desktop frontend lint" bun run lint
run_step "Desktop frontend build" bun run build
run_shell_step "Rust tests" "cd src-tauri && cargo test"
run_step "Playwright E2E" bun run test:playwright
run_shell_step "Marketing site lint" "npm --prefix marketing-site run lint"
run_shell_step "Marketing site tests" "npm --prefix marketing-site test"
run_shell_step "Marketing site build" "npm --prefix marketing-site run build"

if [[ "${SKIP_TRANSCRIBE}" == "0" ]]; then
  if [[ "${FULL_NATIVE_TRANSCRIBE}" == "1" ]]; then
    run_step "Native transcription smoke" bun run test:e2e:release-transcribe
  else
    run_step "Transcription smoke preflight" bun run test:e2e:release-transcribe -- --preflight-only --no-screenshots
  fi
else
  echo ""
  echo "==> Transcription smoke skipped"
fi

if [[ "${SKIP_EVALS}" == "0" ]]; then
  if [[ -x scripts/llm-evals-local.sh ]]; then
    run_step "LLM evals" scripts/llm-evals-local.sh
  else
    echo ""
    echo "==> LLM evals"
    echo "No scripts/llm-evals-local.sh hook found; skipping."
  fi
else
  echo ""
  echo "==> LLM evals skipped"
fi

echo ""
echo "Local CI passed."
