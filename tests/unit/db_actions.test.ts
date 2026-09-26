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
    // A one-off is final once its bill is saved.
    expect(v.stage).toBe("final");

    // Settling against a stale revision is refused.
    const stale = await A.run(() => A.settleGroup({ user_id: uid.ali, group_id: g.group_id, expected_revision: "1" }));
    expect(stale).toMatchObject({ ok: false, code: "stale_revision" });

    const s = await A.run(() => A.settleGroup({ user_id: uid.ali, group_id: g.group_id, expected_revision: v.group.revision }));
    expect(s.ok).toBe(true);
    v = await view(g.group_id);
    expect(v.group.status).toBe("settled");
    expect(v.stage).toBe("final");
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
    expect(v.stage).toBe("settled");

    // Unmark restores the debt; reopen keeps paid transfers as payments.
    await A.unmarkTransferPaid({ user_id: uid.ali, group_id: g.group_id, transfer_id: tAli.id });
    expect(netOf(await view(g.group_id), "Ali")).toBe(-1500n);
    expect((await view(g.group_id)).stage).toBe("final");
    await A.reopenGroup({ user_id: uid.ali, group_id: g.group_id });
    v = await view(g.group_id);
    expect(v.group.status).toBe("open");
    expect(netOf(v, "Bob")).toBe(0n);
    expect(netOf(v, "Ali")).toBe(-1500n);
  });

  it("stage: every medium agrees (view, My splits, report, file name)", async () => {
    const agree = async (gid: string, stage: string, status: RegExp, suffix: string) => {
      expect((await view(gid)).stage).toBe(stage);
      expect((await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === gid)!.stage).toBe(stage);
      const r = await A.getReport({ user_id: uid.ali, group_id: gid, type: "group", lang: "en" });
      if (r.kind !== "text") throw new Error("expected text");
      expect(r.doc.stage).toBe(stage);
      expect(r.doc.status).toMatch(status);
      expect(r.doc.stamp).toBe(stage === "open" ? "NOT FINAL" : stage === "final" ? "NOT SETTLED" : "");
      expect(r.filename).toMatch(new RegExp(`-group${suffix}\\.txt$`));
    };

    // One-off, paid off with Mark Paid (a plain payment, no Settle step): the reported bug.
    const one = await A.createGroup({ user_id: uid.ali, kind: "one_off", name: "Berghotel", currency: "CHF", members: [{ name: "Dwiki" }] });
    let v = await view(one.group_id);
    const [ali, dwiki] = ["Ali", "Dwiki"].map((n) => memberId(v, n));
    await agree(one.group_id, "open", /^NOT FINAL · as of/, "-not-final");
    await A.saveBill({ user_id: uid.ali, group_id: one.group_id, description: "Lunch", date: "2026-09-20", mode: "even", payer: ali, total: "5450",
      participants: [{ member: ali }, { member: dwiki }] });
    await agree(one.group_id, "final", /^FINAL · NOT SETTLED · as of/, "-not-settled");
    await A.recordPayment({ user_id: uid.ali, group_id: one.group_id, from: dwiki, to: ali, amount: "2725", date: "2026-09-20" });
    await agree(one.group_id, "settled", /^SETTLED 20 Sept 2026$/, "");

    // Trip: open, Finalise, pay off, reopen.
    const trip = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Alps", currency: "CHF", members: [{ name: "Eko" }] });
    v = await view(trip.group_id);
    const [a2, eko] = ["Ali", "Eko"].map((n) => memberId(v, n));
    await A.saveBill({ user_id: uid.ali, group_id: trip.group_id, description: "Train", date: "2026-09-20", mode: "even", payer: a2, total: "10000",
      participants: [{ member: a2 }, { member: eko }] });
    await agree(trip.group_id, "open", /^NOT FINAL/, "-not-final");
    await A.settleGroup({ user_id: uid.ali, group_id: trip.group_id, expected_revision: (await view(trip.group_id)).group.revision });
    await agree(trip.group_id, "final", /^FINAL · NOT SETTLED · 0\/1 paid$/, "-not-settled");
    const tr = (await view(trip.group_id)).transfers[0];
    await A.markTransferPaid({ user_id: uid.ali, group_id: trip.group_id, transfer_id: tr.id });
    await agree(trip.group_id, "settled", /^SETTLED /, "");
    await A.reopenGroup({ user_id: uid.ali, group_id: trip.group_id });
    await agree(trip.group_id, "open", /^NOT FINAL/, "-not-final");
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
    // A rate under 1 is stored big side first: 1 JPY = 108.1081081 IDR, not 1 IDR = 0.00925 JPY.
    await A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "IDR", effective: "-infinity", rate: "0.00925" });
    v = await view(g.group_id);
    expect(v.rates.find((r) => r.currency === "IDR")).toMatchObject({ rate: "108.1081081", inverted: true });
  });

  it("rates: old small-side-first rows are flipped by 003, and by reopen when settled", async () => {
    offline();
    const { MIGRATIONS } = await import("@/migrations");
    const mk = async (name: string) => {
      const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name, currency: "AUD", members: ["Bob"] });
      await A.setRate({ user_id: uid.ali, group_id: g.group_id, currency: "IDR", effective: "-infinity", rate: "12655.79121", inverted: true });
      const v = await view(g.group_id);
      const [ali, bob] = ["Ali", "Bob"].map((n) => memberId(v, n));
      await A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "Nasi", date: "2026-09-05", currency: "IDR", mode: "even", payer: ali,
        total: "1000000", participants: [{ member: ali }, { member: bob }] });
      // As saved before bigSideRate: 1 IDR = 0.00007901521 AUD.
      await db.execute("UPDATE fx_rates SET rate = 0.00007901521, inverted = FALSE WHERE group_id = $1", [g.group_id]);
      return g.group_id;
    };
    const open = await mk("Bali open");
    const settled = await mk("Bali settled");
    let v = await view(settled);
    await A.settleGroup({ user_id: uid.ali, group_id: settled, expected_revision: v.group.revision });
    const rev = Number((await view(open)).group.revision);
    await db.executeScript(MIGRATIONS["003_rates_big_side_first"]);
    await db.executeScript(MIGRATIONS["003_rates_big_side_first"]);
    v = await view(open);
    expect(v.rates[0]).toMatchObject({ rate: "12655.79121", inverted: true });
    expect(Number(v.group.revision)).toBe(rev + 1);
    expect(v.balances.reduce((a, b) => a + b.net, 0n)).toBe(0n);
    // Settled books stay locked until reopened.
    expect((await view(settled)).rates[0]).toMatchObject({ rate: "0.00007901521", inverted: false });
    await A.reopenGroup({ user_id: uid.ali, group_id: settled });
    expect((await view(settled)).rates[0]).toMatchObject({ rate: "12655.79121", inverted: true });
  });

  it("rates: a missing one is fetched on save, from the start, by any member", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(url);
      const base = /base=([A-Z]{3})/.exec(url)![1];
      const rates: Record<string, Record<string, number>> = { JPY: { IDR: 108.5 }, USD: { IDR: 16250 } };
      return { json: async () => ({ success: true, rates: rates[base] ?? {} }) } as Response;
    }));
    // The provider is back: earlier tests saw it down, and a failure is remembered for 5 minutes.
    (await import("@/fx_providers"))._resetFxCache();
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
  it("cache: a warm read is never stale, and a write's view equals a fresh read", async () => {
    const R = await import("@/services/repo");
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Cache", currency: "USD", members: [{ username: "bob" }, { name: "Dan" }] });
    let v = await view(g.group_id);
    const [ali, bob, dan] = ["Ali", "Bob", "Dan"].map((n) => memberId(v, n));

    // A bill with several lines, members and an adjustment: the batched INSERTs keep every row and its order.
    const w = await A.withView(uid.ali, () => A.saveBill({
      user_id: uid.ali, group_id: g.group_id, description: "Market", date: "2026-09-01", currency: "USD", mode: "items", payer: bob,
      items: [{ name: "Fish", qty: "2", amount: "1200", members: [ali, bob] }, { name: "Rice", amount: "300", members: [dan] }, { name: "Free", amount: "0", members: [] }],
      adjustments: [{ kind: "tax", amount: "150" }, { kind: "discount", amount: "-50" }],
    }));
    expect(w.view).not.toBeNull();
    v = await view(g.group_id);
    expect(JSON.parse(JSON.stringify(w.view, (_k, x) => (typeof x === "bigint" ? x.toString() : x))))
      .toEqual(JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))));
    const b = v.bills[0];
    expect(b.items.map((i) => [i.name, i.qty, i.amount, i.members])).toEqual([
      ["Fish", "2.000", "1200", [ali, bob].sort((x, y) => Number(x) - Number(y))], ["Rice", "1.000", "300", [dan]], ["Free", "1.000", "0", []],
    ]);
    expect(b.adjustments).toEqual([{ kind: "tax", amount: "150" }, { kind: "discount", amount: "-50" }]);
    expect(b.total).toBe("1600");

    // The write's log lines land in order, in one INSERT.
    const ev = await db.fetchall("SELECT action, entity FROM group_events WHERE group_id = $1 ORDER BY event_id", [g.group_id]);
    expect(ev.map((r) => `${r[0]} ${r[1]}`)).toEqual(["create group", "create bill"]);

    // Warm: the same state object comes back, and home agrees with it.
    const warm = await R.readGroup(g.group_id);
    expect(await R.readGroup(g.group_id)).toBe(warm);
    const home = (await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === g.group_id)!;
    expect(home.bills).toBe(1);

    // Any write shows at once (revision is part of the key).
    await A.recordPayment({ user_id: uid.ali, group_id: g.group_id, from: dan, to: bob, amount: "100", date: "2026-09-01" });
    expect((await view(g.group_id)).payments).toHaveLength(1);
    expect((await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === g.group_id)!.last_at).not.toBe(home.last_at);

    // A linked account's username lives outside the group: part of the key too.
    await db.execute("UPDATE users SET username = 'bobby' WHERE user_id = $1", [uid.bob]);
    try {
      expect((await view(g.group_id)).members.find((m) => m.id === bob)!.username).toBe("bobby");
    } finally {
      await db.execute("UPDATE users SET username = 'bob' WHERE user_id = $1", [uid.bob]);
    }
    expect((await view(g.group_id)).members.find((m) => m.id === bob)!.username).toBe("bob");

    // A refused write leaves nothing behind: the cache still matches the database.
    const before = await view(g.group_id);
    expect(await A.run(() => A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "x", date: "2026-09-01", mode: "even", payer: ali, total: "100", participants: [] })))
      .toMatchObject({ ok: false });
    expect((await view(g.group_id)).group.revision).toBe(before.group.revision);

    // Deleted: gone from reads and the home list at once.
    await A.deleteGroup({ user_id: uid.ali, group_id: g.group_id });
    expect(await R.readGroup(g.group_id)).toBeNull();
    expect((await A.listMyGroups({ user_id: uid.ali })).some((x) => x.group_id === g.group_id)).toBe(false);
  });

  it("boot answers the account and the page's data in one request, and writes carry the new view", async () => {
    const { handleApi } = await import("@/webapp/api_routes");
    await import("@/webapp/feature_routes");
    const { sessionValue } = await import("@/webapp/auth");
    const cookie = `sb_session=${sessionValue(uid.ali, "ali", "en")}`;
    const call = (path: string, init: RequestInit = {}) =>
      handleApi(new Request(`https://x.test/app/api/${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } }), path.split("?")[0]);
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Api", currency: "USD", members: [{ name: "Eve" }] });
    const boot = await (await call(`boot?page=group&id=${g.group_id}`)).json();
    expect(boot.ok).toBe(true);
    expect(boot.data.me.user_id).toBe(uid.ali);
    expect(boot.data.group.group.group_id).toBe(g.group_id);
    const [ali, eve] = ["Ali", "Eve"].map((n) => boot.data.group.members.find((m: { name: string }) => m.name === n).id);
    const r = await (await call("payment/record", { method: "POST", body: JSON.stringify({ group_id: g.group_id, from: eve, to: ali, amount: "500", date: "2026-09-01" }) })).json();
    expect(r.ok).toBe(true);
    expect(r.view.payments).toHaveLength(1);
    expect(r.view.group.revision).not.toBe(boot.data.group.group.revision);
    const bad = await (await call("payment/record", { method: "POST", body: JSON.stringify({ group_id: g.group_id, from: eve, to: eve, amount: "1" }) })).json();
    expect(bad).toMatchObject({ ok: false, code: "payment_self" });
    expect(bad.view).toBeUndefined();
  });
  it("home list: rows come from group_summaries, stale ones are recomputed and stored", async () => {
    const g = await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Summary", currency: "USD", members: [{ name: "Fay" }] });
    // New group: no summary yet, so the list computes it and stores it.
    expect((await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === g.group_id)!.bills).toBe(0);
    const stored = await db.fetchone("SELECT revision::text, version FROM group_summaries WHERE group_id = $1", [g.group_id]);
    expect(stored![0]).toBe((await view(g.group_id)).group.revision);

    // A warm write reuses the cached state; a join from elsewhere moves the key, so the next write loads fresh and sees Bob.
    let v = await view(g.group_id);
    await A.joinByInvite({ user_id: uid.bob, code: v.group.invite_code! });
    const bobMember = (await db.fetchone("SELECT member_id::text FROM members WHERE group_id = $1 AND user_id = $2", [g.group_id, uid.bob]))![0] as string;
    const ali = memberId(v, "Ali");
    const w = await A.withView(uid.ali, () => A.saveBill({ user_id: uid.ali, group_id: g.group_id, description: "Taxi", date: "2026-09-01", mode: "even", payer: ali, total: "900",
      participants: [{ member: ali }, { member: bobMember }] }));

    // The write stored the summary in the same transaction, and its row is what the list shows.
    const rev = (await db.fetchone("SELECT revision::text FROM groups WHERE group_id = $1", [g.group_id]))![0];
    expect((await db.fetchone("SELECT revision::text FROM group_summaries WHERE group_id = $1", [g.group_id]))![0]).toBe(rev);
    const row = (await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === g.group_id)!;
    expect(row).toEqual(w.row);
    expect(row).toMatchObject({ bills: 1, spent: 900n, my_share: 450n, my_net: 450n, stage: "open" });
    expect((await A.listMyGroups({ user_id: uid.bob })).find((x) => x.group_id === g.group_id)).toMatchObject({ my_net: -450n, active: true });

    // A summary from another engine or summary version is never trusted.
    await db.execute("UPDATE group_summaries SET version = 'old', data = jsonb_set(data, '{bills}', '99') WHERE group_id = $1", [g.group_id]);
    expect((await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === g.group_id)!.bills).toBe(1);
    // Nor one behind the group's revision.
    await db.execute("UPDATE group_summaries SET revision = revision - 1, data = jsonb_set(data, '{bills}', '99') WHERE group_id = $1", [g.group_id]);
    expect((await A.listMyGroups({ user_id: uid.ali })).find((x) => x.group_id === g.group_id)!.bills).toBe(1);
  });

  it("market rates: one fetch per pair per day, shared through fx_market; a dead provider is asked once", async () => {
    const fx = await import("@/fx_providers");
    fx._resetFxCache();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return { json: async () => ({ success: true, rates: { SGD: 1.35 } }) } as unknown as Response; }));
    expect(await fx.marketRate("EUR", "SGD", "2026-08-01")).toBe(1.35);
    expect(await fx.marketRate("EUR", "SGD", "2026-08-01")).toBe(1.35);
    expect(calls).toBe(1);
    // Another instance (cold memory) reads the shared row, not the provider.
    fx._resetFxCache();
    expect(await fx.marketRate("EUR", "SGD", "2026-08-01")).toBe(1.35);
    expect(calls).toBe(1);
    // Concurrent asks share one fetch.
    await Promise.all([fx.marketRate("EUR", "SGD", null), fx.marketRate("EUR", "SGD", null)]);
    expect(calls).toBe(2);
    // Down: asked once, then not again for a while.
    offline();
    fx._resetFxCache();
    expect(await fx.marketRate("CHF", "SGD", "2026-08-02")).toBeNull();
    const f = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
    const n = f.mock.calls.length;
    expect(await fx.marketRate("CHF", "SGD", "2026-08-02")).toBeNull();
    expect(f.mock.calls.length).toBe(n);
  });
});
