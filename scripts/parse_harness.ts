/**
 * parse_harness.ts: how well the AI reads bills, measured against the live
 * model (costs real money; needs LLM_API_KEY). Each case is a chat message
 * with the draft it must produce; a case passes when the deterministic draft
 * matches exactly (amounts in minor units, members, mode, payer).
 *
 *   LLM_API_KEY=... npx tsx scripts/parse_harness.ts [--runs 3] [--only 4]
 *   LLM_API_KEY=... npx tsx scripts/parse_harness.ts --receipt path/to/receipt.jpg ["caption"]
 */
import { readFileSync } from "node:fs";
import { parseChat, parseReceipt, type ParseCtx } from "../src/services/ai_parse";
import { normalizeImage } from "../src/services/llm_client";

const members = ["Ali", "Bob", "Cal", "Don"].map((name, i) => ({ id: String(i + 1), name, user_id: null, username: null, position: i + 1, active: true }));
const ctx: ParseCtx = { members, sender: "1", currency: "IDR", today: "2026-09-23" };
const id = (n: string) => String(members.findIndex((m) => m.name === n) + 1);

type Want = { mode: string; payer: string; total?: string; items?: [string, string[]][]; adj?: string[]; people?: string[]; bp?: [string, number][]; currency?: string; date?: string };
const CASES: [string, Want][] = [
  ["Ice cream 10 for Ali paid by Bob, in USD", { mode: "items", payer: "Bob", currency: "USD", items: [["1000", ["Ali"]]] }],
  ["Meal $15 for Ali, Bob, Cal paid by Don", { mode: "items", payer: "Don", currency: "USD", items: [["1500", ["Ali", "Bob", "Cal"]]] }],
  ["Lunch 60k for me, Bob and Cal, I paid, split evenly", { mode: "even", payer: "Ali", total: "60000", people: ["Ali", "Bob", "Cal"] }],
  ["Lunch 60rb dibayar Ali, Ali 50%, Bob 25%, Cal 25%", { mode: "percent", payer: "Ali", total: "60000", bp: [["Ali", 5000], ["Bob", 2500], ["Cal", 2500]] }],
  ["makan malam 1,2jt bagi rata semua, Bob yang bayar", { mode: "even", payer: "Bob", total: "1200000", people: ["Ali", "Bob", "Cal", "Don"] }],
  ["Taxi 3 x 45rb for Cal and Don, paid by Cal", { mode: "items", payer: "Cal", items: [["135000", ["Cal", "Don"]]] }],
  ["Dinner: nasi goreng 35000 Ali, mie 30000 Bob, es teh 2x8000 Ali Bob, tax 10%, I paid", { mode: "items", payer: "Ali", items: [["35000", ["Ali"]], ["30000", ["Bob"]], ["16000", ["Ali", "Bob"]]], adj: ["8100"] }],
  ["kemarin bensin 200rb dibayar Don buat Don dan Cal", { mode: "items", payer: "Don", date: "2026-09-22", items: [["200000", ["Don", "Cal"]]] }],
];

function check(d: any, w: Want): string[] {
  const bad: string[] = [];
  const eq = (k: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${k}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
  eq("mode", d.mode, w.mode);
  eq("payer", d.payer, id(w.payer));
  if (w.currency) eq("currency", d.currency, w.currency);
  if (w.date) eq("date", d.date, w.date);
  if (w.total) eq("total", d.total, w.total);
  if (w.items) eq("items", (d.items ?? []).map((i: any) => [i.amount, [...i.members].sort()]), w.items.map(([a, ms]) => [a, ms.map(id).sort()]));
  if (w.adj) eq("adjustments", (d.adjustments ?? []).map((a: any) => a.amount), w.adj);
  if (w.people) eq("people", (d.participants ?? []).map((p: any) => p.member).sort(), w.people.map(id).sort());
  if (w.bp) eq("percents", (d.participants ?? []).map((p: any) => [p.member, p.bp]).sort(), w.bp.map(([n, b]) => [id(n), b]).sort());
  return bad;
}

async function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--receipt");
  if (ri >= 0) {
    const file = args[ri + 1];
    const img = await normalizeImage(new Uint8Array(readFileSync(file)), "image/jpeg");
    const t0 = Date.now();
    const { draft, usage, raw } = await parseReceipt({ b64: Buffer.from(img.bytes).toString("base64"), mime: img.mime }, args[ri + 2] ?? "", ctx);
    console.log(JSON.stringify(raw, null, 1));
    console.log(JSON.stringify(draft, null, 1));
    const sum = (draft.items ?? []).reduce((s, i) => s + BigInt(i.amount ?? "0"), 0n) + (draft.adjustments ?? []).reduce((s, a) => s + BigInt(a.amount), 0n);
    console.log(`lines ${sum} vs receipt total ${draft.stated_total} (${sum.toString() === draft.stated_total ? "MATCH" : "MISMATCH"}) in ${Date.now() - t0} ms`, usage);
    return;
  }
  const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 1;
  const only = args.includes("--only") ? Number(args[args.indexOf("--only") + 1]) : null;
  let pass = 0, total = 0, tokens = 0;
  for (const [i, [msg, want]] of CASES.entries()) {
    if (only !== null && only !== i + 1) continue;
    for (let r = 0; r < runs; r++) {
      total += 1;
      try {
        const { draft, usage } = await parseChat(msg, ctx);
        tokens += usage.prompt_tokens + usage.completion_tokens;
        const bad = check(draft, want);
        if (!bad.length) pass += 1;
        console.log(`${bad.length ? "FAIL" : "ok  "} #${i + 1} ${msg}${bad.length ? "\n      " + bad.join("\n      ") : ""}`);
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
