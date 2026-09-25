/**
 * services/migrate.ts — apply pending schema migrations, in filename order.
 *
 * Each file runs in its own transaction together with its bookkeeping row, so
 * a failed migration leaves nothing half-applied. Adapted from finance-tracker
 * `runMigrations()` without the finance backfills.
 */
import { executeScript, fetchall, withConn } from "../db";
import { MIGRATIONS } from "../migrations";

/** Postgres's message plus its SQLSTATE, or the thrown value as text. */
function describe(e: unknown): string {
  const x = e as { message?: unknown; code?: unknown } | null;
  const msg = typeof x?.message === "string" && x.message ? x.message : String(e);
  return typeof x?.code === "string" && /^[0-9A-Z]{5}$/.test(x.code) ? `${msg} [${x.code}]` : msg;
}

/**
 * Raised when one step fails; the runner stops there, nothing of it kept.
 * `migration` is the file name, or BOOKKEEPING when the schema_migrations
 * table itself could not be created or read.
 */
export class MigrationError extends Error {
  readonly detail: string;
  constructor(readonly migration: string, readonly cause: unknown) {
    const detail = describe(cause);
    super(`migration ${migration} failed: ${detail}`);
    this.name = "MigrationError";
    this.detail = detail;
  }
}

export const BOOKKEEPING = "schema_migrations";

/** Any fixed key: serialises runners, so two clicks at once never race. */
const LOCK_KEY = 7_311_742_001;

/**
 * Safe to call any number of times, also concurrently. Each migration runs
 * under a transaction-scoped advisory lock and re-checks its bookkeeping row
 * inside that lock, so a second runner waits and then skips it. The files
 * themselves are idempotent too (tests/unit/migrations.test.ts), so a schema
 * that exists without its bookkeeping rows is adopted rather than refused.
 */
export async function runMigrations(): Promise<string[]> {
  let done: Set<string>;
  try {
    await executeScript(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    done = new Set((await fetchall("SELECT filename FROM schema_migrations")).map((r) => String(r[0])));
  } catch (e) {
    throw new MigrationError(BOOKKEEPING, e);
  }
  const applied: string[] = [];
  for (const name of Object.keys(MIGRATIONS).sort()) {
    if (done.has(name)) continue;
    try {
      const ran = await withConn(async (cur) => {
        await cur.execute("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
        await cur.execute("SELECT 1 FROM schema_migrations WHERE filename = $1", [name]);
        if (cur.fetchone()) return false;
        await executeScript(MIGRATIONS[name]);
        await cur.execute("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
        return true;
      });
      if (ran) applied.push(name);
    } catch (e) {
      throw new MigrationError(name, e);
    }
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
