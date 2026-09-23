/**
 * parse_harness.ts: how well the AI reads bills, measured against the live
 * model (costs real money; needs LLM_API_KEY). Each case is a chat message
 * with the draft it must produce; a case passes when the deterministic draft
 * matches exactly (amounts in minor units, members, mode, payer).
 *
 *   LLM_API_KEY=... npx tsx scripts/parse_harness.ts [--runs 3] [--only 4] [--raw]
 *   LLM_API_KEY=... npx tsx scripts/parse_harness.ts --receipt path/to/receipt.jpg ["caption"] [--currency SGD]
 *   LLM_API_KEY=... npx tsx scripts/parse_harness.ts --receipts fixtures.json [--runs 3] [--only 2] [--raw]
 *
 * fixtures.json (keep it and the photos out of git; real receipts can hold
 * personal data): [{ "file": "a.jpg", "currency": "IDR", "caption": "...",
 *   "want": { "currency": "SGD", "items": ["600", "400"], "adj": { "tax": "795" },
 *             "total": "12145", "payer": "Don", "members": [["Ali"], ["Bob", "Cal"]] } }]
 * Item amounts compare in order; adjustments by kind (signed, summed per kind).
 */
import { readFileSync } from "node:fs";
import { parseChat, parseReceipt, type ParseCtx } from "../src/services/ai_parse";
import { normalizeImage } from "../src/services/llm_client";

const members = ["Ali", "Bob", "Cal", "Don"].map((name, i) => ({ id: String(i + 1), name, user_id: null, username: null, position: i + 1, active: true }));
const ctx: ParseCtx = { members, sender: "1", currency: "IDR", today: "2026-09-23" };
const id = (n: string) => String(members.findIndex((m) => m.name === n) + 1);

type Want = { mode: string; payer: string; total?: string; items?: [string, string[]][]; adj?: string[]; people?: string[]; bp?: [string, number][]; currency?: string; date?: string; unknown?: string[] };
const CASES: [string, Want][] = [
  ["Ice cream 10 for Ali paid by Bob, in USD", { mode: "items", payer: "Bob", currency: "USD", items: [["1000", ["Ali"]]] }],
  ["Meal $15 for Ali, Bob, Cal paid by Don", { mode: "items", payer: "Don", currency: "USD", items: [["1500", ["Ali", "Bob", "Cal"]]] }],
  ["Lunch 60k for me, Bob and Cal, I paid, split evenly", { mode: "even", payer: "Ali", total: "60000", people: ["Ali", "Bob", "Cal"] }],
  ["Lunch 60rb dibayar Ali, Ali 50%, Bob 25%, Cal 25%", { mode: "percent", payer: "Ali", total: "60000", bp: [["Ali", 5000], ["Bob", 2500], ["Cal", 2500]] }],
  ["makan malam 1,2jt bagi rata semua, Bob yang bayar", { mode: "even", payer: "Bob", total: "1200000", people: ["Ali", "Bob", "Cal", "Don"] }],
  ["Taxi 3 x 45rb for Cal and Don, paid by Cal", { mode: "items", payer: "Cal", items: [["135000", ["Cal", "Don"]]] }],
  ["Dinner: nasi goreng 35000 Ali, mie 30000 Bob, es teh 2x8000 Ali Bob, tax 10%, I paid", { mode: "items", payer: "Ali", items: [["35000", ["Ali"]], ["30000", ["Bob"]], ["16000", ["Ali", "Bob"]]], adj: ["8100"] }],
  ["kemarin bensin 200rb dibayar Don buat Don dan Cal", { mode: "items", payer: "Don", date: "2026-09-22", items: [["200000", ["Don", "Cal"]]] }],
  ["Hotel 120 SGD split evenly all, Cal paid", { mode: "even", payer: "Cal", currency: "SGD", total: "12000", people: ["Ali", "Bob", "Cal", "Don"] }],
  ["Groceries: beras 150rb Ali Bob, minyak 45k Cal, discount 10k, Don paid", { mode: "items", payer: "Don", items: [["150000", ["Ali", "Bob"]], ["45000", ["Cal"]]], adj: ["-10000"] }],
  ["Dinner: steak 250000 Bob, pasta 120000 Cal, service 5%, PPN 11%, Bob paid", { mode: "items", payer: "Bob", items: [["250000", ["Bob"]], ["120000", ["Cal"]]], adj: ["18500", "40700"] }],
  ["Coffee 45k for Ali and Eve, Bob paid", { mode: "items", payer: "Bob", items: [["45000", ["Ali"]]], unknown: ["Eve"] }],
  ["Villa 2,5jt dibayar Cal, Ali 33,33%, Bob 33,33%, Cal 33,34%", { mode: "percent", payer: "Cal", total: "2500000", bp: [["Ali", 3333], ["Bob", 3333], ["Cal", 3334]] }],
  ["parkir 20rb buat saya sama bobb, saya yang bayar", { mode: "items", payer: "Ali", items: [["20000", ["Ali", "Bob"]]] }],
  ["Tiket konser Rp 1.250.000 untuk Cal, dibayar Don", { mode: "items", payer: "Don", items: [["1250000", ["Cal"]]] }],
  ["2 hari lalu sewa mobil 1,5jt bagi rata Ali Bob Cal Don, Ali bayar", { mode: "even", payer: "Ali", date: "2026-09-21", total: "1500000", people: ["Ali", "Bob", "Cal", "Don"] }],
  ["Uber $23.47 split evenly me and Cal, Cal paid", { mode: "even", payer: "Cal", currency: "USD", total: "2347", people: ["Ali", "Cal"] }],
  ["Dinner 300k, Ali 100k Bob 200k, Cal paid", { mode: "items", payer: "Cal", items: [["100000", ["Ali"]], ["200000", ["Bob"]]] }],
];

function check(d: any, w: Want): string[] {
  const bad: string[] = [];
  // One item shared by some people, no tax: splits exactly like "even" over them.
  if (w.mode === "even" && d.mode === "items" && d.items?.length === 1 && !d.adjustments?.length) {
    d = { ...d, mode: "even", total: d.items[0].amount, participants: d.items[0].members.map((member: string) => ({ member })) };
  }
  const eq = (k: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${k}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
  eq("mode", d.mode, w.mode);
  eq("payer", d.payer, id(w.payer));
  if (w.currency) eq("currency", d.currency, w.currency);
  if (w.date) eq("date", d.date, w.date);
  if (w.total) eq("total", d.total, w.total);
  if (w.items) eq("items", (d.items ?? []).map((i: any) => [i.amount, [...i.members].sort()]), w.items.map(([a, ms]) => [a, ms.map(id).sort()]));
  if (w.adj) eq("adjustments", (d.adjustments ?? []).map((a: any) => a.amount).sort(), [...w.adj].sort());
  if (w.unknown) eq("unknown", [...d.unknown].sort(), [...w.unknown].sort());
  if (w.people) eq("people", (d.participants ?? []).map((p: any) => p.member).sort(), w.people.map(id).sort());
  if (w.bp) eq("percents", (d.participants ?? []).map((p: any) => [p.member, p.bp]).sort(), w.bp.map(([n, b]) => [id(n), b]).sort());
  return bad;
}

type ReceiptWant = { currency?: string; items?: (string | null)[]; adj?: Record<string, string>; total?: string | null; payer?: string; members?: string[][] };
type Fixture = { file: string; currency?: string; caption?: string; want: ReceiptWant };

function checkReceipt(d: any, w: ReceiptWant): string[] {
  const bad: string[] = [];
  const eq = (k: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${k}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
  if (w.currency) eq("currency", d.currency, w.currency);
  if (w.items) eq("items", (d.items ?? []).map((i: any) => i.amount), w.items);
  if (w.adj) {
    const got: Record<string, string> = {};
    for (const a of d.adjustments ?? []) got[a.kind] = (BigInt(got[a.kind] ?? "0") + BigInt(a.amount)).toString();
    eq("adjustments", Object.fromEntries(Object.entries(got).sort()), Object.fromEntries(Object.entries(w.adj).sort()));
  }
  if (w.total !== undefined) eq("total", d.stated_total, w.total);
  if (w.payer) eq("payer", d.payer, id(w.payer));
  if (w.members) eq("members", (d.items ?? []).map((i: any) => [...i.members].sort()), w.members.map((ms) => ms.map(id).sort()));
  return bad;
}

function reconcile(d: any): string {
  const sum = (d.items ?? []).reduce((s: bigint, i: any) => s + BigInt(i.amount ?? "0"), 0n) + (d.adjustments ?? []).reduce((s: bigint, a: any) => s + BigInt(a.amount), 0n);
  if (d.stated_total == null) return `lines ${sum}, no printed total`;
  const gap = BigInt(d.stated_total) - sum;
  return gap === 0n ? "MATCH" : `MISMATCH gap ${gap}`;
}

async function receipts(file: string, runs: number, only: number | null, showRaw: boolean) {
  const fixtures: Fixture[] = JSON.parse(readFileSync(file, "utf8"));
  const dir = file.replace(/[^/]*$/, "");
  let pass = 0, total = 0;
  for (const [i, f] of fixtures.entries()) {
    if (only !== null && only !== i + 1) continue;
    const path = f.file.startsWith("/") ? f.file : dir + f.file;
    const img = await normalizeImage(new Uint8Array(readFileSync(path)), "image/jpeg");
    const c = { ...ctx, currency: f.currency ?? ctx.currency };
    for (let r = 0; r < runs; r++) {
      total += 1;
      const t0 = Date.now();
      try {
        const { draft, usage, raw } = await parseReceipt({ b64: Buffer.from(img.bytes).toString("base64"), mime: img.mime }, f.caption ?? "", c);
        const bad = checkReceipt(draft, f.want);
        if (!bad.length) pass += 1;
        const tok = usage.reduce((s: number, u: any) => s + u.prompt_tokens + u.completion_tokens, 0);
        console.log(`${bad.length ? "FAIL" : "ok  "} #${i + 1} ${f.file} [${c.currency}] ${reconcile(draft)} ${Date.now() - t0} ms ${tok} tok${bad.length ? "\n      " + bad.join("\n      ") : ""}`);
        if (bad.length && showRaw) console.log("      raw: " + JSON.stringify(raw));
      } catch (e) {
        console.log(`ERR  #${i + 1} ${f.file}: ${e}`);
      }
    }
  }
  console.log(`\n${pass}/${total} passed`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (opt("--receipts")) {
    await receipts(opt("--receipts")!, Number(opt("--runs") ?? 1), opt("--only") ? Number(opt("--only")) : null, args.includes("--raw"));
    return;
  }
  const ri = args.indexOf("--receipt");
  if (ri >= 0) {
    const file = args[ri + 1];
    const img = await normalizeImage(new Uint8Array(readFileSync(file)), "image/jpeg");
    const t0 = Date.now();
    const caption = args[ri + 2] && !args[ri + 2].startsWith("--") ? args[ri + 2] : "";
    const { draft, usage, raw } = await parseReceipt({ b64: Buffer.from(img.bytes).toString("base64"), mime: img.mime }, caption, { ...ctx, currency: opt("--currency") ?? ctx.currency });
    console.log(JSON.stringify(raw, null, 1));
    console.log(JSON.stringify(draft, null, 1));
    const sum = (draft.items ?? []).reduce((s, i) => s + BigInt(i.amount ?? "0"), 0n) + (draft.adjustments ?? []).reduce((s, a) => s + BigInt(a.amount), 0n);
    console.log(`lines ${sum} vs receipt total ${draft.stated_total} (${sum.toString() === draft.stated_total ? "MATCH" : "MISMATCH"}) in ${Date.now() - t0} ms`, usage);
    return;
  }
  const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 1;
  const only = args.includes("--only") ? Number(args[args.indexOf("--only") + 1]) : null;
  const showRaw = args.includes("--raw");
  let pass = 0, total = 0, tokens = 0;
  for (const [i, [msg, want]] of CASES.entries()) {
    if (only !== null && only !== i + 1) continue;
    for (let r = 0; r < runs; r++) {
      total += 1;
      try {
        const { draft, usage, raw } = await parseChat(msg, ctx);
        tokens += usage.prompt_tokens + usage.completion_tokens;
        const bad = check(draft, want);
        if (!bad.length) pass += 1;
        console.log(`${bad.length ? "FAIL" : "ok  "} #${i + 1} ${msg}${bad.length ? "\n      " + bad.join("\n      ") : ""}`);
        if (bad.length && showRaw) console.log("      raw: " + JSON.stringify(raw));
      } catch (e) {
        console.log(`ERR  #${i + 1} ${msg}: ${e}`);
      }
    }
  }
  console.log(`\n${pass}/${total} passed, ${tokens} tokens`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
