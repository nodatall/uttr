#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.local"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
fi

KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-}"
if [[ -n "${KEY_PATH}" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ ! -f "${KEY_PATH}" ]]; then
    echo "Error: TAURI_SIGNING_PRIVATE_KEY_PATH does not exist: ${KEY_PATH}" >&2
    exit 1
  fi

  export TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY="$(cat "${KEY_PATH}")"
fi

TAURI_CMD="${1:-}"

if [[ "${TAURI_CMD}" == "build" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  cat <<'EOF' >&2
Error: missing updater signing key.
Set one of:
  - TAURI_SIGNING_PRIVATE_KEY
  - TAURI_SIGNING_PRIVATE_KEY_PATH in .env.local
EOF
  exit 1
fi

TAURI_BIN="${ROOT_DIR}/node_modules/.bin/tauri"
if [[ ! -x "${TAURI_BIN}" ]]; then
  echo "Error: ${TAURI_BIN} not found. Run your package install first." >&2
  exit 1
fi

if [[ "${TAURI_CMD}" == "dev" ]]; then
  VITE_PORT="${VITE_PORT:-1420}"
  DEV_CONFIG="$(node -e '
const port = process.argv[1];
const origin = `http://localhost:${port}`;
const devCsp = [
  `default-src '\''self'\'' ${origin} ipc: http://ipc.localhost`,
  `script-src '\''self'\'' '\''unsafe-inline'\'' ${origin}`,
  `style-src '\''self'\'' '\''unsafe-inline'\'' https://fonts.googleapis.com ${origin}`,
  "font-src '\''self'\'' https://fonts.gstatic.com data:",
  `img-src '\''self'\'' asset: http://asset.localhost data: blob: ${origin}`,
  "connect-src ipc: http://ipc.localhost http://localhost:* ws://localhost:*",
  "object-src '\''none'\''",
  "base-uri '\''self'\''",
  "frame-ancestors '\''none'\''",
].join("; ");
process.stdout.write(JSON.stringify({
  build: { devUrl: origin },
  app: { security: { devCsp } },
}));
' "${VITE_PORT}")"
  exec "${TAURI_BIN}" dev --config "${DEV_CONFIG}" "${@:2}"
fi

exec "${TAURI_BIN}" "$@"
