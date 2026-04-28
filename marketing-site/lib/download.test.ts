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
  test("uses the first-party download route by default", () => {
    delete process.env.NEXT_PUBLIC_DOWNLOAD_URL;

    expect(getDownloadUrl()).toBe("/download");
  });

  test("maps the old GitHub releases page env value to the download route", () => {
    process.env.NEXT_PUBLIC_DOWNLOAD_URL =
      "https://github.com/nodatall/uttr/releases/latest";

    expect(getDownloadUrl()).toBe("/download");
  });

  test("keeps explicit direct download URLs", () => {
    process.env.NEXT_PUBLIC_DOWNLOAD_URL =
      "https://downloads.uttr.pro/Uttr.dmg";

    expect(getDownloadUrl()).toBe("https://downloads.uttr.pro/Uttr.dmg");
  });
});
