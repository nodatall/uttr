import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readAccessTokenConfig } from "@/lib/env";
import type { ClaimTokenPayload, InstallTokenPayload } from "./types";

function encodeBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isInstallTokenPayload(value: unknown): value is InstallTokenPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<InstallTokenPayload>;
  return (
    candidate.version === 1 &&
    typeof candidate.anonymous_trial_id === "string" &&
    typeof candidate.install_id === "string" &&
    typeof candidate.device_fingerprint_hash === "string" &&
    typeof candidate.issued_at === "string"
  );
}

function isClaimTokenPayload(value: unknown): value is ClaimTokenPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ClaimTokenPayload>;
  return (
    candidate.version === 1 &&
    typeof candidate.claim_id === "string" &&
    typeof candidate.anonymous_trial_id === "string" &&
    typeof candidate.install_id === "string" &&
    typeof candidate.issued_at === "string" &&
    typeof candidate.expires_at === "string"
  );
}

export function signInstallToken(payload: InstallTokenPayload) {
  const { installTokenSecret } = readAccessTokenConfig();
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", installTokenSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export function verifyInstallToken(token: string) {
  const { installTokenSecret } = readAccessTokenConfig();
  const [encodedPayload, encodedSignature] = token.split(".");

  if (!encodedPayload || !encodedSignature) {
    throw new Error("Malformed install token.");
  }

  const expectedSignature = createHmac("sha256", installTokenSecret)
    .update(encodedPayload)
    .digest("base64url");

  const provided = Buffer.from(encodedSignature);
  const expected = Buffer.from(expectedSignature);

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid install token signature.");
  }

  const parsedPayload = JSON.parse(decodeBase64Url(encodedPayload)) as unknown;
  if (!isInstallTokenPayload(parsedPayload)) {
    throw new Error("Invalid install token payload.");
  }

  return parsedPayload;
}

export function signClaimToken(payload: ClaimTokenPayload) {
  const { claimTokenSecret } = readAccessTokenConfig();
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", claimTokenSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export function verifyClaimToken(token: string) {
  const { claimTokenSecret } = readAccessTokenConfig();
  const [encodedPayload, encodedSignature] = token.split(".");

  if (!encodedPayload || !encodedSignature) {
    throw new Error("Malformed claim token.");
  }

  const expectedSignature = createHmac("sha256", claimTokenSecret)
    .update(encodedPayload)
    .digest("base64url");

  const provided = Buffer.from(encodedSignature);
  const expected = Buffer.from(expectedSignature);

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid claim token signature.");
  }

  const parsedPayload = JSON.parse(decodeBase64Url(encodedPayload)) as unknown;
  if (!isClaimTokenPayload(parsedPayload)) {
    throw new Error("Invalid claim token payload.");
  }

  return parsedPayload;
}

export function hashClaimToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
