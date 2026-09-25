/**
 * migrations/index.ts — every schema migration, applied in filename order by
 * services/migrate.ts. Add a file, add a line; never edit an applied one.
 * Every file must be idempotent (IF NOT EXISTS / OR REPLACE / DO blocks):
 * tests/unit/migrations.test.ts and db_migrate.test.ts enforce it.
 */
import m001 from "./001_initial";
import m002 from "./002_guard_audit_nulls";
import m003 from "./003_rates_big_side_first";

export const MIGRATIONS: Record<string, string> = {
  "001_initial": m001,
  "002_guard_audit_nulls": m002,
  "003_rates_big_side_first": m003,
};
