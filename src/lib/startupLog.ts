import { commands } from "@/bindings";

const startupOrigin = performance.now();

function startupElapsedMs() {
  return Math.round(performance.now() - startupOrigin);
}

export function logFrontendStartup(event: string) {
  const message = `${event} elapsed_ms=${startupElapsedMs()}`;
  console.info(`[startup] ${message}`);
  void commands.logFrontendStartup(message).catch(() => {});
}
