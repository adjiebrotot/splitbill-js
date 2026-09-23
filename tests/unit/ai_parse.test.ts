/** The deterministic half of AI input: amounts, names, drafts. No model calls. */
import { describe, it, expect, vi } from "vitest";
import { currencyInText, draftFromChat, mentionedIds, draftFromReceipt, parseReceipt, readAmount, resolveNames, type ParseCtx } from "@/services/ai_parse";

// Only the parseReceipt test below reaches the models; both calls are fakes.
vi.mock("@/services/llm_client", () => ({
  imageJson: vi.fn(async () => [{ merchant: "Warung", currency: "IDR", items: [{ name: "Ikan", qty: 1, amount: "50.000" }], total: "50.000" }, { model: "v", prompt_tokens: 1, completion_tokens: 1 }]),
  textJson: vi.fn(async () => { throw new Error("timeout"); }),
}));
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

  it("reads the currency the message shows, not the model's guess", () => {
    expect(currencyInText("Meal $15 for Ali", "IDR")).toBe("USD");
    expect(currencyInText("Taxi $15", "SGD")).toBe("SGD");
    expect(currencyInText("Taxi S$15", "IDR")).toBe("SGD");
    expect(currencyInText("Taxi US$15", "SGD")).toBe("USD");
    expect(currencyInText("Hotel 120 SGD split", "IDR")).toBe("SGD");
    expect(currencyInText("SGD 120 hotel", "IDR")).toBe("SGD");
    expect(currencyInText("Tiket Rp 1.250.000", "USD")).toBe("IDR");
    expect(currencyInText("Dinner 300k, PPN 11%", "IDR")).toBeNull();
    expect(currencyInText("Hotel 120 SGD and taxi $5", "IDR")).toBeNull();
    const base = { description: "x", date: null, payer: null, mode: "even", total_expr: "15", people: [], percents: [], items: [], adjustments: [] };
    const d = draftFromChat({ ...base, currency: null }, ctx, "chat", "Meal $15");
    expect([d.currency, d.total]).toEqual(["USD", "1500"]);
    expect(draftFromChat({ ...base, currency: "EUR" }, ctx, "chat", "Meal 15").currency).toBe("EUR");
  });

  it("people the message never names are dropped from the model's lists", () => {
    const ids = (t: string) => { const k = mentionedIds(t, ctx); return k ? [...k].sort() : null; };
    expect(ids("Lunch 60k for me, Bob and Cal, I paid, split evenly")).toEqual(["1", "2", "3"]);
    expect(ids("Uber $23.47 split evenly me and Cal, Cal paid")).toEqual(["1", "3"]);
    expect(ids("parkir 20rb buat saya sama bobb, saya yang bayar")).toEqual(["1", "2"]);
    expect(ids("Dinner 200k split evenly, Bob paid")).toBeNull();
    expect(ids("Makan 200rb bagi rata, dibayar oleh Don")).toBeNull();
    expect(ids("Hotel 120 SGD split evenly all, Cal paid")).toBeNull();
    expect(ids("makan malam bagi rata semua, Bob yang bayar")).toBeNull();
    const all = ["Ali", "Bob", "Cal", "Don"];
    const d = draftFromChat({ description: "x", date: null, currency: null, payer: "Cal", mode: "even", total_expr: "23.47", people: all, percents: [], items: [], adjustments: [] },
      ctx, "chat", "Uber $23.47 split evenly me and Cal, Cal paid");
    expect(d.participants!.map((p) => p.member)).toEqual(["1", "3"]);
    const e = draftFromChat({ description: "x", date: null, currency: null, payer: "Bob", mode: "even", total_expr: "200000", people: all, percents: [], items: [], adjustments: [] },
      ctx, "chat", "Dinner 200k split evenly, Bob paid");
    expect(e.participants!.length).toBe(4);
  });

  it("drops a discount listed twice and a total said again", () => {
    const d = draftFromChat({ description: "x", date: null, currency: null, payer: "Don", mode: "items", total_expr: null, people: [], percents: [],
      items: [{ name: "beras", amount_expr: "150000", people: ["Ali", "Bob"] }, { name: "discount", amount_expr: "10000", people: [] }],
      adjustments: [{ kind: "discount", amount_expr: "10000", percent: null }] }, ctx, "chat", "beras 150rb Ali Bob, discount 10k, Don paid");
    expect(d.items!.map((i) => i.amount)).toEqual(["150000"]);
    expect(d.adjustments).toEqual([{ kind: "discount", amount: "-10000" }]);
    const e = draftFromChat({ description: "x", date: null, currency: null, payer: "Cal", mode: "items", total_expr: null, people: [], percents: [],
      items: [{ name: "Dinner", amount_expr: "300000", people: ["Ali", "Bob"] }, { name: "Ali", amount_expr: "100000", people: ["Ali"] }, { name: "Bob", amount_expr: "200000", people: ["Bob"] }],
      adjustments: [] }, ctx, "chat", "Dinner 300k, Ali 100k Bob 200k, Cal paid");
    expect(e.items!.map((i) => [i.amount, i.members])).toEqual([["100000", ["1"]], ["200000", ["2"]]]);
    const g = draftFromChat({ description: "x", date: null, currency: null, payer: "Cal", mode: "items", total_expr: null, people: [], percents: [],
      items: [{ name: "Ali", amount_expr: "100000", people: ["Ali"] }, { name: "Cal", amount_expr: "", people: ["Cal"] }, { name: "Nasi", amount_expr: "", people: ["Bob"] }],
      adjustments: [] }, ctx);
    expect(g.items!.map((i) => [i.name, i.amount])).toEqual([["Ali", "100000"], ["Nasi", null]]);
    // A real item that happens to equal the others' sum stays.
    const f = draftFromChat({ description: "x", date: null, currency: null, payer: "Ali", mode: "items", total_expr: null, people: [], percents: [],
      items: [{ name: "pizza", amount_expr: "100000", people: ["Ali", "Bob"] }, { name: "cola", amount_expr: "50000", people: ["Ali"] }, { name: "beer", amount_expr: "50000", people: ["Bob"] }],
      adjustments: [] }, ctx);
    expect(f.items!.length).toBe(3);
  });

  it("days_ago is date math done in code, bounded", () => {
    const base = { description: "x", currency: null, payer: null, mode: "even", total_expr: "60000", people: [], percents: [], items: [], adjustments: [] };
    expect(draftFromChat({ ...base, date: null, days_ago: 2 }, ctx).date).toBe("2026-09-21");
    expect(draftFromChat({ ...base, date: "2026-09-01", days_ago: 0 }, ctx).date).toBe("2026-09-23");
    expect(draftFromChat({ ...base, date: "2026-09-01", days_ago: null }, ctx).date).toBe("2026-09-01");
    expect(draftFromChat({ ...base, date: null, days_ago: -3 }, ctx).date).toBe("2026-09-23");
    expect(draftFromChat({ ...base, date: null, days_ago: 1.5 }, ctx).date).toBe("2026-09-23");
    expect(draftFromChat({ ...base, date: null, days_ago: 9999 }, ctx).date).toBe("2026-09-23");
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

  it("receipt: an item the note gave an empty list falls back to the default people", () => {
    const d = draftFromReceipt({ merchant: "Solaria", rows: ["Nasi Goreng 1 30,001"], country: "Indonesia", currency: null,
      items: [{ name: "Nasi Goreng", qty: 1, amount: "30,001" }, { name: "Lychee Tea", qty: 1, amount: "13,637" }, { name: "Bihun", qty: 1, amount: "36,365" }],
      tax: null, service: null, discount: null, tip: null, rounding: null, total: "80,003" },
    { payer: "Cal", default_people: ["Ali", "Bob"], assign: [{ item: 1, people: ["Ali"] }, { item: 2, people: [] }] }, ctx);
    expect(d.items!.map((i) => i.members)).toEqual([["1"], ["1", "2"], ["1", "2"]]);
    expect(d.payer).toBe("3");
  });

  it("receipt: a failed note step keeps the receipt that was already read", async () => {
    const { draft } = await parseReceipt({ b64: "", mime: "image/jpeg" }, "Ikan Bob", ctx);
    expect(draft.items!.map((i) => [i.amount, i.members])).toEqual([["50000", ["1", "2", "3", "4"]]]);
    expect(draft.stated_total).toBe("50000");
  });

  it("receipt rounding keeps its printed sign", () => {
    const rec = (rounding: string) => draftFromReceipt({ merchant: "Kafe", date: null, currency: "IDR", items: [{ name: "Kopi", qty: 1, amount: "20.011" }],
      tax: null, service: null, discount: null, tip: null, rounding, total: "20.000" }, null, ctx).adjustments;
    expect(rec("-11")).toEqual([{ kind: "other", amount: "-11" }]);
    expect(rec("Rp -11")).toEqual([{ kind: "other", amount: "-11" }]);
    expect(rec("(11)")).toEqual([{ kind: "other", amount: "-11" }]);
    expect(rec("39")).toEqual([{ kind: "other", amount: "39" }]);
    expect(rec("0")).toEqual([]);
  });
});
