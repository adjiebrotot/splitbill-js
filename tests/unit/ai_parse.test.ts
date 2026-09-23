/** The deterministic half of AI input: amounts, names, drafts. No model calls. */
import { describe, it, expect } from "vitest";
import { draftFromChat, draftFromReceipt, readAmount, resolveNames, type ParseCtx } from "@/services/ai_parse";
import { evalExact, exprToMinor } from "@/services/amount_expr";

const members = ["Ali", "Bob", "Cal", "Don"].map((name, i) => ({ id: String(i + 1), name, user_id: null, username: i === 1 ? "bobby" : null, position: i + 1, active: true }));
const ctx: ParseCtx = { members, sender: "1", currency: "IDR", today: "2026-09-23" };

describe("amount expressions (exact, no floats)", () => {
  it.each([
    ["3*45000", 0, 135000n],
    ["3x45000", 0, 135000n],
    ["0.1+0.2", 2, 30n],
    ["100/3", 2, 3333n],
    ["60000*10%", 0, 6000n],
    ["(10+5)*2", 2, 3000n],
    ["Rp 45000", 0, 45000n],
  ] as [string, number, bigint][])("%s (dp %i)", (e, dp, want) => {
    expect(exprToMinor(e, dp)).toBe(want);
  });

  it("refuses junk and non-positive results", () => {
    expect(exprToMinor("abc", 2)).toBeNull();
    expect(exprToMinor("5-10", 2)).toBeNull();
    expect(exprToMinor("1/0", 2)).toBeNull();
    expect(evalExact("2*(3")).toBeNull();
  });

  it("reads amounts the way receipts print them", () => {
    expect(readAmount("185.000", 0)).toBe(185000n);
    expect(readAmount("Rp 1.250.000", 0)).toBe(1250000n);
    expect(readAmount("$29.00", 2)).toBe(2900n);
    expect(readAmount("PB1 10% 60.375", 0)).toBe(60375n);
    expect(readAmount("Service 5% 28.750", 0)).toBe(28750n);
    expect(readAmount("-$5.56", 2)).toBe(556n);
    expect(readAmount("($5.56)", 2)).toBe(556n);
    expect(readAmount("Rp -10.000", 0)).toBe(10000n);
    expect(readAmount(null, 2)).toBeNull();
  });
});

describe("names", () => {
  it("matches members, me, everyone, usernames and near misses; flags strangers", () => {
    const unknown = new Set<string>();
    expect(resolveNames(["me", "bob", "@bobby", "Call", "semua"], ctx, unknown)).toEqual(["1", "2", "3", "4"]);
    expect(resolveNames(["Zed"], ctx, unknown)).toEqual([]);
    expect([...unknown]).toEqual(["Zed"]);
  });
});

describe("drafts", () => {
  it("items with a percent tax become an exact amount", () => {
    const d = draftFromChat({
      description: "Dinner", date: null, currency: null, payer: "me", mode: "items", total_expr: null, people: [], percents: [],
      items: [{ name: "a", amount_expr: "35000", people: ["Ali"] }, { name: "b", amount_expr: "2*8000", people: ["Ali", "Bob"] }],
      adjustments: [{ kind: "tax", amount_expr: null, percent: "11" }, { kind: "discount", amount_expr: "1000", percent: null }],
    }, ctx);
    expect(d.items!.map((i) => i.amount)).toEqual(["35000", "16000"]);
    expect(d.adjustments).toEqual([{ kind: "tax", amount: "5610" }, { kind: "discount", amount: "-1000" }]);
    expect(d.payer).toBe("1");
  });

  it("falls back safely: bad date, unknown currency, missing payer", () => {
    const d = draftFromChat({ description: "", date: "2099-01-01", currency: "XYZ", payer: null, mode: "even", total_expr: "60000", people: [], percents: [], items: [], adjustments: [] }, ctx);
    expect(d.date).toBe("2026-09-23");
    expect(d.currency).toBe("IDR");
    expect(d.payer).toBe("1");
    expect(d.participants!.length).toBe(4);
    expect(d.description).toBe("Bill");
  });

  it("an unknown person is reported, never created", () => {
    const d = draftFromChat({ description: "x", date: null, currency: null, payer: "Zed", mode: "items", total_expr: null, people: [], percents: [],
      items: [{ name: "a", amount_expr: "100", people: ["Zed"] }], adjustments: [] }, ctx);
    expect(d.unknown).toEqual(["Zed"]);
    expect(d.items![0].members).toEqual([]);
    expect(d.payer).toBe("1");
  });

  it("receipt: printed total kept as the receipt total, caption assignments applied", () => {
    const d = draftFromReceipt(
      { merchant: "Warung", date: "2026-09-21", currency: null, items: [{ name: "Ikan", qty: 1, amount: "185.000" }, { name: "Udang", qty: 2, amount: "240.000" }],
        tax: "PB1 10% 42.500", service: null, discount: null, tip: null, total: "467.500" },
      { payer: "Bob", default_people: ["all"], assign: [{ item: 2, people: ["Bob", "Cal"] }] },
      ctx,
    );
    expect(d.items!.map((i) => [i.amount, i.members])).toEqual([["185000", ["1", "2", "3", "4"]], ["240000", ["2", "3"]]]);
    expect(d.adjustments).toEqual([{ kind: "tax", amount: "42500" }]);
    expect(d.stated_total).toBe("467500");
    expect(d.payer).toBe("2");
  });
});
