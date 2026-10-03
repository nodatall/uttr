import { expect, test, type Page } from "@playwright/test";

const sessionPayload = (sessionId: number, text: string) => ({
  state: "result",
  sessionId,
  selectedText: `Selection ${sessionId}`,
  text,
  error: null,
  messages: [{ role: "assistant", text, pending: false }],
});

async function installAskMocks(page: Page) {
  await page.addInitScript(
    (initialPayload) => {
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      const followUps = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: unknown) => void }
      >();
      let nextId = 1;
      const host = window as any;
      host.__askPayload = initialPayload;
      host.__askListeners = listeners;
      host.__emitAskPayload = (payload: unknown) => {
        host.__askPayload = payload;
        listeners.forEach((listener, id) => {
          if (listener.event === "ask-selection-state") {
            callbacks.get(listener.handler)?.({
              event: listener.event,
              id,
              payload,
            });
          }
        });
      };
      host.__settleFollowUp = (
        sessionId: number,
        error: boolean,
        payload: unknown,
      ) => {
        const request = followUps.get(sessionId)!;
        if (error) request.reject("Older session failed.");
        else request.resolve(payload);
      };
      host.__pendingFollowUps = followUps;
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, id: number) =>
          listeners.delete(id),
      };
      host.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "ask_selection" },
          currentWebview: { label: "ask_selection" },
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
          if (command === "get_ask_selection_payload") {
            if (host.__deferPayloadRefresh) {
              host.__deferPayloadRefresh = false;
              return new Promise((resolve) => {
                host.__resolvePayloadRefresh = resolve;
              });
            }
            return host.__askPayload;
          }
          if (command === "ask_selection_follow_up") {
            host.__askPayload = {
              ...host.__askPayload,
              state: "thinking",
              messages: [
                ...host.__askPayload.messages,
                { role: "user", text: args.message, pending: false },
                { role: "assistant", text: "Thinking...", pending: true },
              ],
            };
            return new Promise((resolve, reject) => {
              followUps.set(args.sessionId, { resolve, reject });
            });
          }
          return null;
        },
      };
    },
    sessionPayload(1, "First answer"),
  );
  await page.goto("/src/ask-selection/index.html");
  await expect(
    page.getByRole("button", { name: "First answer", exact: true }),
  ).toBeVisible();
}

for (const error of [false, true]) {
  test(`ignores an older follow-up ${error ? "error" : "result"} after a new session opens`, async ({
    page,
  }, testInfo) => {
    await installAskMocks(page);
    const composer = page.getByRole("textbox");
    await composer.fill("Follow up on first selection");
    await composer.press("Enter");
    await page.waitForFunction(() => (window as any).__pendingFollowUps.has(1));
    await page.evaluate(
      (payload) => (window as any).__emitAskPayload(payload),
      sessionPayload(2, "Second answer"),
    );
    await composer.fill("Draft for second selection");
    await page.evaluate(
      ({ error, payload }) => {
        (window as any).__settleFollowUp(1, error, payload);
      },
      { error, payload: sessionPayload(1, "Old follow-up answer") },
    );
    await expect(
      page.getByRole("button", { name: "Second answer", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Older session failed.")).toHaveCount(0);
    await expect(page.getByText("Old follow-up answer")).toHaveCount(0);
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("Draft for second selection");
    await page.screenshot({
      path: testInfo.outputPath("new-session-preserved.png"),
    });
  });
}

test("older follow-up finally cannot enable a newer request's composer", async ({
  page,
}) => {
  await installAskMocks(page);
  const composer = page.getByRole("textbox");
  await composer.fill("First follow-up");
  await composer.press("Enter");
  await page.waitForFunction(() => (window as any).__pendingFollowUps.has(1));
  await page.evaluate(
    (payload) => (window as any).__emitAskPayload(payload),
    sessionPayload(2, "Second answer"),
  );
  await composer.fill("Second follow-up");
  await composer.press("Enter");
  await page.waitForFunction(() => (window as any).__pendingFollowUps.has(2));
  await page.evaluate(
    (payload) => (window as any).__settleFollowUp(1, false, payload),
    sessionPayload(1, "Old follow-up answer"),
  );
  await expect(composer).toBeDisabled();
  await expect(page.getByText("Thinking...")).toBeVisible();
  await page.evaluate(
    (payload) => {
      (window as any).__askPayload = payload;
      (window as any).__settleFollowUp(2, false, payload);
    },
    sessionPayload(2, "Second follow-up answer"),
  );
  await expect(
    page.getByRole("button", { name: "Second follow-up answer", exact: true }),
  ).toBeVisible();
  await expect(composer).toBeEnabled();
});

test("a stale payload refresh cannot overwrite a newer native session event", async ({
  page,
}) => {
  await installAskMocks(page);
  await page.evaluate(() => {
    (window as any).__deferPayloadRefresh = true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(() =>
    Boolean((window as any).__resolvePayloadRefresh),
  );
  await page.evaluate(
    (payload) => (window as any).__emitAskPayload(payload),
    sessionPayload(2, "Second answer"),
  );
  await page.evaluate(
    (payload) => (window as any).__resolvePayloadRefresh(payload),
    sessionPayload(1, "Stale refresh answer"),
  );
  await expect(
    page.getByRole("button", { name: "Second answer", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Stale refresh answer")).toHaveCount(0);
});
