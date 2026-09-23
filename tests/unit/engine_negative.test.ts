/** Everything the engine must refuse, with the reason code the UI shows. */
import { describe, it, expect } from "vitest";
import { allocate, EngineError, parseAmount, parsePercent, parseRate, parseMinor, type BillIn } from "@/engine";

const order = new Map([["ali", 1], ["bob", 2], ["cal", 3]]);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "no error";
}

const refuse = (bill: BillIn) => code(() => allocate(bill, order));

describe("bill refusals", () => {
  it.each([
    ["total zero", { payer: "ali", mode: "even", total: 0n, participants: [{ member: "bob" }] }, "total_not_positive"],
    ["total negative", { payer: "ali", mode: "even", total: -5n, participants: [{ member: "bob" }] }, "total_not_positive"],
    ["no participants", { payer: "ali", mode: "even", total: 100n, participants: [] }, "participants_empty"],
    ["duplicate participant", { payer: "ali", mode: "even", total: 100n, participants: [{ member: "bob" }, { member: "bob" }] }, "participant_duplicate"],
    ["unknown payer", { payer: "zed", mode: "even", total: 100n, participants: [{ member: "bob" }] }, "payer_unknown"],
    ["unknown participant", { payer: "ali", mode: "even", total: 100n, participants: [{ member: "zed" }] }, "member_unknown"],
    ["percent not 100", { payer: "ali", mode: "percent", total: 100n, participants: [{ member: "ali", bp: 5000 }, { member: "bob", bp: 4999 }] }, "percent_sum"],
    ["percent zero", { payer: "ali", mode: "percent", total: 100n, participants: [{ member: "ali", bp: 10000 }, { member: "bob", bp: 0 }] }, "percent_invalid"],
    ["percent missing", { payer: "ali", mode: "percent", total: 100n, participants: [{ member: "ali" }] }, "percent_invalid"],
    ["no items", { payer: "ali", mode: "items", items: [] }, "items_empty"],
    ["negative item", { payer: "ali", mode: "items", items: [{ amount: -1n, members: ["bob"] }] }, "item_negative"],
    ["unassigned priced item", { payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }, { amount: 50n, members: [] }] }, "item_unassigned"],
    ["only zero items", { payer: "ali", mode: "items", items: [{ amount: 0n, members: [] }], adjustments: [{ kind: "tax", amount: 10n }] }, "items_subtotal_zero"],
    ["duplicate member in item", { payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob", "bob"] }] }, "item_duplicate_member"],
    ["discount bigger than items", { payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }], adjustments: [{ kind: "discount", amount: -100n }] }, "total_not_positive"],
    ["positive discount", { payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }], adjustments: [{ kind: "discount", amount: 10n }] }, "adjustment_sign"],
    ["negative tax", { payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }], adjustments: [{ kind: "tax", amount: -10n }] }, "adjustment_sign"],
    ["zero adjustment", { payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }], adjustments: [{ kind: "other", amount: 0n }] }, "adjustment_zero"],
    ["typed total disagrees with items", { payer: "ali", mode: "items", total: 150n, items: [{ amount: 100n, members: ["bob"] }] }, "total_mismatch"],
    ["adjustments in even mode", { payer: "ali", mode: "even", total: 100n, participants: [{ member: "bob" }], adjustments: [{ kind: "tax", amount: 5n }] }, "adjustments_not_allowed"],
    ["bad mode", { payer: "ali", mode: "weird", total: 100n } as unknown as BillIn, "mode_invalid"],
  ] as [string, BillIn, string][])("%s", (_name, bill, expected) => {
    expect(refuse(bill)).toBe(expected);
  });

  it("zero-price item may stay unassigned and is ignored", () => {
    const a = allocate({ payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }, { amount: 0n, members: [] }] }, order);
    expect(Object.fromEntries(a.shares)).toEqual({ bob: 100n });
  });

  it("small discount keeps every share positive", () => {
    const a = allocate({ payer: "ali", mode: "items", items: [{ amount: 100n, members: ["bob"] }, { amount: 100n, members: ["cal"] }], adjustments: [{ kind: "discount", amount: -150n }] }, order);
    expect(a.total).toBe(50n);
    expect(Object.fromEntries(a.shares)).toEqual({ bob: 25n, cal: 25n });
  });
});

describe("amount parsing", () => {
  it.each([
    ["25.000", 0, 25000n],
    ["25,000", 0, 25000n],
    ["1.250.000", 0, 1250000n],
    ["Rp 1.250.000".replace("Rp ", ""), 0, 1250000n],
    ["12.50", 2, 1250n],
    ["12,50", 2, 1250n],
    ["12.5", 2, 1250n],
    ["1,234.56", 2, 123456n],
    ["1.234,56", 2, 123456n],
    ["1,234", 2, 123400n],
    ["12.345", 2, 1234500n], // one separator + 3 digits reads as thousands
    ["1.234", 3, 1234n],
    ["7", 2, 700n],
  ] as [string, number, bigint][])("%s (dp %i) -> %s", (s, dp, want) => {
    expect(parseAmount(s, dp)).toBe(want);
  });

  it.each([
    ["12.5", 0, "amount_too_precise"],
    ["12.3456", 2, "amount_too_precise"],
    ["1,23,456", 0, "amount_invalid"],
    ["abc", 2, "amount_invalid"],
    ["", 2, "amount_invalid"],
    ["-5", 2, "amount_negative"],
    ["0", 2, "amount_zero"],
    ["1.2.3,4", 2, "amount_invalid"],
    ["10000000000000000", 0, "amount_too_large"],
  ] as [string, number, string][])("refuses %s (dp %i)", (s, dp, c) => {
    expect(code(() => parseAmount(s, dp))).toBe(c);
  });

  it("percent to basis points", () => {
    expect(parsePercent("33.33")).toBe(3333);
    expect(parsePercent("33,5")).toBe(3350);
    expect(parsePercent("100")).toBe(10000);
    expect(code(() => parsePercent("33.333"))).toBe("percent_too_precise");
    expect(code(() => parsePercent("100.01"))).toBe("percent_invalid");
  });

  it("rates", () => {
    expect(parseRate("16000").text).toBe("16000");
    expect(parseRate("0.062500").text).toBe("0.0625");
    expect(code(() => parseRate("0"))).toBe("rate_invalid");
    expect(code(() => parseRate("1.0000000000001"))).toBe("rate_too_precise");
    expect(code(() => parseRate("-1"))).toBe("rate_invalid");
    expect(code(() => parseRate("2000000000"))).toBe("rate_too_large");
  });

  it("canonical minor strings", () => {
    expect(parseMinor("1250")).toBe(1250n);
    expect(code(() => parseMinor("12.5"))).toBe("amount_invalid");
    expect(code(() => parseMinor("-1"))).toBe("amount_negative");
    expect(parseMinor("-1", { allowNegative: true })).toBe(-1n);
  });
});
