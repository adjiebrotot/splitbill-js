/**
 * services/ai_parse.ts: chat messages and receipt photos -> a bill DRAFT.
 *
 * The models only READ: they copy names and numbers out of the message or the
 * receipt. Everything after that is deterministic code here: amounts are
 * evaluated exactly (amount_expr.ts / the engine's parseAmount), names are
 * matched to members, percents become basis points. The draft is never saved
 * as a bill; the person checks it in the same form and saves, and the server
 * validates it like any other bill.
 */
import { isCurrency, minorUnits, normCurrency, parseAmount, parsePercent, roundHalfEven } from "../engine";
import { fuzzyScore } from "../fuzzy";
import { cleanText, isDate, addDays } from "../utils";
import { exprToMinor } from "./amount_expr";
import { imageJson, textJson } from "./llm_client";
import type { MemberRow } from "./repo";

export interface DraftItem { name: string; qty: string; amount: string | null; members: string[] }
export interface DraftAdj { kind: "tax" | "service" | "tip" | "discount" | "other"; amount: string }
export interface Draft {
  description: string;
  date: string;
  currency: string;
  mode: "items" | "even" | "percent";
  payer: string;
  total?: string | null;
  stated_total?: string | null;
  items?: DraftItem[];
  adjustments?: DraftAdj[];
  participants?: { member: string; bp?: number }[];
  unknown: string[];
  source: "chat" | "photo" | "telegram";
}

export interface ParseCtx {
  members: MemberRow[];
  sender: string; // member id
  currency: string;
  today: string;
}

// ── prompts ─────────────────────────────────────────────────────────────────

export const CHAT_SYSTEM = `You read one message about ONE shared bill and fill a JSON form. You never do arithmetic.

Rules:
1. Amounts: copy the numbers the message uses into amount_expr / total_expr as plain digits, "." for decimals, no thousands separators. Expand shorthand: 60k -> 60000, 1.5jt or 1,5jt -> 1500000, 45rb -> 45000, "2 juta" -> 2000000. If the message shows math ("3 x 45rb"), copy the math: "3*45000". Never add, multiply or divide numbers yourself.
2. mode:
   - "items" when the message names things and who had them ("ice cream 10 for Ali, meal 15 for Ali Bob Cal"). One entry per thing, with the people who share it.
   - "even" when one amount is shared equally ("split evenly", "bagi rata", "for all of us"). Amount in total_expr, people in people.
   - "percent" when shares are percentages. Amount in total_expr, each person and percent in percents.
   One thing for one or more people, with no word about how to divide it, is "items" with one entry.
3. People: use the member names given. "me", "I", "my", "aku", "saya", "gue" mean the sender. "everyone", "all", "all of us", "semua", "kita" mean every member: list them all. A name that is not a member stays as written.
4. payer: who paid ("paid by Bob", "Bob paid", "dibayar Bob", "Bob bayar", "I paid"). null if not said.
5. Tax, service, tip, discount go in adjustments. A percent ("tax 11%") goes in percent as "11" with amount_expr null; an amount goes in amount_expr with percent null. A discount amount is written positive.
6. description: a short name for the bill in the message's language ("Lunch", "Makan malam"), not the whole message.
7. date: YYYY-MM-DD only if the message names a day ("yesterday" / "kemarin" = the day before today); else null.
8. currency: ISO code only if the message states or clearly implies one ("yen", "$", "Rp", "baht", "SGD"); else null.
Output only the JSON object.`;

const S_STR = { type: "string" };
const S_NSTR = { type: ["string", "null"] };
export const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "date", "currency", "payer", "mode", "total_expr", "people", "percents", "items", "adjustments"],
  properties: {
    description: S_STR,
    date: S_NSTR,
    currency: S_NSTR,
    payer: S_NSTR,
    mode: { type: "string", enum: ["items", "even", "percent"] },
    total_expr: S_NSTR,
    people: { type: "array", items: S_STR },
    percents: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "percent"], properties: { name: S_STR, percent: S_STR } },
    },
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "amount_expr", "people"],
        properties: { name: S_STR, amount_expr: S_STR, people: { type: "array", items: S_STR } },
      },
    },
    adjustments: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["kind", "amount_expr", "percent"],
        properties: { kind: { type: "string", enum: ["tax", "service", "tip", "discount", "other"] }, amount_expr: S_NSTR, percent: S_NSTR },
      },
    },
  },
};

export const RECEIPT_SYSTEM = `You read a photo of a receipt and copy what is printed. You never compute or correct numbers.
Return JSON:
{"merchant": string or null, "date": "YYYY-MM-DD" or null, "currency": ISO code or null,
 "items": [{"name": string, "qty": number, "amount": string}],
 "tax": string or null, "service": string or null, "discount": string or null, "tip": string or null,
 "total": string or null}
Rules:
1. amount is the printed line TOTAL for that item (not the unit price when a line total is printed). Copy the digits exactly as printed, including separators.
2. qty is the printed quantity, else 1.
3. Never list subtotal, total, tax, service, discount, rounding, cash, change, card or payment lines as items.
4. tax (PPN, PB1, VAT, GST, tax), service (service charge, SC), discount (diskon, promo, voucher): copy only the printed AMOUNT, without its label or percent; a discount as a positive number. total is the final amount to pay.
5. A value that is not printed is null. Never guess.
Output only the JSON.`;

export const ASSIGN_SYSTEM = `You assign receipt items to people using a short note from the person who took the photo.
Return JSON: {"payer": name or null, "default_people": [names], "assign": [{"item": number, "people": [names]}]}
Rules:
1. Use only what the note says. "item" is the item's number in the list.
2. "rest", "the rest", "sisanya", "everything else", "split evenly", "bagi rata" set default_people for items the note does not assign.
3. Names as in the member list. "me", "I", "aku", "saya" = the sender. "all", "everyone", "semua", "kita" = every member.
4. payer: who paid, if the note says so ("paid by Ali", "Ali bayar"), else null.
Output only the JSON.`;

// ── names ───────────────────────────────────────────────────────────────────

const ME = new Set(["me", "i", "my", "myself", "aku", "saya", "gue", "gw", "sender"]);
const ALL = new Set(["all", "everyone", "everybody", "all of us", "us", "semua", "semuanya", "kita", "kami"]);

export function resolveNames(raw: unknown, ctx: ParseCtx, unknown: Set<string>): string[] {
  const active = ctx.members.filter((m) => m.active);
  const out: string[] = [];
  const push = (id: string) => { if (!out.includes(id)) out.push(id); };
  for (const r of Array.isArray(raw) ? raw : []) {
    const n = String(r ?? "").trim().replace(/^@/, "");
    const k = n.toLowerCase();
    if (!k) continue;
    if (ME.has(k)) { push(ctx.sender); continue; }
    if (ALL.has(k)) { active.forEach((m) => push(m.id)); continue; }
    const exact = active.find((m) => m.name.toLowerCase() === k || (m.username ?? "").toLowerCase() === k);
    if (exact) { push(exact.id); continue; }
    let best: MemberRow | null = null;
    let bestScore = 0;
    let tie = false;
    for (const m of active) {
      const s = Math.max(fuzzyScore(k, m.name.toLowerCase()), m.username ? fuzzyScore(k, m.username.toLowerCase()) : 0);
      if (s > bestScore) { best = m; bestScore = s; tie = false; } else if (s === bestScore) tie = true;
    }
    if (best && bestScore >= 85 && !tie) push(best.id);
    else unknown.add(n);
  }
  return out;
}

// ── amounts ─────────────────────────────────────────────────────────────────

/** A number the model copied: plain numbers keep their separators' meaning. */
export function readAmount(raw: unknown, dp: number, allowZero = false): bigint | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  // "PB1 10% 60.375" or "Service 5% Rp 28.750": the amount is the LAST number.
  if (/[A-Za-z%]/.test(s.replace(/^(?:Rp\.?|IDR|USD|RM|SGD|S\$|US\$)\s*/i, ""))) {
    const nums = s.match(/\d[\d.,]*/g);
    if (!nums) return null;
    const last = nums[nums.length - 1];
    const before = s.slice(0, s.lastIndexOf(last)).trim();
    if (!/[x*×+\-/(]$/.test(before)) s = last;
  }
  // Receipts print discounts as "-$5.56" or "(5.56)": the sign lives in the kind.
  s = s.replace(/[()]/g, "").replace(/^[-\u2212]\s*/, "");
  s = s.replace(/(?:Rp\.?|IDR|USD|US\$|S\$|SGD|RM|\$|¥|€|£)/gi, "").replace(/\s/g, "").replace(/^[-\u2212]/, "");
  if (!s) return null;
  if (/^[\d.,]+$/.test(s)) {
    try {
      return parseAmount(s, dp, { allowZero });
    } catch {
      return null;
    }
  }
  return exprToMinor(s, dp, allowZero);
}

// ── chat ────────────────────────────────────────────────────────────────────

function _ctxText(ctx: ParseCtx): string {
  const me = ctx.members.find((m) => m.id === ctx.sender);
  return `Today: ${ctx.today}\nSender: ${me?.name ?? "me"}\nMembers: ${ctx.members.filter((m) => m.active).map((m) => m.name).join(", ")}\nDefault currency: ${ctx.currency}`;
}

function _date(v: unknown, today: string): string {
  const s = String(v ?? "");
  return isDate(s) && s <= addDays(today, 1) && s >= addDays(today, -400) ? s : today;
}

function _currency(v: unknown, fallback: string): string {
  const c = normCurrency(v);
  return isCurrency(c) ? c : fallback;
}

export function draftFromChat(parsed: any, ctx: ParseCtx, source: "chat" | "telegram" = "chat"): Draft {
  const unknown = new Set<string>();
  const currency = _currency(parsed?.currency, ctx.currency);
  const dp = minorUnits(currency);
  const payerIds = parsed?.payer ? resolveNames([parsed.payer], ctx, unknown) : [];
  const d: Draft = {
    description: cleanText(parsed?.description, 120) || "Bill",
    date: _date(parsed?.date, ctx.today),
    currency,
    mode: "items",
    payer: payerIds[0] ?? ctx.sender,
    unknown: [],
    source,
  };
  let mode = ["items", "even", "percent"].includes(parsed?.mode) ? parsed.mode : "items";
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  if (mode === "items" && !items.length && parsed?.total_expr) mode = "even";

  if (mode === "items") {
    const draftItems: DraftItem[] = items.slice(0, 100).map((it: any): DraftItem => {
      const amt = readAmount(it?.amount_expr, dp, true);
      let who = resolveNames(it?.people, ctx, unknown);
      if (!who.length && !(Array.isArray(it?.people) && it.people.length)) who = ctx.members.filter((m) => m.active).map((m) => m.id);
      return { name: cleanText(it?.name, 120) || "Item", qty: "1", amount: amt === null ? null : amt.toString(), members: who };
    });
    d.items = draftItems;
    const sub = draftItems.reduce((s, i) => s + (i.amount ? BigInt(i.amount) : 0n), 0n);
    d.adjustments = [];
    for (const a of Array.isArray(parsed?.adjustments) ? parsed.adjustments : []) {
      const kind = ["tax", "service", "tip", "discount", "other"].includes(a?.kind) ? a.kind : "other";
      let v: bigint | null = null;
      if (a?.percent) {
        try { v = roundHalfEven(sub * BigInt(parsePercent(a.percent)), 10000n); } catch { v = null; }
      } else v = readAmount(a?.amount_expr, dp);
      if (v === null || v === 0n) continue;
      d.adjustments.push({ kind, amount: (kind === "discount" ? -v : v).toString() });
    }
  } else {
    const total = readAmount(parsed?.total_expr, dp);
    d.total = total === null ? null : total.toString();
    if (mode === "even") {
      let who = resolveNames(parsed?.people, ctx, unknown);
      if (!who.length && !(Array.isArray(parsed?.people) && parsed.people.length)) who = ctx.members.filter((m) => m.active).map((m) => m.id);
      d.participants = who.map((member) => ({ member }));
    } else {
      d.participants = [];
      for (const p of Array.isArray(parsed?.percents) ? parsed.percents : []) {
        const [id] = resolveNames([p?.name], ctx, unknown);
        let bp = 0;
        try { bp = parsePercent(p?.percent); } catch { bp = 0; }
        if (id && bp > 0 && !d.participants.some((x) => x.member === id)) d.participants.push({ member: id, bp });
      }
    }
  }
  d.mode = mode;
  d.unknown = [...unknown];
  return d;
}

export async function parseChat(text: string, ctx: ParseCtx, source: "chat" | "telegram" = "chat") {
  const user = `${_ctxText(ctx)}\nMessage: ${text.slice(0, 2000)}`;
  const [parsed, usage] = await textJson(CHAT_SYSTEM, user, {
    schema: CHAT_SCHEMA,
    validate: (p) => p && typeof p === "object" && typeof p.mode === "string",
  });
  return { draft: draftFromChat(parsed, ctx, source), usage, raw: parsed };
}

// ── photo ───────────────────────────────────────────────────────────────────

export function draftFromReceipt(rec: any, assign: any, ctx: ParseCtx, source: "photo" | "telegram" = "photo"): Draft {
  const unknown = new Set<string>();
  const currency = _currency(rec?.currency, ctx.currency);
  const dp = minorUnits(currency);
  const everyone = ctx.members.filter((m) => m.active).map((m) => m.id);
  const byItem = new Map<number, string[]>();
  for (const a of Array.isArray(assign?.assign) ? assign.assign : []) {
    const n = Number(a?.item);
    if (Number.isInteger(n)) byItem.set(n, resolveNames(a?.people, ctx, unknown));
  }
  const fallback = assign?.default_people?.length ? resolveNames(assign.default_people, ctx, unknown) : (assign ? [] : everyone);
  const items: DraftItem[] = (Array.isArray(rec?.items) ? rec.items : []).slice(0, 150).map((it: any, i: number) => {
    const amt = readAmount(it?.amount, dp, true);
    const qty = Number(it?.qty);
    const q = Number.isFinite(qty) && qty > 0 && qty < 1e6 ? String(Math.round(qty * 1000) / 1000) : "1";
    return {
      name: cleanText(it?.name, 120) || `#${i + 1}`,
      qty: q,
      amount: amt === null ? null : amt.toString(),
      members: byItem.get(i + 1) ?? (assign ? fallback : everyone),
    };
  });
  const adjustments: DraftAdj[] = [];
  for (const kind of ["tax", "service", "tip", "discount"] as const) {
    const v = readAmount(rec?.[kind], dp);
    if (v !== null && v > 0n) adjustments.push({ kind, amount: (kind === "discount" ? -v : v).toString() });
  }
  const total = readAmount(rec?.total, dp);
  const payer = assign?.payer ? resolveNames([assign.payer], ctx, unknown)[0] : undefined;
  return {
    description: cleanText(rec?.merchant, 120) || "Receipt",
    date: _date(rec?.date, ctx.today),
    currency,
    mode: "items",
    payer: payer ?? ctx.sender,
    items,
    adjustments,
    stated_total: total === null ? null : total.toString(),
    unknown: [...unknown],
    source,
  };
}

export async function parseReceipt(image: { b64: string; mime: string }, caption: string, ctx: ParseCtx, source: "photo" | "telegram" = "photo") {
  const [rec, u1] = await imageJson(RECEIPT_SYSTEM, image, "Read this receipt.", {
    validate: (p) => p && typeof p === "object" && Array.isArray(p.items),
  });
  let assign: any = null;
  let u2 = null;
  const note = caption.trim();
  if (note && Array.isArray(rec.items) && rec.items.length) {
    const list = rec.items.map((it: any, i: number) => `${i + 1}. ${String(it?.name ?? "").slice(0, 60)}`).join("\n");
    [assign, u2] = await textJson(ASSIGN_SYSTEM, `${_ctxText(ctx)}\nItems:\n${list}\nNote: ${note.slice(0, 500)}`, {
      validate: (p) => p && typeof p === "object",
    });
  }
  return { draft: draftFromReceipt(rec, assign, ctx, source), usage: [u1, u2].filter(Boolean), raw: { receipt: rec, assign } };
}
