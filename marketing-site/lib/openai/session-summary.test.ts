import { describe, expect, test } from "bun:test";
import {
  buildSummaryPrompt,
  SESSION_SUMMARY_SYSTEM_PROMPT,
} from "./session-summary";

describe("session summary prompt", () => {
  test("requests only the four supported summary sections", () => {
    const prompt = buildSummaryPrompt({
      transcriptText: "We discussed the launch plan and follow-up tasks.",
      previousSummary: "Earlier context.",
    });

    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("Return valid JSON only");
    expect(prompt).toContain("current_gist");
    expect(prompt).toContain("key_points");
    expect(prompt).toContain("action_items");
    expect(prompt).toContain("timeline");
    expect(prompt).toContain(
      "Current gist, Key points, Action items, Timeline",
    );
    expect(prompt).not.toContain("Notable points");
    expect(prompt).not.toContain("Risks / blockers");
    expect(prompt).not.toContain("Open questions");
  });
});
