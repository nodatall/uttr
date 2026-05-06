import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildInstallTokenPayload,
  hashClaimToken,
  signClaimToken,
  signInstallToken,
  verifyClaimToken,
  verifyInstallToken,
} from "./tokens";
import type { ClaimTokenPayload, InstallTokenPayload } from "./types";

const originalEnv = {
  UTTR_INSTALL_TOKEN_SECRET: process.env.UTTR_INSTALL_TOKEN_SECRET,
  UTTR_CLAIM_TOKEN_SECRET: process.env.UTTR_CLAIM_TOKEN_SECRET,
};

beforeEach(() => {
  process.env.UTTR_INSTALL_TOKEN_SECRET = "install-secret-test";
  process.env.UTTR_CLAIM_TOKEN_SECRET = "claim-secret-test";
});

afterEach(() => {
  process.env.UTTR_INSTALL_TOKEN_SECRET = originalEnv.UTTR_INSTALL_TOKEN_SECRET;
  process.env.UTTR_CLAIM_TOKEN_SECRET = originalEnv.UTTR_CLAIM_TOKEN_SECRET;
});

const installPayload: InstallTokenPayload = {
  version: 1,
  anonymous_trial_id: "trial_123",
  install_id: "install_123",
  device_fingerprint_hash: "fingerprint_123",
  issued_at: "2026-03-23T00:00:00.000Z",
  expires_at: "2026-04-22T00:00:00.000Z",
  jti: "install_token_123",
};

const claimPayload: ClaimTokenPayload = {
  version: 1,
  claim_id: "claim_123",
  anonymous_trial_id: "trial_123",
  install_id: "install_123",
  issued_at: "2026-03-23T00:00:00.000Z",
  expires_at: "2026-03-23T01:00:00.000Z",
};

describe("token helpers", () => {
  test("signs and verifies install tokens", () => {
    const token = signInstallToken(installPayload);
    expect(
      verifyInstallToken(token, new Date("2026-03-23T00:00:00.000Z")),
    ).toEqual(installPayload);
  });

  test("rejects tampered install tokens", () => {
    const token = signInstallToken(installPayload);
    const tampered = `${token.slice(0, -1)}x`;

    expect(() => verifyInstallToken(tampered)).toThrow(
      "Invalid install token signature.",
    );
  });

  test("rejects expired install tokens", () => {
    const token = signInstallToken(installPayload);

    expect(() =>
      verifyInstallToken(token, new Date("2026-04-22T00:00:00.000Z")),
    ).toThrow("Install token expired.");
  });

  test("builds expiring install token payloads with unique ids", () => {
    const payload = buildInstallTokenPayload({
      anonymousTrialId: "trial_123",
      installId: "install_123",
      deviceFingerprintHash: "fingerprint_123",
      issuedAt: new Date("2026-03-23T00:00:00.000Z"),
    });

    expect(payload).toMatchObject({
      version: 1,
      anonymous_trial_id: "trial_123",
      install_id: "install_123",
      device_fingerprint_hash: "fingerprint_123",
      issued_at: "2026-03-23T00:00:00.000Z",
      expires_at: "2026-04-22T00:00:00.000Z",
    });
    expect(payload.jti).toHaveLength(36);
  });

  test("signs and verifies claim tokens", () => {
    const token = signClaimToken(claimPayload);
    expect(verifyClaimToken(token)).toEqual(claimPayload);
    expect(hashClaimToken(token)).toHaveLength(64);
  });
});
