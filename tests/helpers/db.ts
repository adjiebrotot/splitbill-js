/**
 * Each DB test file gets its own schema in TEST_DATABASE_URL, so files can run
 * in parallel without dropping each other's tables.
 */
export function schemaUrl(base: string, schema: string): string {
  const u = new URL(base);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

export async function resetSchema(schema: string): Promise<void> {
  const db = await import("@/db");
  await db.executeScript(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
  const { runMigrations } = await import("@/services/migrate");
  await runMigrations();
}
