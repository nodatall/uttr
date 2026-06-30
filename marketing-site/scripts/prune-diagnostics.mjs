import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";

export function buildPruneQuery({ dryRun = false } = {}) {
  if (dryRun) {
    return {
      text: `select count(*)::integer as count
               from public.diagnostic_events
              where received_at < now() - interval '7 days'`,
      action: "count",
    };
  }

  return {
    text: `delete from public.diagnostic_events
            where received_at < now() - interval '7 days'`,
    action: "delete",
  };
}

function readPoolMax() {
  const parsed = Number.parseInt(process.env.DATABASE_POOL_MAX || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export async function runPrune({ dryRun = false } = {}) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to prune diagnostics.");
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: readPoolMax(),
  });

  try {
    const query = buildPruneQuery({ dryRun });
    const result = await pool.query(query.text);
    const count =
      query.action === "count"
        ? Number(result.rows[0]?.count || 0)
        : Number(result.rowCount || 0);

    console.log(
      JSON.stringify({
        event: "diagnostics_prune",
        action: query.action,
        rows: count,
      }),
    );

    return count;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrune({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    console.error(
      JSON.stringify({
        event: "diagnostics_prune_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    process.exitCode = 1;
  });
}
