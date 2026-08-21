import { describe, expect, test } from "bun:test";
import { readInstallTokenFromRequest } from "./request";

describe("install token request transport", () => {
  test("accepts header transports without leaking tokens through URLs", () => {
    const cases = [
      {
        request: new Request("https://uttr.test/api/entitlement", {
          headers: { authorization: "Bearer token_123" },
        }),
        expected: "token_123",
      },
      {
        request: new Request("https://uttr.test/api/entitlement", {
          headers: { "install-token": "token_456" },
        }),
        expected: "token_456",
      },
      {
        request: new Request(
          "https://uttr.test/api/entitlement?install_token=leaky",
        ),
        expected: null,
      },
    ];

    for (const { request, expected } of cases) {
      expect(readInstallTokenFromRequest(request)).toBe(expected);
    }
  });
});
