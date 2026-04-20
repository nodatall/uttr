import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests } from "@/lib/db";
import {
  authenticateUserWithPassword,
  createAuthSession,
  createUserWithPassword,
  verifySessionToken,
} from "./server";

const originalSessionSecret = process.env.UTTR_SESSION_SECRET;

beforeEach(() => {
  process.env.UTTR_SESSION_SECRET = "test-session-secret-with-enough-entropy";
});

afterEach(() => {
  setDbExecutorForTests(null);
  if (typeof originalSessionSecret === "string") {
    process.env.UTTR_SESSION_SECRET = originalSessionSecret;
  } else {
    delete process.env.UTTR_SESSION_SECRET;
  }
});

describe("Postgres-backed auth", () => {
  test("stores scrypt password hashes and verifies credentials", async () => {
    let storedHash = "";
    setDbExecutorForTests({
      async query(sql, values) {
        if (sql.includes("insert into public.profiles")) {
          storedHash = String(values?.[1] ?? "");
          return {
            rows: [{ id: "user_123", email: values?.[0] }],
            rowCount: 1,
          };
        }

        if (sql.includes("where lower(email)")) {
          return {
            rows: [
              {
                id: "user_123",
                email: "user@example.com",
                password_hash: storedHash,
              },
            ],
            rowCount: 1,
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    });

    const user = await createUserWithPassword({
      email: "user@example.com",
      password: "correct-password",
    });

    expect(user).toEqual({ id: "user_123", email: "user@example.com" });
    expect(storedHash).toMatch(/^scrypt\$/);
    await expect(
      authenticateUserWithPassword({
        email: "user@example.com",
        password: "correct-password",
      }),
    ).resolves.toEqual(user);
    await expect(
      authenticateUserWithPassword({
        email: "user@example.com",
        password: "wrong-password",
      }),
    ).resolves.toBeNull();
  });

  test("signs verifiable account session tokens", async () => {
    const session = await createAuthSession({
      id: "user_123",
      email: "user@example.com",
    });

    const payload = verifySessionToken(session.access_token);
    expect(payload.sub).toBe("user_123");
    expect(payload.email).toBe("user@example.com");
    expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});
