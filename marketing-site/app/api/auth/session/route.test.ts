import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAuthSession } from "@/lib/auth/server";
import { setDbExecutorForTests } from "@/lib/db";
import { GET } from "./route";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  UTTR_SESSION_SECRET: process.env.UTTR_SESSION_SECRET,
};
const user = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  email: "user@uttr.test",
};

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.UTTR_SESSION_SECRET =
    "f09a68419a8a4c388a176be7687e91d1f09a68419a8a4c388a176be7687e91d1";
});
afterEach(() => {
  setDbExecutorForTests(null);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function signedRequest() {
  const session = await createAuthSession(user);
  return new Request("https://uttr.test/api/auth/session", {
    headers: { cookie: `uttr_session=${encodeURIComponent(session.token)}` },
  });
}

describe("/api/auth/session", () => {
  test("keeps missing or invalid tokens unauthorized without reading the database", async () => {
    setDbExecutorForTests({
      query: async () => {
        throw new Error("database must not be called");
      },
    });
    expect(
      (await GET(new Request("https://uttr.test/api/auth/session"))).status,
    ).toBe(401);
    expect(
      (
        await GET(
          new Request("https://uttr.test/api/auth/session", {
            headers: { cookie: "uttr_session=invalid" },
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("returns a temporary failure for a valid session during a database outage", async () => {
    const request = await signedRequest();
    setDbExecutorForTests({
      query: async () => {
        throw new Error("PRIVATE_DATABASE_FAILURE_DETAILS");
      },
    });
    const response = await GET(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "Unable to check your session.",
    });
  });

  test("keeps a deleted user's valid token unauthorized", async () => {
    setDbExecutorForTests({ query: async () => ({ rows: [], rowCount: 0 }) });
    expect((await GET(await signedRequest())).status).toBe(401);
  });

  test("refreshes a valid session from the current user record", async () => {
    setDbExecutorForTests({
      query: async <T>() => ({ rows: [user] as T[], rowCount: 1 }),
    });
    const response = await GET(await signedRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).session.user).toEqual(user);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  test("configuration failures cannot masquerade as an invalid session", async () => {
    const request = await signedRequest();
    delete process.env.UTTR_SESSION_SECRET;
    expect((await GET(request)).status).toBe(503);
  });
});
