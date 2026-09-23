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
