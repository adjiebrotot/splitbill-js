/**
 * The user's own examples, verbatim, plus the rounding cases the rules name.
 * Amounts are minor units (cents unless noted).
 */
import { describe, it, expect } from "vitest";
import { allocate, bigSideRate, computeGroup, convertShares, convertTotal, displayRate, factorFromRate, parseRate, type BillIn, type GroupIn } from "@/engine";

const order = new Map([["ali", 1], ["bob", 2], ["cal", 3], ["don", 4]]);
const members = [...order].map(([id, position]) => ({ id, position }));

function group(bills: Array<{ bill: BillIn; currency?: string; dp?: number }>, extra: Partial<GroupIn> = {}): GroupIn {
  return {
    currency: "USD",
    dp: 2,
    members,
    bills: bills.map((b, i) => ({ id: "b" + i, currency: b.currency ?? "USD", dp: b.dp ?? 2, date: "2026-09-01", bill: b.bill })),
    payments: [],
    rates: [],
    ...extra,
  };
}

const plain = (ts: { from: string; to: string; amount: bigint }[]) => ts.map((t) => `${t.from}->${t.to} ${t.amount}`);
const nets = (g: ReturnType<typeof computeGroup>) => Object.fromEntries(g.balances.map((b) => [b.id, b.net]));

describe("user examples", () => {
  it("Ice cream $10 for Ali paid by Bob: Ali owes Bob $10", () => {
    const g = computeGroup(group([{ bill: { payer: "bob", mode: "items", items: [{ name: "Ice cream", amount: 1000n, members: ["ali"] }] } }]));
    expect(plain(g.transfers)).toEqual(["ali->bob 1000"]);
  });

  it("Meal $15 for Ali, Bob, Cal paid by Don: each owes Don $5", () => {
    const g = computeGroup(group([{ bill: { payer: "don", mode: "items", items: [{ name: "Meal", amount: 1500n, members: ["ali", "bob", "cal"] }] } }]));
    expect(plain(g.transfers).sort()).toEqual(["ali->don 500", "bob->don 500", "cal->don 500"]);
  });

  it("Lunch $60 evenly for Ali, Bob, Cal paid by Ali: Bob, Cal owe Ali $20; Ali's $20 recorded", () => {
    const bill: BillIn = { payer: "ali", mode: "even", total: 6000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] };
    const a = allocate(bill, order);
    expect(Object.fromEntries(a.shares)).toEqual({ ali: 2000n, bob: 2000n, cal: 2000n });
    const g = computeGroup(group([{ bill }]));
    expect(plain(g.transfers).sort()).toEqual(["bob->ali 2000", "cal->ali 2000"]);
    expect(g.balances.find((b) => b.id === "ali")!.share).toBe(2000n);
  });

  it("Lunch $60 by percent 50/25/25 paid by Ali: Bob, Cal owe Ali $15; Ali's $30 recorded", () => {
    const bill: BillIn = {
      payer: "ali", mode: "percent", total: 6000n,
      participants: [{ member: "ali", bp: 5000 }, { member: "bob", bp: 2500 }, { member: "cal", bp: 2500 }],
    };
    const g = computeGroup(group([{ bill }]));
    expect(plain(g.transfers).sort()).toEqual(["bob->ali 1500", "cal->ali 1500"]);
    expect(g.balances.find((b) => b.id === "ali")!.share).toBe(3000n);
  });

  it("Settlement preview: Ali +40, Bob -5, Cal -35 gives Cal->Ali 35, Bob->Ali 5", () => {
    const g = computeGroup(group([
      { bill: { payer: "ali", mode: "even", total: 6000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] } },
      { bill: { payer: "bob", mode: "even", total: 3000n, participants: [{ member: "bob" }, { member: "cal" }] } },
    ]));
    expect(nets(g)).toEqual({ ali: 4000n, bob: -500n, cal: -3500n, don: 0n });
    expect(plain(g.transfers).sort()).toEqual(["bob->ali 500", "cal->ali 3500"]);
  });
});

describe("leftover rule", () => {
  it("10.00 / 3, payer inside: payer takes 3.34", () => {
    const a = allocate({ payer: "bob", mode: "even", total: 1000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] }, order);
    expect(Object.fromEntries(a.shares)).toEqual({ ali: 333n, bob: 334n, cal: 333n });
  });

  it("10.00 / 3, payer outside: first fraction holder in join order takes 3.34", () => {
    const a = allocate({ payer: "don", mode: "even", total: 1000n, participants: [{ member: "cal" }, { member: "bob" }, { member: "ali" }] }, order);
    expect(Object.fromEntries(a.shares)).toEqual({ ali: 334n, bob: 333n, cal: 333n });
  });

  it("payer outside: a member whose exact share is whole is never bumped", () => {
    // Ali exactly 3.00; Bob and Cal 3.505 each. Leftover goes to Bob, not Ali.
    const a = allocate({
      payer: "don", mode: "items",
      items: [{ amount: 300n, members: ["ali"] }, { amount: 701n, members: ["bob", "cal"] }],
    }, order);
    expect(Object.fromEntries(a.shares)).toEqual({ ali: 300n, bob: 351n, cal: 350n });
  });

  it("IDR has no minor unit: 100,000 / 3 with payer outside", () => {
    const a = allocate({ payer: "don", mode: "even", total: 100000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] }, order);
    expect(Object.fromEntries(a.shares)).toEqual({ ali: 33334n, bob: 33333n, cal: 33333n });
  });

  it("tax, service and discount follow each member's items", () => {
    // Items 60.00 (Ali 20, Bob 40), tax 6.00, discount -3.00 -> total 63.00.
    const a = allocate({
      payer: "ali", mode: "items",
      items: [{ amount: 2000n, members: ["ali"] }, { amount: 4000n, members: ["bob"] }],
      adjustments: [{ kind: "tax", amount: 600n }, { kind: "discount", amount: -300n }],
    }, order);
    expect(a.total).toBe(6300n);
    expect(Object.fromEntries(a.shares)).toEqual({ ali: 2100n, bob: 4200n });
  });
});

describe("conversion", () => {
  it("USD bill, IDR settlement: converts the rounded shares", () => {
    const bill: BillIn = { payer: "ali", mode: "even", total: 1000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] };
    const a = allocate(bill, order);
    const C = convertTotal(a.total, 2, 0, factorFromRate(parseRate("16000").value, false));
    expect(C).toBe(160000n);
    expect(Object.fromEntries(convertShares(a, C, "ali", order))).toEqual({ ali: 53440n, bob: 53280n, cal: 53280n });
  });

  it("IDR bill, USD settlement with an inverted rate (1 USD = 16,000 IDR)", () => {
    const g = computeGroup(group(
      [{ currency: "IDR", dp: 0, bill: { payer: "ali", mode: "even", total: 100000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] } }],
      { rates: [{ currency: "IDR", effective: "-infinity", rate: "16000", inverted: true }] },
    ));
    const b = g.bills[0];
    expect(b.converted).toBe(625n);
    const conv = Object.fromEntries([...b.shares].map(([m, [, c]]) => [m, c]));
    expect(conv).toEqual({ ali: 209n, bob: 208n, cal: 208n });
  });

  it("uses the latest rate on or before the bill date", () => {
    const rates = [
      { currency: "JPY", effective: "-infinity", rate: "100", inverted: false },
      { currency: "JPY", effective: "2026-09-02", rate: "110", inverted: false },
    ];
    const mk = (date: string): GroupIn => ({
      currency: "IDR", dp: 0, members, payments: [], rates,
      bills: [{ id: "b", currency: "JPY", dp: 0, date, bill: { payer: "ali", mode: "even", total: 1000n, participants: [{ member: "bob" }] } }],
    });
    expect(computeGroup(mk("2026-09-01")).bills[0].converted).toBe(100000n);
    expect(computeGroup(mk("2026-09-02")).bills[0].converted).toBe(110000n);
    expect(computeGroup(mk("2026-09-30")).bills[0].converted).toBe(110000n);
  });

  it("a foreign bill with no rate is flagged and the group is incomplete", () => {
    const g = computeGroup(group([{ currency: "JPY", dp: 0, bill: { payer: "ali", mode: "even", total: 1000n, participants: [{ member: "bob" }] } }]));
    expect(g.complete).toBe(false);
    expect(g.bills[0].error?.code).toBe("rate_missing");
    expect(g.missing).toEqual([{ currency: "JPY", date: "2026-09-01" }]);
  });

  it("a conversion that rounds to zero is refused", () => {
    const g = computeGroup({
      currency: "USD", dp: 2, members, payments: [],
      rates: [{ currency: "IDR", effective: "-infinity", rate: "16000", inverted: true }],
      bills: [{ id: "b", currency: "IDR", dp: 0, date: "2026-09-01", bill: { payer: "ali", mode: "even", total: 1n, participants: [{ member: "bob" }] } }],
    });
    expect(g.bills[0].error?.code).toBe("convert_zero");
  });
});

describe("payments", () => {
  it("a mid-trip repayment lowers what is left to settle", () => {
    const g = computeGroup(group(
      [{ bill: { payer: "ali", mode: "even", total: 6000n, participants: [{ member: "ali" }, { member: "bob" }, { member: "cal" }] } }],
      { payments: [{ id: "p", from: "bob", to: "ali", currency: "USD", dp: 2, amount: 500n, date: "2026-09-02" }] },
    ));
    expect(nets(g)).toEqual({ ali: 3500n, bob: -1500n, cal: -2000n, don: 0n });
    expect(plain(g.transfers).sort()).toEqual(["bob->ali 1500", "cal->ali 2000"]);
  });

  it("overpayment flips the direction instead of failing", () => {
    const g = computeGroup(group(
      [{ bill: { payer: "ali", mode: "even", total: 1000n, participants: [{ member: "bob" }] } }],
      { payments: [{ id: "p", from: "bob", to: "ali", currency: "USD", dp: 2, amount: 1500n, date: "2026-09-02" }] },
    ));
    expect(plain(g.transfers)).toEqual(["ali->bob 500"]);
  });
});

describe("rates: stored and shown big side first", () => {
  it("shows the decimals that mean something", () => {
    expect(displayRate("21624.09938", false)).toEqual({ text: "21624", inverted: false });
    expect(displayRate("12.151245533", false)).toEqual({ text: "12.15", inverted: false });
    // 1 IDR = 0.00007901521 AUD reads as 1 AUD = 12,656 IDR.
    expect(displayRate("0.00007901521", false)).toEqual({ text: "12656", inverted: true });
    expect(displayRate("1", true)).toEqual({ text: "1", inverted: true });
  });

  it("stores a rate under 1 as its reciprocal, 10 significant digits", () => {
    const r = bigSideRate(parseRate("0.00007901521"), false);
    expect(r.inverted).toBe(true);
    expect(r.rate.text).toBe("12655.79121");
    const inv = bigSideRate(parseRate("0.5"), true);
    expect([inv.rate.text, inv.inverted]).toEqual(["2", false]);
    // A rate of 1 or more is kept exactly as typed.
    const big = bigSideRate(parseRate("21624.09938"), false);
    expect([big.rate.text, big.inverted]).toEqual(["21624.09938", false]);
    // A reciprocal past the largest rate stays as given.
    expect(bigSideRate(parseRate("0.000000000001"), false).rate.text).toBe("0.000000000001");
  });
});
