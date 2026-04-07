import { describe, expect, test } from "bun:test";
import {
  accessAllowsCloudSource,
  sourceRequiresPremiumCloudAccess,
} from "./premium-features";

describe("premium cloud feature access", () => {
  test("treats file transcription and full-system audio as premium sources", () => {
    expect(sourceRequiresPremiumCloudAccess("file_transcription")).toBe(true);
    expect(sourceRequiresPremiumCloudAccess(" full_system_audio ")).toBe(true);
    expect(sourceRequiresPremiumCloudAccess("microphone")).toBe(false);
    expect(sourceRequiresPremiumCloudAccess(null)).toBe(false);
  });

  test("allows premium sources only for subscribed access", () => {
    expect(accessAllowsCloudSource("trialing", "file_transcription")).toBe(
      false,
    );
    expect(accessAllowsCloudSource("trialing", "full_system_audio")).toBe(
      false,
    );
    expect(accessAllowsCloudSource("subscribed", "file_transcription")).toBe(
      true,
    );
    expect(accessAllowsCloudSource("blocked", "microphone")).toBe(true);
  });
});
