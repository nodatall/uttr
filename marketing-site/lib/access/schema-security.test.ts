import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(import.meta.dir, "..", "..", "db", "migrations");

describe("Postgres access schema", () => {
  test("uses regular Postgres tables without hosted auth/RLS dependencies", () => {
    const migration = readFileSync(
      join(migrationsDir, "20260420000000_postgres_billing_access_schema.sql"),
      "utf8",
    );

    expect(migration).toContain("password_hash text not null");
    expect(migration).not.toContain("auth.users");
    expect(migration).not.toContain("service_role");
    expect(migration).not.toContain("enable row level security");
  });
});
