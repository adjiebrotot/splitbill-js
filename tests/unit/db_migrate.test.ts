/**
 * services/migrate.ts against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
 * Re-running is always safe: twice in a row, concurrently, over a schema whose
 * bookkeeping rows are gone, and each file's SQL run again on its own. A
 * same-named table from another app is refused, and a failure names the file.
 */
import { schemaUrl, resetSchema } from "../helpers/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.TEST_DATABASE_URL;
if (URL) {
  process.env.DATABASE_URL = schemaUrl(URL, "t_migrate");
  process.env.DB_DRIVER = "pg";
}

describe.skipIf(!URL)("migrations against Postgres", () => {
  let db: typeof import("@/db");
  let M: typeof import("@/services/migrate");
  let MIGRATIONS: Record<string, string>;
  const names = () => Object.keys(MIGRATIONS).sort();

  async function schemaFingerprint(): Promise<string> {
    const rows = await db.fetchall(
      `SELECT 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '')
         FROM information_schema.columns WHERE table_schema = current_schema()
       UNION ALL SELECT 'idx ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = current_schema()
       UNION ALL SELECT 'trg ' || tgname || ' ' || pg_get_triggerdef(t.oid) FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
       UNION ALL SELECT 'fn ' || p.proname || ' ' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p
         WHERE p.pronamespace = current_schema()::regnamespace
       UNION ALL SELECT 'con ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
         WHERE connamespace = current_schema()::regnamespace
       ORDER BY 1`,
    );
    return rows.map((r) => String(r[0])).join("\n");
  }

  beforeAll(async () => {
    db = await import("@/db");
    await resetSchema("t_migrate");
    M = await import("@/services/migrate");
    MIGRATIONS = (await import("@/migrations")).MIGRATIONS;
  });

  afterAll(async () => {
    await db.closePool();
  });

  it("a second run applies nothing", async () => {
    expect(await M.runMigrations()).toEqual([]);
    expect((await M.migrationStatus()).every((m) => m.applied_at)).toBe(true);
  });

  it("each file run again leaves the schema unchanged", async () => {
    const before = await schemaFingerprint();
    for (const n of names()) await db.executeScript(MIGRATIONS[n]);
    expect(await schemaFingerprint()).toBe(before);
  });

  it("adopts an existing schema whose bookkeeping rows are gone", async () => {
    const before = await schemaFingerprint();
    await db.execute("DELETE FROM schema_migrations");
    expect(await M.runMigrations()).toEqual(names());
    expect(await schemaFingerprint()).toBe(before);
  });

  it("concurrent runs apply each file once, without error", async () => {
    await db.execute("DELETE FROM schema_migrations");
    const runs = await Promise.all([M.runMigrations(), M.runMigrations(), M.runMigrations()]);
    expect(runs.flat().sort()).toEqual(names());
    const rows = await db.fetchall("SELECT filename FROM schema_migrations ORDER BY 1");
    expect(rows.map((r) => r[0])).toEqual(names());
  });

  it("refuses a same-named table from another app and names the file", async () => {
    await db.executeScript("DROP SCHEMA IF EXISTS t_migrate CASCADE; CREATE SCHEMA t_migrate; CREATE TABLE users (id BIGSERIAL PRIMARY KEY, name TEXT);");
    const e = await M.runMigrations().then(() => null, (x) => x);
    expect(e).toBeInstanceOf(M.MigrationError);
    expect(e.migration).toBe("001_initial");
    expect(e.message).toMatch(/users exists but is not the Split Bill table/);
    // Nothing of 001 was kept: no bookkeeping row, no groups table.
    expect(await db.fetchall("SELECT filename FROM schema_migrations")).toEqual([]);
    expect((await db.fetchone("SELECT to_regclass('groups') IS NULL"))![0]).toBe(true);
  });
});
