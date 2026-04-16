import { invoke } from "@tauri-apps/api/core";

const startupOrigin = performance.now();

export function startupElapsedMs() {
  return Math.round(performance.now() - startupOrigin);
}

export function logFrontendStartup(event: string) {
  const message = `${event} elapsed_ms=${startupElapsedMs()}`;
  console.info(`[startup] ${message}`);
  void invoke("log_frontend_startup", { message }).catch(() => {});
}
