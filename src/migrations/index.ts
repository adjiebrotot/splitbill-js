/**
 * migrations/index.ts — every schema migration, applied in filename order by
 * services/migrate.ts. Add a file, add a line; never edit an applied one.
 */
import m001 from "./001_initial";

export const MIGRATIONS: Record<string, string> = {
  "001_initial": m001,
};
