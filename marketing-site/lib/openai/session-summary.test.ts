import { describe, expect, test } from "bun:test";
import {
  buildSummaryPrompt,
  SESSION_SUMMARY_SYSTEM_PROMPT,
} from "./session-summary";

describe("session summary prompt", () => {
  test("requests only current gist and expanded key points", () => {
    const prompt = buildSummaryPrompt({
      transcriptText: "We discussed the launch plan and follow-up tasks.",
      previousSummary: "Earlier context.",
    });

    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("Return valid JSON only");
    expect(prompt).toContain("current_gist");
    expect(prompt).toContain("key_points");
    expect(prompt).toContain("details");
    expect(prompt).toContain("Current gist, Key points");
    expect(prompt).not.toContain("action_items");
    expect(prompt).not.toContain('"timeline"');
    expect(prompt).not.toContain("Action items");
    expect(prompt).not.toContain("Timeline");
    expect(prompt).not.toContain("Notable points");
    expect(prompt).not.toContain("Risks / blockers");
    expect(prompt).not.toContain("Open questions");
  });
});
