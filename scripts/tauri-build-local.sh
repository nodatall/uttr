#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.local"

if [[ -f "${HOME}/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  source "${HOME}/.cargo/env"
fi

for LOCAL_BIN_DIR in "${HOME}/.bun/bin" "${HOME}/Library/Python/3.9/bin"; do
  if [[ -d "${LOCAL_BIN_DIR}" && ":${PATH}:" != *":${LOCAL_BIN_DIR}:"* ]]; then
    PATH="${LOCAL_BIN_DIR}:${PATH}"
  fi
done
export PATH

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
  if [[ -z "${VITE_PORT:-}" ]]; then
    VITE_PORT="$(node <<'NODE'
const net = require("node:net");

async function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port, host: "localhost" });
  });
}

(async () => {
  for (let port = 1420; port < 1520; port += 1) {
    if (await canListen(port)) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.stderr.write("Error: no available Vite dev port found from 1420-1519\n");
  process.exit(1);
})();
NODE
)"
  fi

  export VITE_PORT

  if [[ -z "${VITE_HMR_PORT:-}" ]]; then
    VITE_HMR_PORT="$(VITE_PORT="${VITE_PORT}" node <<'NODE'
const net = require("node:net");
const vitePort = Number(process.env.VITE_PORT);

async function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port, host: "localhost" });
  });
}

(async () => {
  for (let port = vitePort + 1; port < vitePort + 101; port += 1) {
    if (port !== vitePort && (await canListen(port))) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.stderr.write("Error: no available Vite HMR port found\n");
  process.exit(1);
})();
NODE
)"
  fi

  export VITE_HMR_PORT
  echo "Using Vite dev port ${VITE_PORT} and HMR port ${VITE_HMR_PORT}"

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
