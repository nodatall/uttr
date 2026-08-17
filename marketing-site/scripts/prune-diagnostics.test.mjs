import { describe, expect, test } from "bun:test";
import { buildPruneQuery } from "./prune-diagnostics.mjs";

describe("diagnostics prune script", () => {
  test("uses a seven-day retention cutoff for dry run and delete", () => {
    expect(buildPruneQuery({ dryRun: true })).toEqual({
      text: expect.stringContaining("interval '7 days'"),
      action: "count",
    });
    expect(buildPruneQuery({ dryRun: false })).toEqual({
      text: expect.stringContaining("interval '7 days'"),
      action: "delete",
    });
  });
});
