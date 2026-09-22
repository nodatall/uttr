import { expect, test, type Page } from "@playwright/test";

async function emitOverlayEvent(page: Page, event: string, payload?: unknown) {
  await page.evaluate(
    ({ event, payload }) => {
      (window as any).__emitOverlayEvent(event, payload);
    },
    { event, payload },
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 100 });
  await page.addInitScript(() => {
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    const host = window as any;
    host.__emitOverlayEvent = (event: string, payload: unknown) => {
      listeners.forEach((listener, id) => {
        if (listener.event === event) {
          callbacks.get(listener.handler)?.({ event, id, payload });
        }
      });
    };
    host.__overlayListeners = listeners;
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => listeners.delete(id),
    };
    host.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "recording_overlay" },
        currentWebview: { label: "recording_overlay" },
      },
      transformCallback: (callback: (value: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any) => {
        if (command === "plugin:event|listen") {
          const id = nextId++;
          listeners.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (command === "plugin:event|unlisten") {
          listeners.delete(args.eventId);
        }
        if (command === "get_app_settings") return { app_language: "en" };
        return null;
      },
    };
    // Keep waveform geometry reproducible while exercising the real renderer.
    Math.random = () => 0.6;
  });
  await page.goto("/src/overlay/index.html");
  await page.waitForFunction(
    () => (window as any).__overlayListeners.size === 4,
  );
  await emitOverlayEvent(page, "show-overlay", "recording");
  await expect(page.locator("canvas")).toHaveCount(1);
});

test("recording feedback is fully visible on the first rendered frame", async ({
  page,
}, testInfo) => {
  await emitOverlayEvent(page, "hide-overlay");
  await expect(page.locator(".recording-overlay")).toHaveCSS("opacity", "0");
  const opacity = await page.evaluate(async () => {
    (window as any).__emitOverlayEvent("show-overlay", "recording");
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return Number(
      getComputedStyle(document.querySelector(".recording-overlay")!).opacity,
    );
  });
  await page.screenshot({ path: testInfo.outputPath("recording-start.png") });
  expect(opacity).toBe(1);
});

test("native show retries preserve the active speech waveform", async ({
  page,
}) => {
  // Observe the real renderer's amplitude API without replacing its animation.
  await page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("/siriwave.js"))!;
    const { default: SiriWave } = await import(/* @vite-ignore */ moduleUrl);
    const setAmplitude = SiriWave.prototype.setAmplitude;
    SiriWave.prototype.setAmplitude = function (amplitude: number) {
      (window as any).__waveAmplitude = amplitude;
      return setAmplitude.call(this, amplitude);
    };
  });
  await emitOverlayEvent(page, "hide-overlay");
  await emitOverlayEvent(page, "show-overlay", "recording");
  await emitOverlayEvent(page, "mic-level", Array(16).fill(0.08));
  const speakingAmplitude = await page.evaluate(
    () => (window as any).__waveAmplitude,
  );
  expect(speakingAmplitude).toBeGreaterThan(1);
  for (const retryDelay of [90, 180]) {
    await page.waitForTimeout(retryDelay);
    await emitOverlayEvent(page, "show-overlay", "recording");
    expect(await page.evaluate(() => (window as any).__waveAmplitude)).toBe(
      speakingAmplitude,
    );
  }
  // A genuinely new recording must still reset the previous speech activity.
  await emitOverlayEvent(page, "hide-overlay");
  await emitOverlayEvent(page, "show-overlay", "recording");
  expect(
    await page.evaluate(() => (window as any).__waveAmplitude),
  ).toBeLessThan(1);
  await emitOverlayEvent(page, "show-overlay", "transcribing");
  await expect(page.locator(".overlay-spinner")).toBeVisible();
});
