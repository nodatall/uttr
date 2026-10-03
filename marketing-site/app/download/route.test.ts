import { describe, expect, test } from "bun:test";
import { GET, getDirectMacAppDownloadUrl, selectMacDmgAsset } from "./route";

describe("macOS download asset selection", () => {
  test("ignores non-uploaded and non-DMG assets", () => {
    expect(
      selectMacDmgAsset(
        [
          {
            name: "Uttr_1.2.3_aarch64.dmg",
            state: "new",
            browser_download_url: "https://example.com/Uttr.dmg",
          },
          {
            name: "Uttr_1.2.3_aarch64.AppImage",
            state: "uploaded",
            browser_download_url: "https://example.com/Uttr.AppImage",
          },
        ],
        "aarch64",
      ),
    ).toBeNull();
  });

  test("falls back to a direct app download instead of the release list", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = (async () =>
      new Response("unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      })) as typeof fetch;
    console.error = () => {};

    try {
      const response = await GET(
        new Request("https://uttr.test/download?arch=intel"),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        getDirectMacAppDownloadUrl("x64"),
      );
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
    }
  });
});
