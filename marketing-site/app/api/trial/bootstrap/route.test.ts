import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests } from "@/lib/db";
import { POST } from "./route";

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  setDbExecutorForTests(null);
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("/api/trial/bootstrap", () => {
  test("returns a client error for malformed JSON payloads", async () => {
    const response = await POST(
      new Request("https://uttr.test/api/trial/bootstrap", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid bootstrap payload.",
    });
  });
});
