import { expect, test, type Page } from "@playwright/test";

test.use({ deviceScaleFactor: 2 });

async function emitOverlayEvent(page: Page, event: string, payload?: unknown) {
  await page.evaluate(
    ({ event, payload }) => {
      (window as any).__emitOverlayEvent(event, payload);
    },
    { event, payload },
  );
}

function waveformFrame(page: Page) {
  return page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    return canvas.toDataURL();
  });
}

function waveformInk(page: Page) {
  return page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      ink += pixels[i];
    }
    return ink;
  });
}

async function visibleWaveformRows(page: Page, path: string) {
  const screenshot = await page.screenshot({ path });
  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const center = context.getImageData(
      Math.floor(canvas.width / 2),
      0,
      1,
      canvas.height,
    ).data;
    const background = center[Math.floor(canvas.height / 4) * 4];
    let visibleRows = 0;
    for (let row = 0; row < canvas.height; row++) {
      if (center[row * 4] - background >= 48) {
        visibleRows++;
      }
    }
    return visibleRows;
  }, screenshot.toString("base64"));
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

test("Fn down shows a still waveform that moves with speech", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 172, height: 42 });
  await page.addStyleTag({
    content: "html { background: #16181e !important; }",
  });
  const overlay = page.locator(".recording-overlay");
  await emitOverlayEvent(page, "hide-overlay");
  const opacity = await page.evaluate(async () => {
    (window as any).__emitOverlayEvent("show-overlay", "fn-preview");
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return getComputedStyle(document.querySelector(".recording-overlay")!)
      .opacity;
  });
  expect(opacity).toBe("1");
  const silentFrame = await waveformFrame(page);
  await emitOverlayEvent(page, "mic-level", Array(16).fill(0.08));
  expect(
    await visibleWaveformRows(page, testInfo.outputPath("fn-preview.png")),
  ).toBeGreaterThanOrEqual(3);
  expect(await waveformFrame(page)).toBe(silentFrame);

  // A different shortcut dismisses the preview before capture has started.
  await emitOverlayEvent(page, "hide-overlay");
  await expect(overlay).toHaveCSS("opacity", "0");
  await emitOverlayEvent(page, "mic-level", Array(16).fill(0.08));
  await expect(overlay).toHaveCSS("opacity", "0");

  // Confirming capture keeps the still waveform until speech arrives.
  await emitOverlayEvent(page, "show-overlay", "fn-preview");
  await emitOverlayEvent(page, "show-overlay", "recording");
  const silence = Array(16).fill(0);
  await emitOverlayEvent(page, "mic-level", silence);
  expect(await waveformFrame(page)).toBe(silentFrame);

  await emitOverlayEvent(page, "mic-level", Array(16).fill(0.08));
  await expect.poll(() => waveformFrame(page)).not.toBe(silentFrame);
  const speakingFrame = await waveformFrame(page);
  await expect.poll(() => waveformFrame(page)).not.toBe(speakingFrame);
  await expect
    .poll(async () => {
      await emitOverlayEvent(page, "mic-level", silence);
      return waveformFrame(page);
    })
    .toBe(silentFrame);
  await expect(overlay).toHaveCSS("opacity", "1");
  expect(
    await visibleWaveformRows(page, testInfo.outputPath("speech-pause.png")),
  ).toBeGreaterThanOrEqual(3);
  await emitOverlayEvent(page, "mic-level", Array(16).fill(0.08));
  await expect.poll(() => waveformFrame(page)).not.toBe(silentFrame);
});

test("the recording waveform eases into a pause and resumes with speech", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 172, height: 42 });
  await page.addStyleTag({
    content: "html { background: #16181e !important; }",
  });
  await page.clock.install();
  const speech = Array(16).fill(0.08);
  const silence = Array(16).fill(0);
  await emitOverlayEvent(page, "mic-level", speech);
  await page.clock.runFor(380);
  await emitOverlayEvent(page, "mic-level", silence);
  await page.clock.runFor(270);
  const speakingInk = await waveformInk(page);
  expect(speakingInk).toBeGreaterThan(0);
  await emitOverlayEvent(page, "mic-level", silence);
  expect(await waveformInk(page)).toBeGreaterThan(0);

  await page.clock.runFor(80);
  // The native show retry during a pause must preserve the decay.
  await emitOverlayEvent(page, "show-overlay", "recording");
  await page.clock.runFor(120);
  const quietingInk = await waveformInk(page);
  expect(quietingInk).toBeGreaterThan(0);
  expect(quietingInk).toBeLessThan(speakingInk);
  await page.screenshot({ path: testInfo.outputPath("waveform-settling.png") });

  await page.clock.runFor(500);
  await emitOverlayEvent(page, "mic-level", silence);
  expect(await waveformInk(page)).toBe(0);
  expect(
    await visibleWaveformRows(
      page,
      testInfo.outputPath("waveform-resting.png"),
    ),
  ).toBeGreaterThanOrEqual(3);

  await emitOverlayEvent(page, "mic-level", speech);
  await page.clock.runFor(120);
  expect(await waveformInk(page)).toBeGreaterThan(0);
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
  const silentFrame = await waveformFrame(page);
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
  expect(await waveformFrame(page)).toBe(silentFrame);
  await emitOverlayEvent(page, "show-overlay", "transcribing");
  await expect(page.locator(".overlay-spinner")).toBeVisible();
});
