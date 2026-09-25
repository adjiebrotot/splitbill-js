/**
 * actions.ts against a real Postgres. Skipped unless TEST_DATABASE_URL is set:
 *
 *   TEST_DATABASE_URL=postgresql://sb@127.0.0.1:55433/splitbill_test?sslmode=disable npx vitest run tests/unit/db_actions.test.ts
 *
 * The schema is dropped and re-migrated at the start of the run.
 */
import { schemaUrl, resetSchema } from "../helpers/db";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const URL = process.env.TEST_DATABASE_URL;
if (URL) {
  process.env.DATABASE_URL = schemaUrl(URL, "t_actions");
  process.env.DB_DRIVER = "pg";
  process.env.SETUP_SECRET = process.env.SETUP_SECRET || "test-secret";
}

describe.skipIf(!URL)("actions against Postgres", () => {
  let A: typeof import("@/services/actions");
  let U: typeof import("@/services/user_service");
  let db: typeof import("@/db");
  const uid: Record<string, string> = {};

  async function user(name: string) {
    const me = await U.register({ username: name, display_name: name[0].toUpperCase() + name.slice(1), email: `${name}@x.test`, password: "secret-pw!" });
    uid[name] = me.user_id;
    return me.user_id;
  }

  async function view(gid: string, who = "ali") {
    return A.getGroupView({ user_id: uid[who], group_id: gid });
  }

  const memberId = (v: Awaited<ReturnType<typeof view>>, name: string) => v.members.find((m) => m.name === name)!.id;
  const netOf = (v: Awaited<ReturnType<typeof view>>, name: string) => v.balances.find((b) => b.id === memberId(v, name))!.net;

  // No real network: the market-rate provider is "down" unless a test says otherwise.
  const offline = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

  beforeAll(async () => {
    offline();
    db = await import("@/db");
    await resetSchema("t_actions");
    A = await import("@/services/actions");
    U = await import("@/services/user_service");
    for (const n of ["ali", "bob", "cal"]) await user(n);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db?.closePool();
  });

  it("login works by username and email, and refuses a wrong password", async () => {
    expect((await U.login("ali", "secret-pw!")).username).toBe("ali");
    expect((await U.login("ALI@x.test", "secret-pw!")).username).toBe("ali");
    await expect(U.login("ali", "nope")).rejects.toMatchObject({ code: "login_failed" });
    await expect(U.register({ username: "Ali", display_name: "x", email: "z@x.test", password: "secret-pw!" })).rejects.toMatchObject({ code: "username_taken" });
  });

  it("one-off: items split, settle, pay, all zero", async () => {
    const g = await A.createGroup({ user_id: uid.ali, kind: "one_off", name: "Dinner", currency: "USD", members: [{ name: "Don" }, { username: "bob" }] });
    let v = await view(g.group_id);
    const [ali, don, bob] = ["Ali", "Don", "Bob"].map((n) => memberId(v, n));
    const saved = await A.run(() => A.saveBill({
      user_id: uid.ali, group_id: g.group_id, description: "Dinner", date: "2026-09-01", currency: "USD", mode: "items", payer: don,
      items: [{ name: "Ice cream", amount: "1000", members: [ali] }, { name: "Meal", amount: "1500", members: [ali, bob, don] }],
    }));
    expect(saved.ok).toBe(true);
    v = await view(g.group_id);
    expect(netOf(v, "Ali")).toBe(-1500n);
    expect(netOf(v, "Bob")).toBe(-500n);
    expect(netOf(v, "Don")).toBe(2000n);

    // Settling against a stale revision is refused.
    const stale = await A.run(() => A.settleGroup({ user_id: uid.ali, group_id: g.group_id, expected_revision: "1" }));
    expect(stale).toMatchObject({ ok: false, code: "stale_revision" });

    const s = await A.run(() => A.settleGroup({ user_id: uid.ali, group_id: g.group_id, expected_revision: v.group.revision }));
    expect(s.ok).toBe(true);
    v = await view(g.group_id);
    expect(v.group.status).toBe("settled");
    expect(v.transfers.map((t) => `${t.from}>${t.to}:${t.amount}:${t.status}`).sort()).toEqual([`${ali}>${don}:1500:pending`, `${bob}>${don}:500:pending`].sort());

    // Locked: no bill edits while settled.
    const locked = await A.run(() => A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "x", date: "2026-09-01", mode: "even", payer: ali, total: "100", participants: [{ member: bob }] }));
    expect(locked).toMatchObject({ ok: false, code: "group_settled" });

    // Bob (payer of his own debt, receiver is a dummy) may mark his transfer paid.
    const tBob = v.transfers.find((t) => t.from === bob)!;
    expect((await A.run(() => A.markTransferPaid({ user_id: uid.bob, group_id: g.group_id, transfer_id: tBob.id }))).ok).toBe(true);
    // Marking twice is a no-op.
    expect(await A.run(() => A.markTransferPaid({ user_id: uid.bob, group_id: g.group_id, transfer_id: tBob.id }))).toMatchObject({ ok: true, data: { already: true } });
    const tAli = v.transfers.find((t) => t.from === ali)!;
    await A.markTransferPaid({ user_id: uid.ali, group_id: g.group_id, transfer_id: tAli.id });
    v = await view(g.group_id);
    expect(v.balances.every((b) => b.net === 0n)).toBe(true);

    // Unmark restores the debt; reopen keeps paid transfers as payments.
    await A.unmarkTransferPaid({ user_id: uid.ali, group_id: g.group_id, transfer_id: tAli.id });
    expect(netOf(await view(g.group_id), "Ali")).toBe(-1500n);
    await A.reopenGroup({ user_id: uid.ali, group_id: g.group_id });
    v = await view(g.group_id);
    expect(v.group.status).toBe("open");
    expect(netOf(v, "Bob")).toBe(0n);
    expect(netOf(v, "Ali")).toBe(-1500n);
  });

  it("travel: invite, even and percent splits, payments, permissions", async () => {
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Bali", currency: "IDR" });
    let v = await view(g.group_id);
    const code = v.group.invite_code!;
    expect((await A.peekInvite({ user_id: uid.bob, code })).name).toBe("Bali");
    await A.joinByInvite({ user_id: uid.bob, code });
    await A.joinByInvite({ user_id: uid.cal, code });
    expect((await A.joinByInvite({ user_id: uid.cal, code })).already).toBe(true);
    v = await view(g.group_id);
    const [ali, bob, cal] = ["Ali", "Bob", "Cal"].map((n) => memberId(v, n));

    // Lunch 60,000 even over three, paid by Ali.
    await A.saveBill({ user_id: uid.bob, group_id: g.group_id, description: "Lunch", date: "2026-09-02", mode: "even", payer: ali, total: "60000",
      participants: [{ member: ali }, { member: bob }, { member: cal }], client_key: "k1" });
    // Double tap: same client key, no second bill.
    const dup = await A.saveBill({ user_id: uid.bob, group_id: g.group_id, description: "Lunch", date: "2026-09-02", mode: "even", payer: ali, total: "60000",
      participants: [{ member: ali }, { member: bob }, { member: cal }], client_key: "k1" });
    expect(dup.duplicate).toBe(true);
    // Percent 50/25/25.
    await A.saveBill({ user_id: uid.cal, group_id: g.group_id, description: "Dinner", date: "2026-09-02", mode: "percent", payer: ali, total: "60000",
      participants: [{ member: ali, bp: 5000 }, { member: bob, bp: 2500 }, { member: cal, bp: 2500 }] });
    v = await view(g.group_id);
    expect(v.bills).toHaveLength(2);
    expect(netOf(v, "Ali")).toBe(70000n);
    expect(netOf(v, "Bob")).toBe(-35000n);

    // Cal cannot edit Bob's bill; Bob can; stale version refused.
    const lunch = v.bills.find((b) => b.description === "Lunch")!;
    const body = { group_id: g.group_id, bill_id: lunch.id, version: lunch.version, description: "Lunch", date: "2026-09-02", mode: "even", payer: ali, total: "90000",
      participants: [{ member: ali }, { member: bob }, { member: cal }] };
    expect(await A.run(() => A.saveBill({ user_id: uid.cal, ...body }))).toMatchObject({ ok: false, code: "bill_edit_forbidden" });
    expect((await A.run(() => A.saveBill({ user_id: uid.bob, ...body }))).ok).toBe(true);
    expect(await A.run(() => A.saveBill({ user_id: uid.bob, ...body }))).toMatchObject({ ok: false, code: "stale_version" });

    // Mid-trip cash: Bob pays Ali 10,000. Only Ali (receiver) or the owner may record it.
    expect(await A.run(() => A.recordPayment({ user_id: uid.bob, group_id: g.group_id, from: bob, to: ali, amount: "10000" }))).toMatchObject({ ok: false, code: "payment_forbidden" });
    await A.recordPayment({ user_id: uid.ali, group_id: g.group_id, from: bob, to: ali, amount: "10000" });
    v = await view(g.group_id);
    expect(netOf(v, "Bob")).toBe(-45000n + 10000n);
    expect(v.balances.reduce((s, b) => s + b.net, 0n)).toBe(0n);

    // Only the owner settles.
    expect(await A.run(() => A.settleGroup({ user_id: uid.bob, group_id: g.group_id, expected_revision: v.group.revision }))).toMatchObject({ ok: false, code: "owner_only" });
  });

  it("refuses bad bills, and Postgres refuses them even without the app", async () => {
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Checks", currency: "USD" });
    const v = await view(g.group_id);
    const ali = memberId(v, "Ali");
    const bad = [
      [{ mode: "items", items: [{ name: "x", amount: "100", members: [] }] }, "item_unassigned"],
      [{ mode: "percent", total: "100", participants: [{ member: ali, bp: 9999 }] }, "percent_sum"],
      [{ mode: "even", total: "0", participants: [{ member: ali }] }, "amount_zero"],
      [{ mode: "items", items: [{ name: "x", amount: "100", members: [ali] }], stated_total: "150" }, "stated_total_mismatch"],
      [{ mode: "even", total: "100", participants: [{ member: "999999" }] }, "member_unknown"],
      [{ mode: "even", total: "100", participants: [{ member: ali }], date: "2099-01-01" }, "date_future"],
      [{ mode: "even", total: "100", participants: [{ member: ali }], currency: "JPY" }, "rate_missing"],
    ] as const;
    for (const [extra, code] of bad) {
      const r = await A.run(() => A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "x", date: "2026-09-01", payer: ali, ...extra } as never));
      expect(r, code).toMatchObject({ ok: false, code });
    }
    // Direct SQL that does not add up is rejected at COMMIT by the deferred trigger.
    await expect(db.withConn(async (cur) => {
      await cur.execute(
        `INSERT INTO bills (group_id, description, bill_date, currency, minor_units, mode, total_minor, payer_member_id)
         VALUES ($1, 'raw', '2026-09-01', 'USD', 2, 'items', 500, $2) RETURNING bill_id`, [g.group_id, ali]);
      const billId = cur.fetchone()![0];
      await cur.execute("INSERT INTO bill_items (group_id, bill_id, position, name, amount_minor) VALUES ($1, $2, 1, 'x', 400) RETURNING item_id", [g.group_id, billId]);
      const itemId = cur.fetchone()![0];
      await cur.execute("INSERT INTO bill_item_members (group_id, item_id, member_id) VALUES ($1, $2, $3)", [g.group_id, itemId, ali]);
    })).rejects.toMatchObject({ hint: "bill_unbalanced" });
  });

  it("members: deactivate with history, delete without, link a dummy", async () => {
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Links", currency: "USD", members: ["Grandma", "Temp"] });
    let v = await view(g.group_id);
    const [ali, grandma, temp] = ["Ali", "Grandma", "Temp"].map((n) => memberId(v, n));
    // Grandma pays dinner (a dummy can be the payer).
    await A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "Dinner", date: "2026-09-01", mode: "even", payer: grandma, total: "3000", participants: [{ member: ali }, { member: grandma }] });
    expect((await A.removeMember({ user_id: uid.ali, group_id: g.group_id, member_id: temp })).removed).toBe(true);
    // Bob joins, owner links Grandma's history to Bob.
    await A.joinByInvite({ user_id: uid.bob, code: v.group.invite_code! });
    v = await view(g.group_id);
    const bobRow = memberId(v, "Bob");
    await A.linkMember({ user_id: uid.ali, group_id: g.group_id, member_id: grandma, target_member_id: bobRow });
    v = await view(g.group_id, "bob");
    expect(v.me).toBe(grandma);
    expect(netOf(v, "Grandma")).toBe(1500n);
    // Owner cannot be removed; a member with history is only deactivated.
    expect(await A.run(() => A.removeMember({ user_id: uid.ali, group_id: g.group_id, member_id: ali }))).toMatchObject({ ok: false, code: "owner_cannot_leave" });
    expect((await A.removeMember({ user_id: uid.ali, group_id: g.group_id, member_id: grandma })).deactivated).toBe(true);
    expect(await A.run(() => A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "x", date: "2026-09-01", mode: "even", payer: grandma, total: "100", participants: [{ member: ali }] })))
      .toMatchObject({ ok: false, code: "member_inactive_pick" });
  });

  it("rates: coverage, dated rates, locked while settled, currency change", async () => {
    // The market-rate provider is down (beforeAll): nothing is filled in automatically.
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Japan", currency: "IDR", members: ["Bob"] });
    let v = await view(g.group_id);
    const [ali, bob] = ["Ali", "Bob"].map((n) => memberId(v, n));
    const bill = { user_id: uid.ali, group_id: g.group_id, description: "Ramen", date: "2026-09-05", currency: "JPY", mode: "even", payer: ali, total: "3000",
      participants: [{ member: ali }, { member: bob }] };
    expect(await A.run(() => A.saveBill(bill))).toMatchObject({ ok: false, code: "rate_missing" });
    // A rate for the settlement currency itself is refused.
    expect(await A.run(() => A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "IDR", effective: "-infinity", rate: "1" }))).toMatchObject({ ok: false, code: "rate_not_allowed" });
    await A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "JPY", effective: "-infinity", rate: "108.5" });
    await A.saveBill(bill);
    v = await view(g.group_id);
    expect(v.bills[0].converted).toBe(325500n);
    expect(netOf(v, "Bob")).toBe(-162750n);
    // Only the owner sets rates.
    await A.joinByInvite({ user_id: uid.cal, code: v.group.invite_code! });
    expect(await A.run(() => A.setRate({ user_id: uid.cal, group_id: g.group_id, currency: "JPY", effective: "2026-09-05", rate: "110" }))).toMatchObject({ ok: false, code: "owner_only" });
    // A dated rate takes over from its date.
    await A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "JPY", effective: "2026-09-05", rate: "110" });
    v = await view(g.group_id);
    expect(v.bills[0].converted).toBe(330000n);
    // Deleting the from-start rate is fine (the dated one covers the bill); deleting both is not.
    await A.deleteRate({ user_id: uid.ali, group_id: g.group_id, currency: "JPY", effective: "-infinity" });
    expect(await A.run(() => A.deleteRate({ user_id: uid.ali, group_id: g.group_id, currency: "JPY", effective: "2026-09-05" }))).toMatchObject({ ok: false, code: "rate_needed" });
    // Moving the only rate after the bill date would orphan it.
    expect(await A.run(() => A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "JPY", effective: "2026-09-06", rate: "110", replace: { currency: "JPY", effective: "2026-09-05" } })))
      .toMatchObject({ ok: false, code: "rate_needed" });
    // Settled: rates locked.
    v = await view(g.group_id);
    await A.settleGroup({ user_id: uid.ali, group_id: g.group_id, expected_revision: v.group.revision });
    expect(await A.run(() => A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "USD", effective: "-infinity", rate: "16000" }))).toMatchObject({ ok: false, code: "group_settled" });
    await A.reopenGroup({ user_id: uid.ali, group_id: g.group_id });
    // Change the settlement currency to JPY: the IDR-free group needs no rate at all.
    expect(await A.run(() => A.changeCurrency({ user_id: uid.ali, group_id: g.group_id, currency: "USD", rates: [] }))).toMatchObject({ ok: false, code: "rate_missing" });
    await A.changeCurrency({ user_id: uid.ali, group_id: g.group_id, currency: "JPY", rates: [] });
    v = await view(g.group_id);
    expect(v.group.currency).toBe("JPY");
    expect(v.bills[0].converted).toBe(3000n);
    expect(v.balances.reduce((a, b) => a + b.net, 0n)).toBe(0n);
  });

  it("rates: a missing one is fetched on save, from the start, by any member", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(url);
      const base = /base=([A-Z]{3})/.exec(url)![1];
      const rates: Record<string, Record<string, number>> = { JPY: { IDR: 108.5 }, USD: { IDR: 16250 } };
      return { json: async () => ({ success: true, rates: rates[base] ?? {} }) } as Response;
    }));
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Osaka", currency: "IDR", members: [] });
    let v = await view(g.group_id);
    await A.joinByInvite({ user_id: uid.bob, code: v.group.invite_code! });
    v = await view(g.group_id);
    const [ali, bob] = ["Ali", "Bob"].map((n) => memberId(v, n));
    await A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "Ramen", date: "2026-09-05", currency: "JPY", mode: "even", payer: ali, total: "3000",
      participants: [{ member: ali }, { member: bob }] });
    v = await view(g.group_id);
    expect(v.rates).toMatchObject([{ currency: "JPY", effective: "-infinity", rate: "108.5", inverted: false, source: "auto" }]);
    expect(v.bills[0].converted).toBe(325500n);
    expect(asked[0]).toContain("historical?date=2026-09-05");
    // A covered currency asks nobody; a member who is not the owner still gets a rate.
    const n = asked.length;
    await A.saveBill({ user_id: uid.bob, group_id: g.group_id, description: "Tea", date: "2026-09-01", currency: "JPY", mode: "even", payer: bob, total: "500",
      participants: [{ member: bob }] });
    expect(asked.length).toBe(n);
    await A.recordPayment({ user_id: uid.bob, group_id: g.group_id, from: ali, to: bob, currency: "USD", amount: "100", date: "2026-09-06" });
    v = await view(g.group_id);
    expect(v.rates.map((r) => r.currency).sort()).toEqual(["JPY", "USD"]);
    expect(v.complete).toBe(true);
    expect(v.balances.reduce((a, b) => a + b.net, 0n)).toBe(0n);
    // Moving a rate to a dated one leaves no gap, so fillRates has nothing to add.
    await A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "USD", effective: "2026-09-06", rate: "16000" });
    await A.deleteRate({ user_id: uid.ali, group_id: g.group_id, currency: "USD", effective: "-infinity" });
    expect(await A.fillRates({ user_id: uid.bob, group_id: g.group_id })).toEqual({ added: 0 });
    offline();
  });

  it("one-off: named after its bill; one left empty is cleaned up", async () => {
    const g = await A.createGroup({ user_id: uid.ali, kind: "one_off", name: "New bill", currency: "IDR", members: [] });
    let v = await view(g.group_id);
    const ali = memberId(v, "Ali");
    const m = await A.addMember({ user_id: uid.ali, group_id: g.group_id, name: "Zed" });
    await A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "Sate Padang", date: "2026-09-05", currency: "IDR", mode: "even", payer: ali, total: "50000",
      participants: [{ member: ali }, { member: m.member_id }] });
    v = await view(g.group_id);
    expect(v.group.name).toBe("Sate Padang");

    const empty = await A.createGroup({ user_id: uid.ali, kind: "one_off", name: "New bill", currency: "IDR", members: [] });
    await db.execute("UPDATE groups SET created_at = NOW() - INTERVAL '2 days' WHERE group_id = ANY($1)", [[empty.group_id, g.group_id]]);
    expect((await A.cleanup()).empty_one_offs).toBe(1);
    const mine = (await A.listMyGroups({ user_id: uid.ali })).map((x) => x.group_id);
    expect(mine).toContain(g.group_id);
    expect(mine).not.toContain(empty.group_id);
  });
});
