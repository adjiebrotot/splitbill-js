/**
 * Every migration must be idempotent: clicking "Apply" twice, or running it
 * over a schema whose schema_migrations rows went missing, is a no-op. This
 * is the static half (no DB needed); db_migrate.test.ts re-runs each file
 * against Postgres.
 */
import { describe, it, expect } from "vitest";
import { MIGRATIONS } from "@/migrations";

/** Top-level SQL only: function bodies ($$ ... $$) are not DDL. */
function outsideBodies(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
}

const RULES: Array<[RegExp, string]> = [
  [/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/gi, "CREATE TABLE needs IF NOT EXISTS"],
  [/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/gi, "CREATE INDEX needs IF NOT EXISTS"],
  [/\bCREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS\b)/gi, "CREATE SEQUENCE needs IF NOT EXISTS"],
  [/\bCREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS\b)/gi, "CREATE SCHEMA needs IF NOT EXISTS"],
  [/\bCREATE\s+(?:FUNCTION|PROCEDURE|VIEW)\b/gi, "use CREATE OR REPLACE"],
  [/\bCREATE\s+TRIGGER\b/gi, "use CREATE OR REPLACE TRIGGER"],
  [/\bCREATE\s+TYPE\b/gi, "CREATE TYPE has no IF NOT EXISTS; wrap it in a DO block that checks pg_type"],
  [/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/gi, "ADD COLUMN needs IF NOT EXISTS"],
  [/\bADD\s+CONSTRAINT\b/gi, "ADD CONSTRAINT has no IF NOT EXISTS; wrap it in a DO block that checks pg_constraint"],
  [/\bDROP\s+(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|SEQUENCE|TYPE|SCHEMA|COLUMN|CONSTRAINT)\s+(?!IF\s+EXISTS\b)/gi, "DROP needs IF EXISTS"],
  [/\bRENAME\b/gi, "RENAME fails on a second run; wrap it in a DO block that checks the old name"],
];

describe("migrations are idempotent", () => {
  for (const [name, sql] of Object.entries(MIGRATIONS)) {
    it(name, () => {
      const top = outsideBodies(sql);
      const problems: string[] = [];
      for (const [re, why] of RULES) {
        for (const m of top.matchAll(re)) problems.push(`${why}: "${top.slice(m.index!, m.index! + 60).split("\n")[0]}"`);
      }
      // Postgres has no OR REPLACE for constraint triggers: drop, then create.
      for (const m of top.matchAll(/\bCREATE\s+CONSTRAINT\s+TRIGGER\s+(\w+)[\s\S]*?\bON\s+(\w+)/gi)) {
        const drop = new RegExp(`DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${m[1]}\\s+ON\\s+${m[2]}\\s*;`, "i");
        if (!drop.test(top.slice(0, m.index))) problems.push(`constraint trigger ${m[1]} needs DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]} first`);
      }
      expect(problems).toEqual([]);
    });
  }
});
