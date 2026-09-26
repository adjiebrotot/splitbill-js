/**
 * migrations/index.ts — every schema migration, applied in filename order by
 * services/migrate.ts. Add a file, add a line; never edit an applied one.
 * Every file must be idempotent (IF NOT EXISTS / OR REPLACE / DO blocks):
 * tests/unit/migrations.test.ts and db_migrate.test.ts enforce it.
 */
import m001 from "./001_initial";
import m002 from "./002_guard_audit_nulls";
import m003 from "./003_rates_big_side_first";
import m004 from "./004_member_ref_indexes";
import m005 from "./005_summaries_fx_market";
import m006 from "./006_user_avatars";

export const MIGRATIONS: Record<string, string> = {
  "001_initial": m001,
  "002_guard_audit_nulls": m002,
  "003_rates_big_side_first": m003,
  "004_member_ref_indexes": m004,
  "005_summaries_fx_market": m005,
  "006_user_avatars": m006,
};
