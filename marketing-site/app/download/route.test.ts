import { describe, expect, test } from "bun:test";
import { selectMacDmgAsset } from "./route";

const assets = [
  {
    name: "latest.json",
    state: "uploaded",
    browser_download_url:
      "https://github.com/nodatall/uttr/releases/download/v1/latest.json",
  },
  {
    name: "Uttr_1.2.3_x64.dmg",
    state: "uploaded",
    browser_download_url:
      "https://github.com/nodatall/uttr/releases/download/v1/Uttr_1.2.3_x64.dmg",
  },
  {
    name: "Uttr_1.2.3_aarch64.dmg",
    state: "uploaded",
    browser_download_url:
      "https://github.com/nodatall/uttr/releases/download/v1/Uttr_1.2.3_aarch64.dmg",
  },
];

describe("macOS download asset selection", () => {
  test("prefers Apple Silicon DMG by default", () => {
    expect(selectMacDmgAsset(assets, "aarch64")?.name).toBe(
      "Uttr_1.2.3_aarch64.dmg",
    );
  });

  test("selects Intel DMG when requested", () => {
    expect(selectMacDmgAsset(assets, "x64")?.name).toBe("Uttr_1.2.3_x64.dmg");
  });

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
});
