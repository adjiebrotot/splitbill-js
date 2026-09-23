/**
 * Randomized invariants over thousands of generated groups (seeded, so a
 * failure is reproducible from its seed).
 *
 *   I1  sum of bill-currency shares = bill total
 *   I2  sum of settlement shares = converted total = payer credit
 *   I3  sum of all balances = 0
 *   I5  transfers zero every balance, count = n - k (brute force for n <= 9)
 *   I7  reordering input rows changes nothing
 */
import { describe, it, expect } from "vitest";
import { allocate, computeGroup, settle, EXACT_MAX, type BillIn, type GroupIn, type RateIn } from "@/engine";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: R, xs: readonly T[]) => xs[int(r, 0, xs.length - 1)];
function sample<T>(r: R, xs: readonly T[], k: number): T[] {
  const c = [...xs];
  for (let i = c.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.slice(0, k);
}
function shuffle<T>(r: R, xs: readonly T[]): T[] {
  return sample(r, xs, xs.length);
}

const CCY: Array<[string, number]> = [["IDR", 0], ["USD", 2], ["JPY", 0], ["KWD", 3], ["EUR", 2]];

function randomBill(r: R, ids: string[]): BillIn {
  const payer = pick(r, ids);
  const mode = pick(r, ["items", "even", "percent"] as const);
  const big = r() < 0.2;
  const amt = () => BigInt(int(r, 0, big ? 5_000_000 : 20000));
  if (mode === "even") {
    return { payer, mode, total: amt() + 1n, participants: sample(r, ids, int(r, 1, ids.length)).map((member) => ({ member })) };
  }
  if (mode === "percent") {
    const parts = sample(r, ids, int(r, 1, ids.length));
    let left = 10000;
    const out = parts.map((member, i) => {
      const bp = i === parts.length - 1 ? left : int(r, 1, left - (parts.length - 1 - i));
      left -= bp;
      return { member, bp };
    });
    return { payer, mode, total: amt() + 1n, participants: out };
  }
  const items = Array.from({ length: int(r, 1, 8) }, () => {
    const a = r() < 0.1 ? 0n : amt() + 1n;
    return { amount: a, members: a === 0n && r() < 0.5 ? [] : sample(r, ids, int(r, 1, ids.length)) };
  });
  if (!items.some((i) => i.amount > 0n)) items.push({ amount: 1n, members: [ids[0]] });
  const sub = items.reduce((s, i) => s + i.amount, 0n);
  const adjustments = [];
  if (r() < 0.5) adjustments.push({ kind: "tax" as const, amount: sub / 10n + 1n });
  if (r() < 0.3) adjustments.push({ kind: "service" as const, amount: sub / 20n + 1n });
  if (r() < 0.3 && sub > 3n) adjustments.push({ kind: "discount" as const, amount: -(sub / 3n) });
  return { payer, mode, items, adjustments };
}

function randomGroup(r: R): GroupIn {
  const n = int(r, 2, 12);
  const ids = Array.from({ length: n }, (_, i) => "m" + (i + 1));
  const [settleCcy, settleDp] = pick(r, CCY);
  const rates: RateIn[] = [];
  for (const [c] of CCY) {
    if (c === settleCcy) continue;
    rates.push({ currency: c, effective: "-infinity", rate: String(int(r, 1, 20000)) + (r() < 0.5 ? "." + int(r, 1, 999) : ""), inverted: r() < 0.3 });
    if (r() < 0.5) rates.push({ currency: c, effective: "2026-09-1" + int(r, 0, 9), rate: String(int(r, 1, 500)), inverted: r() < 0.3 });
  }
  const bills = Array.from({ length: int(r, 1, 10) }, (_, i) => {
    const [c, dp] = r() < 0.5 ? [settleCcy, settleDp] : pick(r, CCY);
    return { id: "b" + i, currency: c, dp, date: "2026-09-" + String(int(r, 1, 28)).padStart(2, "0"), bill: randomBill(r, ids) };
  });
  const payments = Array.from({ length: int(r, 0, 3) }, (_, i) => {
    const [from, to] = sample(r, ids, 2);
    const [c, dp] = r() < 0.7 ? [settleCcy, settleDp] : pick(r, CCY);
    return { id: "p" + i, from, to, currency: c, dp, amount: BigInt(int(r, 1, 50000)), date: "2026-09-15" };
  });
  return {
    currency: settleCcy,
    dp: settleDp,
    members: ids.map((id, i) => ({ id, position: i + 1 })),
    bills,
    payments,
    rates,
  };
}

/** Largest number of disjoint zero-sum groups, by brute force. */
function bruteK(xs: bigint[]): number {
  if (!xs.length) return 0;
  const [first, ...rest] = xs;
  let best = 0;
  const n = rest.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let s = first;
    const inS: number[] = [];
    for (let j = 0; j < n; j++) if ((mask >> j) & 1) {
      s += rest[j];
      inS.push(j);
    }
    if (s !== 0n) continue;
    const remaining = rest.filter((_, j) => !((mask >> j) & 1));
    best = Math.max(best, 1 + bruteK(remaining));
  }
  return best;
}

function snapshot(out: ReturnType<typeof computeGroup>) {
  return {
    bills: out.bills.map((b) => ({
      id: b.id,
      total: String(b.total),
      conv: String(b.converted),
      err: b.error?.code ?? null,
      shares: [...b.shares].sort(([a], [c]) => (a < c ? -1 : 1)).map(([m, [x, c]]) => `${m}:${x}:${c}`),
    })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    balances: out.balances.map((b) => `${b.id}:${b.net}`).sort(),
    transfers: out.transfers.map((t) => `${t.from}>${t.to}:${t.amount}`).sort(),
  };
}

describe("engine invariants over random groups", () => {
  it("I1, I2, I3, I5, I7 hold for 3000 groups", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const g = randomGroup(r);
      const out = computeGroup(g);
      const order = new Map(g.members.map((m) => [m.id, m.position]));

      for (const b of out.bills) {
        if (b.error) {
          expect(["convert_zero", "total_not_positive"], `seed ${seed}`).toContain(b.error.code);
          continue;
        }
        let sx = 0n;
        let sc = 0n;
        for (const [, [x, c]] of b.shares) {
          expect(x >= 0n && (c ?? 0n) >= 0n, `seed ${seed}`).toBe(true);
          sx += x;
          sc += c ?? 0n;
        }
        expect(sx, `I1 seed ${seed}`).toBe(b.total);
        expect(sc, `I2 seed ${seed}`).toBe(b.converted);
      }

      let sum = 0n;
      for (const bal of out.balances) sum += bal.net;
      expect(sum, `I3 seed ${seed}`).toBe(0n);

      const check = new Map(out.balances.map((b) => [b.id, b.net]));
      for (const t of out.transfers) {
        expect(t.amount > 0n && t.from !== t.to, `seed ${seed}`).toBe(true);
        check.set(t.from, check.get(t.from)! + t.amount);
        check.set(t.to, check.get(t.to)! - t.amount);
      }
      for (const v of check.values()) expect(v, `I5 residual seed ${seed}`).toBe(0n);
      const nz = out.balances.filter((b) => b.net !== 0n).length;
      expect(out.transfers.length <= Math.max(0, nz - 1), `seed ${seed}`).toBe(true);

      // I7: shuffle every list that has no meaning in its order.
      const g2: GroupIn = {
        ...g,
        members: shuffle(r, g.members),
        rates: shuffle(r, g.rates),
        payments: shuffle(r, g.payments),
        bills: shuffle(r, g.bills).map((b) => ({
          ...b,
          bill: {
            ...b.bill,
            items: b.bill.items && shuffle(r, b.bill.items).map((it) => ({ ...it, members: shuffle(r, it.members) })),
            adjustments: b.bill.adjustments && shuffle(r, b.bill.adjustments),
            participants: b.bill.participants && shuffle(r, b.bill.participants),
          },
        })),
      };
      expect(snapshot(computeGroup(g2)), `I7 seed ${seed}`).toEqual(snapshot(out));

      // Leftover rule: everyone except the payer is within 1 unit of exact.
      for (const gb of g.bills) {
        try {
          const a = allocate(gb.bill, order);
          for (const [m, f] of a.exact) {
            if (a.payerInSplit && m === gb.bill.payer) continue;
            const x = a.shares.get(m)!;
            expect((x - 1n) * f.den < f.num && f.num < (x + 1n) * f.den, `seed ${seed}`).toBe(true);
            // A whole exact share is never bumped by the leftover.
            if (f.num % f.den === 0n) expect(x * f.den, `seed ${seed}`).toBe(f.num);
          }
        } catch {
          /* refused bills are covered above */
        }
      }
    }
  });

  it("settlement uses the true minimum number of transfers (brute force, n <= 9)", () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const r = rng(seed * 7919);
      const n = int(r, 2, 9);
      const xs = Array.from({ length: n - 1 }, () => BigInt(int(r, -6, 6)) * (r() < 0.5 ? 1n : 100n));
      xs.push(-xs.reduce((a, b) => a + b, 0n));
      const bs = xs.map((amount, i) => ({ id: "m" + i, position: i, amount }));
      const { transfers, optimal } = settle(bs);
      const nz = xs.filter((x) => x !== 0n);
      expect(optimal).toBe(true);
      expect(transfers.length, `seed ${seed} ${xs}`).toBe(nz.length - bruteK(nz));
    }
  });

  it("is deterministic and falls back to greedy above the exact limit", () => {
    const r = rng(42);
    const n = EXACT_MAX + 5;
    const xs = Array.from({ length: n - 1 }, () => BigInt(int(r, -1000, 1000)));
    xs.push(-xs.reduce((a, b) => a + b, 0n));
    const bs = xs.map((amount, i) => ({ id: "m" + i, position: i, amount }));
    const a = settle(bs);
    const b = settle(shuffle(r, bs));
    expect(a.optimal).toBe(false);
    expect(a.transfers).toEqual(b.transfers);
    expect(a.transfers.length).toBeLessThanOrEqual(xs.filter((x) => x !== 0n).length - 1);
  });

  it("exact DP at the limit stays fast", () => {
    const r = rng(7);
    const xs = Array.from({ length: EXACT_MAX - 1 }, () => BigInt(int(r, -100000, 100000)));
    xs.push(-xs.reduce((a, b) => a + b, 0n));
    const t0 = Date.now();
    settle(xs.map((amount, i) => ({ id: "m" + i, position: i, amount })));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
