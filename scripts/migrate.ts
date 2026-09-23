/**
 * Apply pending migrations to DATABASE_URL (local dev, CI, harnesses).
 *   DATABASE_URL=... DB_DRIVER=pg npx tsx scripts/migrate.ts
 * In production call POST /app/api/admin/migrate with the SETUP_SECRET.
 */
import { runMigrations } from "../src/services/migrate";
import { closePool } from "../src/db";

async function main() {
  const applied = await runMigrations();
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
