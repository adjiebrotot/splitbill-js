/**
 * migrations/index.ts — every schema migration, applied in filename order by
 * services/migrate.ts. Add a file, add a line; never edit an applied one.
 */
import m001 from "./001_initial";
import m002 from "./002_guard_audit_nulls";

export const MIGRATIONS: Record<string, string> = {
  "001_initial": m001,
  "002_guard_audit_nulls": m002,
};
