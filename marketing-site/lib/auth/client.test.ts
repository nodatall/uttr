import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { createAuthClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("auth client failures", () => {
  test("cancels a session request before delayed response headers arrive", async () => {
    const source = await readFile(
      new URL("./client.ts", import.meta.url),
      "utf8",
    );
    const { outputText } = transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    });
    const clientModule = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
    // Keep native socket cancellation out of Bun's shared test process: its
    // aborted-response teardown can crash the runner before assertions finish.
    await promisify(execFile)(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { createServer } from "node:http";
      const { createAuthClient } = await import(${JSON.stringify(clientModule)});
      let received;
      const requestReceived = new Promise(resolve => { received = resolve; });
      let delayedResponse;
      const server = createServer((_request, response) => {
        delayedResponse = response;
        received();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (_input, init) => nativeFetch(
        "http://127.0.0.1:" + address.port + "/api/auth/session", init);
      const controller = new AbortController();
      try {
        const pending = createAuthClient().getSession({ signal: controller.signal });
        await requestReceived;
        controller.abort(new DOMException("Session check cancelled.", "AbortError"));
        await assert.rejects(pending, { name: "AbortError", message: "Session check cancelled." });
      } finally {
        delayedResponse.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "uttr_session=synthetic; HttpOnly; Path=/"
        });
        delayedResponse.end(JSON.stringify({ session: {
          expires_at: "2099-01-01T00:00:00Z",
          user: { id: "synthetic-user", email: "synthetic@example.test" }
        }}));
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    `,
      ],
      { timeout: 3_000 },
    );
  });

  test("rejects logout transport failures", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("Connection lost."))) as typeof fetch;
    await expect(createAuthClient().signOut()).rejects.toThrow(
      "Connection lost.",
    );
  });

  test("rejects unsuccessful logout responses", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ error: "Unable to log out." }, { status: 503 }),
      )) as typeof fetch;
    await expect(createAuthClient().signOut()).rejects.toThrow(
      "Unable to log out.",
    );
  });

  test("allows logout only after a successful response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ signed_out: true }))) as typeof fetch;
    await expect(createAuthClient().signOut()).resolves.toBeUndefined();
  });

  test("treats an unauthorized session as signed out", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ error: "Missing session." }, { status: 401 }),
      )) as typeof fetch;
    await expect(createAuthClient().getSession()).resolves.toBeNull();
  });

  test("preserves the distinction between server failure and signed out", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json(
          { error: "Session service unavailable." },
          { status: 503 },
        ),
      )) as typeof fetch;
    await expect(createAuthClient().getSession()).rejects.toThrow(
      "Session service unavailable.",
    );
  });

  test("rejects session transport and malformed-success failures", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("Connection lost."))) as typeof fetch;
    await expect(createAuthClient().getSession()).rejects.toThrow(
      "Connection lost.",
    );
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({}))) as typeof fetch;
    await expect(createAuthClient().getSession()).rejects.toThrow(
      "Unable to check your session.",
    );
  });
});
