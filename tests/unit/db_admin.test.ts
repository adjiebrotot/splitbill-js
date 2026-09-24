/**
 * admin_actions.ts against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
 * Covers the user lifecycle, masking in the DB viewer, and account delete:
 * ownership handover, the refusal when nobody can take over, and a delete
 * that nulls audit columns inside a SETTLED split (migration 002).
 */
import { schemaUrl, resetSchema } from "../helpers/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.TEST_DATABASE_URL;
if (URL) {
  process.env.DATABASE_URL = schemaUrl(URL, "t_admin");
  process.env.DB_DRIVER = "pg";
  process.env.SETUP_SECRET = process.env.SETUP_SECRET || "test-secret";
  process.env.TELEGRAM_BOT_TOKEN = "";
}

describe.skipIf(!URL)("admin actions against Postgres", () => {
  let A: typeof import("@/services/actions");
  let AA: typeof import("@/services/admin_actions");
  let U: typeof import("@/services/user_service");
  let db: typeof import("@/db");
  const uid: Record<string, string> = {};

  async function user(name: string) {
    const me = await U.register({ username: name, display_name: name[0].toUpperCase() + name.slice(1), email: `${name}@x.test`, password: "secret-pw!" });
    uid[name] = me.user_id;
    return me.user_id;
  }

  beforeAll(async () => {
    db = await import("@/db");
    await resetSchema("t_admin");
    A = await import("@/services/actions");
    AA = await import("@/services/admin_actions");
    U = await import("@/services/user_service");
    for (const n of ["ali", "bob", "cal", "dee"]) await user(n);
  });

  afterAll(async () => {
    await db?.closePool();
  });

  it("migrations are all applied", async () => {
    const s = await AA.systemStatus();
    expect(s.migrations.length).toBeGreaterThanOrEqual(2);
    expect(s.migrations.every((m) => m.applied_at)).toBe(true);
    expect((await AA.applyMigrations()).applied).toEqual([]);
    expect(s.env.find((e) => e.name === "DATABASE_URL")?.set).toBe(true);
  });

  it("creates, lists, edits and resets a user", async () => {
    const c = await AA.createUser({ username: "eve_admin", display_name: "Eve", email: "EVE@x.test", email_verified: true });
    expect(c.user).toMatchObject({ username: "eve_admin", email: "eve@x.test", email_verified: true, has_password: true });
    expect(c.password).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await U.login("eve_admin", c.password!)).username).toBe("eve_admin");

    await expect(AA.createUser({ username: "eve_admin" })).rejects.toMatchObject({ code: "username_taken" });
    await expect(AA.createUser({ username: "x!" })).rejects.toMatchObject({ code: "username_invalid" });
    await expect(AA.createUser({ username: "weak_one", password: "short" })).rejects.toMatchObject({ code: "password_short" });

    const found = await AA.listUsers({ q: "eve" });
    expect(found.users.map((u) => u.username)).toEqual(["eve_admin"]);
    expect((await AA.listUsers({ q: "%" })).total).toBe(0);

    const upd = await AA.updateUser({ user_id: c.user.user_id, display_name: "Eve A", language: "id", default_currency: "usd", timezone: "Asia/Tokyo", email: "", email_verified: true });
    expect(upd).toMatchObject({ display_name: "Eve A", language: "id", default_currency: "USD", timezone: "Asia/Tokyo", email: null, email_verified: false });
    await expect(AA.updateUser({ user_id: c.user.user_id, email: "ali@x.test" })).rejects.toMatchObject({ code: "email_taken" });
    await expect(AA.updateUser({ user_id: c.user.user_id, timezone: "Mars/Base" })).rejects.toMatchObject({ code: "timezone_invalid" });

    const r = await AA.resetPassword({ user_id: c.user.user_id });
    expect(r.telegram).toBe("not_linked");
    expect((await U.login("eve_admin", r.password)).username).toBe("eve_admin");
    await expect(U.login("eve_admin", c.password!)).rejects.toMatchObject({ code: "login_failed" });
  });

  it("unlinks Telegram", async () => {
    await db.execute("UPDATE users SET telegram_id = 777, telegram_group = 'x' WHERE user_id = $1", [uid.dee]);
    const u = await AA.unlinkTelegram({ user_id: uid.dee });
    expect(u.telegram_id).toBeNull();
  });

  it("DB viewer lists tables, pages rows and masks secrets", async () => {
    const tables = await AA.dbTables();
    expect(tables[0]).toMatchObject({ table: "users" });
    expect(tables.find((t) => t.table === "schema_migrations")?.rows).toBeGreaterThanOrEqual(2);
    const rows = await AA.dbRows({ table: "users", per_page: 25 });
    const pw = rows.columns.indexOf("password");
    expect(rows.pk).toEqual(["user_id"]);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expect(r[pw]).toBe(AA.MASK);
    await expect(AA.dbRows({ table: "users; DROP TABLE users" })).rejects.toMatchObject({ code: "not_found" });
    const g = await A.createGroup({ user_id: uid.dee, kind: "travel", name: "Viewer", currency: "IDR" });
    const grows = await AA.dbRows({ table: "groups" });
    const ic = grows.columns.indexOf("invite_code");
    expect(grows.rows.find((r) => r[0] === g.group_id)![ic]).toBe(AA.MASK);
  });

  it("delete hands owned splits over, even settled ones, and books stay equal", async () => {
    // Ali owns a one-off with Bob, adds a bill, settles it. Ali also set nothing else.
    const g = await A.createGroup({ user_id: uid.ali, kind: "one_off", name: "Lunch", currency: "USD", members: [{ username: "bob" }, { name: "Zed" }] });
    let v = await A.getGroupView({ user_id: uid.ali, group_id: g.group_id });
    const id = (n: string) => v.members.find((m) => m.name === n)!.id;
    await A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "Food", date: "2026-09-01", mode: "even", payer: id("Ali"), total: "3000", participants: [{ member: id("Ali") }, { member: id("Bob") }, { member: id("Zed") }] });
    v = await A.getGroupView({ user_id: uid.ali, group_id: g.group_id });
    await A.settleGroup({ user_id: uid.ali, group_id: g.group_id, expected_revision: v.group.revision });
    const before = (await A.getGroupView({ user_id: uid.bob, group_id: g.group_id })).balances.map((b) => `${b.id}:${b.net}`);

    const info = await AA.getUser({ user_id: uid.ali });
    const plan = info.handover.find((h) => h.group_id === g.group_id)!;
    expect(plan.to?.user_id).toBe(uid.bob);

    await expect(AA.deleteUser({ user_id: uid.ali, confirm: "wrong" })).rejects.toMatchObject({ code: "admin_confirm_mismatch" });
    const r = await AA.deleteUser({ user_id: uid.ali, confirm: "ALI" });
    expect(r.deleted).toBe("ali");

    const after = await A.getGroupView({ user_id: uid.bob, group_id: g.group_id });
    expect(after.group.status).toBe("settled");
    expect(after.balances.map((b) => `${b.id}:${b.net}`)).toEqual(before);
    expect(after.members.find((m) => m.name === "Ali")?.user_id ?? null).toBeNull();
    const owner = await db.fetchone("SELECT owner_user_id::text FROM groups WHERE group_id = $1", [g.group_id]);
    expect(String(owner![0])).toBe(uid.bob);
    const ev = await db.fetchone("SELECT action FROM group_events WHERE group_id = $1 ORDER BY event_id DESC LIMIT 1", [g.group_id]);
    expect(ev![0]).toBe("admin_transfer_owner");
    expect((await AA.integrityCheck()).problems).toEqual([]);
  });

  it("the settled guard still refuses a real change", async () => {
    const g = await db.fetchone("SELECT b.bill_id FROM bills b JOIN groups g ON g.group_id = b.group_id WHERE g.status = 'settled' LIMIT 1");
    await expect(db.execute("UPDATE bills SET description = 'x' WHERE bill_id = $1", [g![0]])).rejects.toMatchObject({ hint: "group_settled" });
    await expect(db.execute("UPDATE bills SET created_by = $2 WHERE bill_id = $1", [g![0], uid.bob])).rejects.toMatchObject({ hint: "group_settled" });
  });

  it("delete is refused when nobody can take over a split", async () => {
    const g = await A.createGroup({ user_id: uid.cal, kind: "one_off", name: "Solo", currency: "IDR", members: [{ name: "Friend" }] });
    await expect(AA.deleteUser({ user_id: uid.cal, confirm: "cal" })).rejects.toMatchObject({ code: "admin_delete_blocked", params: { groups: "Solo" } });
    expect((await AA.getUser({ user_id: uid.cal })).user.username).toBe("cal");
    const owner = await db.fetchone("SELECT owner_user_id::text FROM groups WHERE group_id = $1", [g.group_id]);
    expect(String(owner![0])).toBe(uid.cal);
  });
});
