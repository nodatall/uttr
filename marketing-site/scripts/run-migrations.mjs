import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const migrationsDir = path.join(process.cwd(), "db", "migrations");
const databaseUrl = process.env.DATABASE_URL;
const migrationLockId = 14200420;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations.");
}

const client = new pg.Client({ connectionString: databaseUrl });

await client.connect();

try {
  await client.query("set lock_timeout = '10s'");
  await client.query("set statement_timeout = '5min'");
  await client.query("select pg_advisory_lock($1)", [migrationLockId]);

  await client.query(`
    create table if not exists public.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const alreadyApplied = await client.query(
      "select 1 from public.schema_migrations where version = $1",
      [version],
    );

    if (alreadyApplied.rowCount) {
      console.log(`migration ${version} already applied`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into public.schema_migrations (version) values ($1)",
        [version],
      );
      await client.query("commit");
      console.log(`migration ${version} applied`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  try {
    await client.query("select pg_advisory_unlock($1)", [migrationLockId]);
  } catch {}
  await client.end();
}
