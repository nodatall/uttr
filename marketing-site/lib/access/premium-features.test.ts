import { describe, expect, test } from "bun:test";
import { accessAllowsCloudSource } from "./premium-features";

describe("premium cloud feature access", () => {
  test("allows cloud transcription only during trial or after subscription", () => {
    expect(accessAllowsCloudSource("trialing", "file_transcription")).toBe(
      true,
    );
    expect(accessAllowsCloudSource("trialing", "full_system_audio")).toBe(true);
    expect(accessAllowsCloudSource("subscribed", "file_transcription")).toBe(
      true,
    );
    expect(accessAllowsCloudSource("blocked", "microphone")).toBe(false);
    expect(accessAllowsCloudSource("blocked", "microphone", "new")).toBe(true);
  });
});
