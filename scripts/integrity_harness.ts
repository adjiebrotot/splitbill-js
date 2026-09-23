/**
 * integrity_harness.ts: random operations against real Postgres through
 * actions.ts (the same entry point every medium uses), with the books checked
 * after EVERY step. Modeled on finance-tracker scripts/accounting_integrity_harness.ts.
 *
 *   DATABASE_URL=postgresql://sb@127.0.0.1:55433/splitbill_test?sslmode=disable DB_DRIVER=pg \
 *     npx tsx scripts/integrity_harness.ts [--steps 400] [--seed 1]
 *
 * RESETS the database schema, so it refuses a DATABASE_URL without "test".
 *
 * Checks (LIVE = the engine's view through actions.ts; REPLAY = an
 * independent re-computation below, written without the engine):
 *   I1  bill-currency shares sum to the bill total (live and replay agree)
 *   I2  settlement shares sum to the converted total
 *   I3  balances sum to zero; replay balances equal live balances
 *   I4  settled: each balance equals its unpaid transfers
 *   I6  settled: the round's snapshot equals a fresh recompute of its bills
 *   R   a refused operation leaves the revision untouched
 *   DB  Postgres itself holds items + adjustments = total for every bill
 */
process.env.DB_DRIVER = process.env.DB_DRIVER || "pg";
process.env.SETUP_SECRET = process.env.SETUP_SECRET || "harness-secret";
process.env.RESEND_API_KEY = "";

import * as A from "../src/services/actions";
import * as U from "../src/services/user_service";
import { closePool, executeScript, fetchall, fetchone } from "../src/db";
import { runMigrations } from "../src/services/migrate";
import type { GroupView } from "../src/services/ledger";

const args = process.argv.slice(2);
const arg = (k: string, d: number) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const STEPS = arg("--steps", 400);
const SEED = arg("--seed", 1);

let s = SEED >>> 0;
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)];

let checks = 0;
const failures: string[] = [];
const tally: Record<string, [number, number]> = {};
const codes: Record<string, number> = {};
function count(op: string, ok: boolean) {
  tally[op] ??= [0, 0];
  tally[op][ok ? 0 : 1] += 1;
}
function check(label: string, cond: boolean, detail = "") {
  checks += 1;
  if (!cond) failures.push(`${label} ${detail}`);
}

// ── independent replay (no engine import) ──
function gcd(a: bigint, b: bigint): bigint { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; }
function floorDiv(n: bigint, d: bigint) { const q = n / d; return n % d !== 0n && n < 0n ? q - 1n : q; }
function roundHalfEven(n: bigint, d: bigint) {
  const q = floorDiv(n, d), r = n - q * d;
  return 2n * r < d ? q : 2n * r > d ? q + 1n : q % 2n === 0n ? q : q + 1n;
}

/** Split `total` by weights (exact), payer-first leftover, else fraction holders by position. */
function splitByWeights(total: bigint, weights: Map<string, bigint>, payer: string, payerIn: boolean, pos: Map<string, number>) {
  let W = 0n;
  for (const w of weights.values()) W += w;
  const out = new Map<string, bigint>();
  let sum = 0n;
  const frac: string[] = [];
  for (const [m, w] of weights) {
    const x = (total * w) / W;
    out.set(m, x);
    sum += x;
    if ((total * w) % W !== 0n) frac.push(m);
  }
  let left = total - sum;
  if (payerIn) out.set(payer, (out.get(payer) ?? 0n) + left);
  else {
    frac.sort((a, b) => pos.get(a)! - pos.get(b)! || (a < b ? -1 : 1));
    for (const m of frac) { if (left === 0n) break; out.set(m, out.get(m)! + 1n); left -= 1n; }
  }
  return out;
}

function replay(v: GroupView) {
  const pos = new Map(v.members.map((m) => [m.id, m.position]));
  const net = new Map(v.members.map((m) => [m.id, 0n]));
  for (const b of v.bills) {
    const T = BigInt(b.total);
    const weights = new Map<string, bigint>();
    if (b.mode === "items") {
      let L = 1n;
      for (const i of b.items) if (BigInt(i.amount) > 0n) { const k = BigInt(i.members.length); L = L / gcd(L, k) * k; }
      for (const i of b.items) {
        const a = BigInt(i.amount);
        if (a === 0n) continue;
        for (const m of i.members) weights.set(m, (weights.get(m) ?? 0n) + a * (L / BigInt(i.members.length)));
      }
    } else if (b.mode === "even") for (const p of b.participants) weights.set(p.member, 1n);
    else for (const p of b.participants) weights.set(p.member, BigInt(p.bp!));
    const payerIn = weights.has(b.payer);
    const x = splitByWeights(T, weights, b.payer, payerIn, pos);
    // conversion from the rounded shares
    let C = T;
    if (b.currency !== v.group.currency) {
      const rates = v.rates.filter((r) => r.currency === b.currency && (r.effective === "-infinity" || r.effective <= b.date))
        .sort((a, c) => (a.effective === "-infinity" ? -1 : c.effective === "-infinity" ? 1 : a.effective < c.effective ? -1 : 1));
      const r = rates[rates.length - 1];
      const [ip, fp = ""] = r.rate.split(".");
      let num = BigInt(ip + fp), den = 10n ** BigInt(fp.length);
      if (r.inverted) [num, den] = [den, num];
      C = roundHalfEven(T * num * 10n ** BigInt(v.group.dp), den * 10n ** BigInt(b.dp));
    }
    const xw = new Map([...x].filter(([, a]) => a > 0n));
    const c = C === T ? x : splitByWeights(C, xw, b.payer, payerIn, pos);
    let sx = 0n, sc = 0n;
    for (const a of x.values()) sx += a;
    for (const a of c.values()) sc += a;
    check("I1-replay", sx === T, `bill ${b.id}`);
    check("I2-replay", sc === C, `bill ${b.id}`);
    check("live=replay C", String(b.converted) === String(C), `bill ${b.id} live ${b.converted} replay ${C}`);
    for (const [m, a] of c) {
      const live = b.shares[m] ? String(b.shares[m][1]) : "0";
      check("live=replay share", live === String(a), `bill ${b.id} member ${m} live ${live} replay ${a}`);
      net.set(m, net.get(m)! - a);
    }
    net.set(b.payer, net.get(b.payer)! + C);
  }
  for (const p of v.payments) {
    const cv = BigInt(String(p.converted));
    net.set(p.from, net.get(p.from)! + cv);
    net.set(p.to, net.get(p.to)! - cv);
  }
  let total = 0n;
  for (const b of v.balances) {
    total += BigInt(b.net);
    check("I3 live=replay balance", String(b.net) === String(net.get(b.id)), `member ${b.id}`);
  }
  check("I3 sum zero", total === 0n);
  if (v.group.status === "settled") {
    const pend = new Map<string, bigint>();
    for (const t of v.transfers) if (t.status === "pending") {
      pend.set(t.from, (pend.get(t.from) ?? 0n) - BigInt(t.amount));
      pend.set(t.to, (pend.get(t.to) ?? 0n) + BigInt(t.amount));
    }
    for (const b of v.balances) check("I4", BigInt(b.net) === (pend.get(b.id) ?? 0n), `member ${b.id}`);
  }
}

async function snapshotCheck(v: GroupView) {
  if (v.group.status !== "settled") return;
  const r = await fetchone("SELECT snapshot FROM settlement_rounds WHERE group_id = $1 AND round = $2", [v.group.group_id, v.group.round]);
  const snap = (typeof r![0] === "string" ? JSON.parse(r![0] as string) : r![0]) as { bills: { id: string; converted: string }[] };
  const live = new Map(v.bills.map((b) => [b.id, String(b.converted)]));
  check("I6 snapshot bills", snap.bills.length === v.bills.length);
  for (const b of snap.bills) check("I6 snapshot C", live.get(b.id) === String(b.converted), `bill ${b.id}`);
}

async function dbCheck() {
  const bad = await fetchall(`
    SELECT b.bill_id FROM bills b
     WHERE b.mode = 'items' AND b.total_minor <>
       (SELECT COALESCE(SUM(amount_minor), 0) FROM bill_items i WHERE i.bill_id = b.bill_id)
     + (SELECT COALESCE(SUM(amount_minor), 0) FROM bill_adjustments a WHERE a.bill_id = b.bill_id)`);
  check("DB items+adj=total", bad.length === 0, JSON.stringify(bad));
}

// ── random operations ──
const users: { name: string; id: string }[] = [];
const groups: string[] = [];
const CCYS = ["IDR", "USD", "JPY", "SGD"];

function randomBill(v: GroupView, valid: boolean) {
  const active = v.members.filter((m) => m.active);
  const ids = active.map((m) => m.id);
  const dp = ({ IDR: 0, USD: 2, JPY: 0, SGD: 2 } as Record<string, number>);
  // Mostly currencies the group can convert; now and then one it cannot.
  const rated = [...new Set(v.rates.map((r) => r.currency))];
  const currency = v.group.kind === "travel" && rnd() < 0.5
    ? (rated.length && rnd() < 0.85 ? pick(rated) : pick(CCYS))
    : v.group.currency;
  const mode = pick(["items", "even", "percent"] as const);
  const amt = () => String(int(1, dp[currency] === 0 ? 900000 : 90000));
  const sub = (k: number) => [...ids].sort(() => rnd() - 0.5).slice(0, Math.max(1, Math.min(k, ids.length)));
  const base = { description: "b" + int(1, 999), date: "2026-09-" + String(int(1, 20)).padStart(2, "0"), currency, mode, payer: pick(ids) } as Record<string, unknown>;
  if (mode === "items") {
    base.items = Array.from({ length: int(1, 5) }, () => ({ name: "i", amount: amt(), members: sub(int(1, 4)) }));
    if (rnd() < 0.5) base.adjustments = [{ kind: "tax", amount: String(int(1, 5000)) }];
    if (rnd() < 0.2) base.adjustments = [...((base.adjustments as unknown[]) ?? []), { kind: "discount", amount: "-" + int(1, 3) }];
  } else {
    base.total = amt();
    const who = sub(int(1, ids.length));
    if (mode === "even") base.participants = who.map((m) => ({ member: m }));
    else {
      let left = 10000;
      base.participants = who.map((m, i) => {
        const bp = i === who.length - 1 ? left : int(1, left - (who.length - 1 - i));
        left -= bp;
        return { member: m, bp };
      });
    }
  }
  if (!valid) {
    const breakers = [
      () => { base.mode = "percent"; base.total = "100"; base.participants = [{ member: ids[0], bp: 9999 }]; },
      () => { base.mode = "items"; base.items = [{ name: "x", amount: "100", members: [] }]; },
      () => { base.date = "2099-01-01"; },
      () => { base.payer = "999999999"; },
      () => { base.mode = "even"; base.total = "0"; base.participants = [{ member: ids[0] }]; },
      () => { base.mode = "items"; base.items = [{ name: "x", amount: "100", members: [ids[0]] }]; base.stated_total = "101"; },
    ];
    pick(breakers)();
  }
  return base;
}

async function step(n: number) {
  const u = pick(users);
  const op = rnd();
  if (!groups.length || op < 0.05) {
    const r = await A.run(() => A.createGroup({ user_id: u.id, kind: rnd() < 0.7 ? "travel" : "one_off", name: "g" + n, currency: pick(CCYS), members: ["D" + n] }));
    if (r.ok) groups.push(r.data.group_id);
    return;
  }
  const gid = pick(groups);
  const owner = (await fetchone("SELECT owner_user_id::text FROM groups WHERE group_id = $1", [gid]))![0] as string;
  const actor = rnd() < 0.7 ? owner : u.id;
  let v: GroupView;
  try {
    v = await A.getGroupView({ user_id: owner, group_id: gid });
  } catch {
    return;
  }
  const before = v.group.revision;
  const invalid = rnd() < 0.15;
  let r: { ok: boolean; code?: string } = { ok: true };
  let opName = "noop";
  // A settled group mostly gets reopened, so bills keep flowing.
  const x = v.group.status === "settled" && rnd() < 0.35 ? 0.9 : rnd();
  if (x < 0.35) {
    opName = "bill_create"; r = await A.run(() => A.saveBill({ user_id: actor, group_id: gid, ...randomBill(v, !invalid), client_key: "k" + n }));
  } else if (x < 0.42 && v.bills.length) {
    const b = pick(v.bills);
    opName = "bill_edit"; r = await A.run(() => A.saveBill({ user_id: actor, group_id: gid, bill_id: b.id, version: b.version, ...randomBill(v, !invalid) }));
  } else if (x < 0.46 && v.bills.length) {
    opName = "bill_delete"; r = await A.run(() => A.deleteBill({ user_id: actor, group_id: gid, bill_id: pick(v.bills).id }));
  } else if (x < 0.56) {
    const ids = v.members.filter((m) => m.active).map((m) => m.id);
    if (ids.length > 1) { opName = "payment"; r = await A.run(() => A.recordPayment({ user_id: owner, group_id: gid, from: ids[0], to: ids[1], amount: String(int(1, 50000)), currency: v.group.currency })); }
  } else if (x < 0.62 && v.group.kind === "travel") {
    const c = pick(CCYS.filter((c) => c !== v.group.currency));
    opName = "rate_set"; r = await A.run(() => A.setRate({ user_id: owner, group_id: gid, currency: c, effective: rnd() < 0.5 ? "-infinity" : "2026-09-" + String(int(1, 20)).padStart(2, "0"), rate: String(int(1, 20000)) + (rnd() < 0.5 ? ".25" : ""), inverted: rnd() < 0.3 }));
  } else if (x < 0.65 && v.rates.length) {
    const rr = pick(v.rates);
    opName = "rate_delete"; r = await A.run(() => A.deleteRate({ user_id: owner, group_id: gid, currency: rr.currency, effective: rr.effective }));
  } else if (x < 0.73) {
    opName = "settle"; r = await A.run(() => A.settleGroup({ user_id: actor, group_id: gid, expected_revision: invalid ? "0" : v.group.revision }));
  } else if (x < 0.85 && v.group.status === "settled") {
    const t = v.transfers.find((t) => t.status === "pending");
    if (t) { opName = "paid"; r = await A.run(() => A.markTransferPaid({ user_id: owner, group_id: gid, transfer_id: t.id })); }
  } else if (x < 0.88 && v.group.status === "settled") {
    const t = v.transfers.find((t) => t.status === "paid");
    if (t) { opName = "unpaid"; r = await A.run(() => A.unmarkTransferPaid({ user_id: owner, group_id: gid, transfer_id: t.id })); }
  } else if (x < 0.94) {
    opName = "reopen"; r = await A.run(() => A.reopenGroup({ user_id: actor, group_id: gid }));
  } else if (x < 0.97) {
    opName = "member_add"; r = await A.run(() => A.addMember({ user_id: owner, group_id: gid, name: "M" + n }));
  } else {
    const m = v.members.filter((m) => m.user_id !== owner);
    if (m.length) { opName = "member_remove"; r = await A.run(() => A.removeMember({ user_id: owner, group_id: gid, member_id: pick(m).id })); }
  }
  count(opName, r.ok);
  if (!r.ok) codes[r.code ?? "?"] = (codes[r.code ?? "?"] ?? 0) + 1;
  const after = await A.getGroupView({ user_id: owner, group_id: gid });
  if (!r.ok) check("R refused op leaves revision", after.group.revision === before, `op ${n} code ${r.code}`);
  replay(after);
  await snapshotCheck(after);
}

async function concurrency() {
  // A settle racing ten bill saves: whatever order the lock gives, the books hold.
  const owner = users[0].id;
  const g = await A.createGroup({ user_id: owner, kind: "travel", name: "race", currency: "USD", members: ["X", "Y"] });
  const v = await A.getGroupView({ user_id: owner, group_id: g.group_id });
  const ids = v.members.map((m) => m.id);
  const saves = Array.from({ length: 10 }, (_, i) => A.run(() => A.saveBill({
    user_id: owner, group_id: g.group_id, description: "r" + i, date: "2026-09-01", mode: "even", payer: ids[i % 3], total: String(100 + i),
    participants: ids.map((m) => ({ member: m })), client_key: "race" + i,
  })));
  const settle = A.run(() => A.settleGroup({ user_id: owner, group_id: g.group_id, expected_revision: v.group.revision }));
  const results = await Promise.all([...saves, settle]);
  const after = await A.getGroupView({ user_id: owner, group_id: g.group_id });
  replay(after);
  await snapshotCheck(after);
  const saved = results.slice(0, 10).filter((r) => r.ok).length;
  check("race: saved bills all present", after.bills.length === saved, `saved ${saved} present ${after.bills.length}`);
  // Double-tap: same client key twice at once, one bill.
  const [a, b] = await Promise.all([0, 1].map(() => A.run(() => A.saveBill({
    user_id: owner, group_id: g.group_id, description: "dup", date: "2026-09-01", mode: "even", payer: ids[0], total: "100",
    participants: [{ member: ids[1] }], client_key: "dup-key",
  }))));
  const again = await A.getGroupView({ user_id: owner, group_id: g.group_id });
  if (again.group.status === "open") check("double tap: one bill", again.bills.filter((x) => x.description === "dup").length === 1, JSON.stringify([a, b]));
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!/test/.test(url)) throw new Error("refusing to reset a DATABASE_URL without 'test' in it");
  await executeScript("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await runMigrations();
  for (const n of ["ali", "bob", "cal", "dan"]) {
    const me = await U.register({ username: n, display_name: n, email: `${n}@h.test`, password: "harness-pw!" });
    users.push({ name: n, id: me.user_id });
  }
  const t0 = Date.now();
  for (let i = 0; i < STEPS; i++) {
    await step(i);
    if (i % 25 === 0) {
      // Let every user join every trip now and then, so non-owners act too.
      for (const gid of groups) {
        const code = (await fetchone("SELECT invite_code FROM groups WHERE group_id = $1", [gid]))?.[0];
        if (code) for (const u of users) await A.run(() => A.joinByInvite({ user_id: u.id, code }));
      }
    }
  }
  await concurrency();
  await dbCheck();
  const ops = await fetchone("SELECT COUNT(*) FROM group_events");
  console.log(`steps ${STEPS} seed ${SEED} groups ${groups.length} events ${ops![0]} checks ${checks} failures ${failures.length} (${Date.now() - t0} ms)`);
  console.log("ops [ok, refused]: " + JSON.stringify(tally));
  console.log("refusal codes: " + JSON.stringify(codes));
  const foreign = await fetchone("SELECT COUNT(*) FROM bills b JOIN groups g USING (group_id) WHERE b.currency <> g.currency AND b.deleted_at IS NULL");
  const rounds = await fetchone("SELECT COUNT(*) FROM settlement_rounds");
  console.log(`live foreign-currency bills ${foreign![0]}, settlement rounds ${rounds![0]}`);
  for (const f of failures.slice(0, 30)) console.log("  FAIL", f);
  await closePool();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await closePool();
  process.exit(1);
});
