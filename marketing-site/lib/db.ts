import pg from "pg";
import { readEnv, readOptionalEnv } from "@/lib/env";

const { Pool, types } = pg;

// Keep timestamptz/date values as ISO-like strings so existing API row types stay stable.
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

export type DbQueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

export type DbExecutor = {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<T>>;
};

let pool: pg.Pool | null = null;
let testExecutor: DbExecutor | null = null;

function readPoolMax() {
  const rawValue = readOptionalEnv("DATABASE_POOL_MAX");
  if (!rawValue) {
    return 5;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function getDb(): DbExecutor {
  if (testExecutor) {
    return testExecutor;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: readEnv("DATABASE_URL"),
      max: readPoolMax(),
    });
  }

  return pool;
}

export async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  values: readonly unknown[] = [],
) {
  return getDb().query<T>(sql, values);
}

export async function dbTransaction<T>(
  callback: (client: DbExecutor) => Promise<T>,
) {
  if (testExecutor) {
    return callback(testExecutor);
  }

  const client = await (getDb() as pg.Pool).connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function setDbExecutorForTests(executor: DbExecutor | null) {
  testExecutor = executor;
}
