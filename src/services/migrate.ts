/**
 * services/migrate.ts — apply pending schema migrations, in filename order.
 *
 * Each file runs in its own transaction together with its bookkeeping row, so
 * a failed migration leaves nothing half-applied. Adapted from finance-tracker
 * `runMigrations()` without the finance backfills.
 */
import { executeScript, fetchall, withConn } from "../db";
import { MIGRATIONS } from "../migrations";

export async function runMigrations(): Promise<string[]> {
  await executeScript(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  );
  const done = new Set((await fetchall("SELECT filename FROM schema_migrations")).map((r) => String(r[0])));
  const applied: string[] = [];
  for (const name of Object.keys(MIGRATIONS).sort()) {
    if (done.has(name)) continue;
    await withConn(async (cur) => {
      await executeScript(MIGRATIONS[name]);
      await cur.execute("INSERT INTO schema_migrations (filename) VALUES ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}

/** Every known migration and when it was applied (null = pending). */
export async function migrationStatus(): Promise<Array<{ name: string; applied_at: string | null }>> {
  const exists = await fetchall("SELECT to_regclass('schema_migrations') IS NOT NULL");
  const applied = new Map<string, string>();
  if (exists[0]?.[0] === true || exists[0]?.[0] === "t") {
    for (const r of await fetchall("SELECT filename, applied_at FROM schema_migrations")) {
      applied.set(String(r[0]), new Date(r[1] as string).toISOString());
    }
  }
  return Object.keys(MIGRATIONS).sort().map((name) => ({ name, applied_at: applied.get(name) ?? null }));
}
