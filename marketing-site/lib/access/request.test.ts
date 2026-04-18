import { describe, expect, test } from "bun:test";
import { readInstallTokenFromRequest } from "./request";

describe("install token request transport", () => {
  test("reads bearer tokens", () => {
    const request = new Request("https://uttr.test/api/entitlement", {
      headers: { authorization: "Bearer token_123" },
    });

    expect(readInstallTokenFromRequest(request)).toBe("token_123");
  });

  test("reads install-token headers", () => {
    const request = new Request("https://uttr.test/api/entitlement", {
      headers: { "install-token": "token_456" },
    });

    expect(readInstallTokenFromRequest(request)).toBe("token_456");
  });

  test("ignores query string install tokens", () => {
    const request = new Request(
      "https://uttr.test/api/entitlement?install_token=leaky",
    );

    expect(readInstallTokenFromRequest(request)).toBeNull();
  });
});
