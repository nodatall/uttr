import { afterEach, describe, expect, test } from "bun:test";
import { getDownloadUrl } from "./download";

const originalDownloadUrl = process.env.NEXT_PUBLIC_DOWNLOAD_URL;

afterEach(() => {
  if (typeof originalDownloadUrl === "string") {
    process.env.NEXT_PUBLIC_DOWNLOAD_URL = originalDownloadUrl;
    return;
  }

  delete process.env.NEXT_PUBLIC_DOWNLOAD_URL;
});

describe("download URL helper", () => {
  test("resolves supported default, legacy, and direct download configuration", () => {
    const cases = [
      { configured: undefined, expected: "/download" },
      {
        configured: "https://github.com/nodatall/uttr/releases/latest",
        expected: "/download",
      },
      {
        configured: "https://downloads.uttr.pro/Uttr.dmg",
        expected: "https://downloads.uttr.pro/Uttr.dmg",
      },
    ];

    for (const { configured, expected } of cases) {
      if (configured) {
        process.env.NEXT_PUBLIC_DOWNLOAD_URL = configured;
      } else {
        delete process.env.NEXT_PUBLIC_DOWNLOAD_URL;
      }
      expect(getDownloadUrl()).toBe(expected);
    }
  });
});
