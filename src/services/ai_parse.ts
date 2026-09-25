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

/**
 * `unknown`: names on this line that match no member, kept so the form can add
 * that person and put them back on the line in one tap (the code never
 * creates a member). `everyone`: the line is for everybody (said "all", or
 * named nobody), so a person added later joins it too.
 */
export interface DraftItem { name: string; qty: string; amount: string | null; members: string[]; unknown?: string[]; everyone?: boolean }
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
  /** Where the unmatched names go, as DraftItem.unknown / everyone do for a line. */
  payer_unknown?: string;
  participants_unknown?: { name: string; bp?: number }[];
  participants_everyone?: boolean;
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
   When each person has their own amount ("Ali 100k, Bob 200k"), use "items" with one entry per person, named after the person, with that person's amount. Do not also add an entry for the total.
3. People: list only the people the message names for that thing; do not add others. Use the member names given. "me", "I", "my", "aku", "saya", "gue" mean the sender. "everyone", "all", "all of us", "semua", "kita" mean every member: list them all. A name that is not a member stays as written.
4. payer: who paid ("paid by Bob", "Bob paid", "dibayar Bob", "Bob bayar", "I paid"). null if not said.
5. Tax, service, tip, discount go in adjustments, never in items. A percent ("tax 11%") goes in percent as "11" with amount_expr null; an amount goes in amount_expr with percent null. A discount amount is written positive.
6. description: a short name for the bill in the message's language ("Lunch", "Makan malam"), not the whole message.
7. Day: if the message says how many days ago ("yesterday" / "kemarin" = 1, "2 days ago" / "2 hari lalu" / "kemarin lusa" = 2, "today" / "hari ini" = 0), put that number in days_ago and date null. If it names a calendar date ("20 Sept", "2026-09-20"), put it in date as YYYY-MM-DD and days_ago null. Otherwise both null.
8. currency: ISO code only if the message states or clearly implies one ("$" = USD, "yen" = JPY, "Rp" = IDR, "baht" = THB, "SGD"); else null.
Output only the JSON object.`;

const S_STR = { type: "string" };
const S_NSTR = { type: ["string", "null"] };
export const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "date", "days_ago", "currency", "payer", "mode", "total_expr", "people", "percents", "items", "adjustments"],
  properties: {
    description: S_STR,
    date: S_NSTR,
    days_ago: { type: ["integer", "null"] },
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
{"rows": [string], "merchant": string or null, "country": string or null, "date": "YYYY-MM-DD" or null, "currency": ISO code or null,
 "items": [{"name": string, "qty": number, "amount": string}],
 "tax": string or null, "service": string or null, "discount": string or null, "tip": string or null,
 "rounding": string or null, "total": string or null}
Rules:
0. First fill rows: copy every printed line of the item list (from the first item down to the subtotal), exactly as printed, one string per printed line, top to bottom. Then build items from rows.
1. amount is the printed line TOTAL for that item (not the unit price when a line total is printed). Copy the digits exactly as printed, including separators.
2. qty is the printed quantity, else 1.
3. A name can wrap onto the next line. A line with no amount of its own (e.g. "Black Pepper Sauce" under "Beef Steak 85,000") is part of the item above: join it to that name. Each printed amount belongs to exactly one item, in printed order: never copy an amount twice and never move an amount to another item.
4. Never list subtotal, total, tax, service, discount, rounding, cash, change, card, payment lines or kitchen notes as items.
5. tax (PPN, PB1, PJK, PJK RST, pajak, VAT, GST, tax), service (service charge, SC, service/packaging fee), discount (diskon, promo, voucher, line discount): copy only the printed AMOUNT, without its label or percent; a discount as a positive number. When several discount lines and a discount total are printed, copy the discount total. rounding (pembulatan, rounding, round off): copy the amount WITH its printed sign ("-11"). total is the final amount to pay.
6. country: the country of the address or tax number printed, else null. currency: the ISO code of the printed money. A bare "$" or "¥" depends on the country (Singapore "$" = SGD, United States "$" = USD, Hong Kong "$" = HKD, China "¥" = CNY, Japan "¥" = JPY); when the country is unclear, currency is null.
7. A value that is not printed is null. Never guess.
Output only the JSON.`;

export const ASSIGN_SYSTEM = `You assign receipt items to people using a short note from the person who took the photo.
Return JSON: {"payer": name or null, "default_people": [names], "assign": [{"item": number, "people": [names]}]}
Rules:
1. Use only what the note says. "item" is the item's number in the list. Receipt names are often short or abbreviated ("Chkn" = chicken, "Bf" = beef, "Mlk" = milk): match the note's words to the item they clearly name, never to a different item. Leave out items the note does not name; never give an item an empty people list.
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

/** resolveNames, plus the names it could not match on THIS list. */
function _resolve(raw: unknown, ctx: ParseCtx, unknown: Set<string>): { ids: string[]; missing: string[] } {
  const here = new Set<string>();
  const ids = resolveNames(raw, ctx, here);
  here.forEach((n) => unknown.add(n));
  return { ids, missing: [...here] };
}

/** A people list that means "everybody": it says so, or names nobody. */
function _saysAll(raw: unknown): boolean {
  const list = Array.isArray(raw) ? raw : [];
  return !list.length || list.some((r) => ALL.has(String(r ?? "").trim().replace(/^@/, "").toLowerCase()));
}

/** Optional draft fields stay off the draft when empty. */
function _line(it: DraftItem, missing: string[], everyone: boolean): DraftItem {
  if (missing.length) it.unknown = missing;
  if (everyone) it.everyone = true;
  return it;
}

/**
 * Members the message itself mentions, to check the model's people lists.
 * Null means "do not filter": the message says everyone ("all", "semua"),
 * or names nobody besides the payer. The sender is always allowed ("with
 * Bob" includes me).
 * A loose match only keeps more people, so it errs on the safe side.
 */
const PAYER_PHRASES = [
  /\b(?:paid by|dibayar(?:in)?(?:\s+(?:oleh|sama|ama))?|ditraktir(?:\s+oleh)?)\s+@?[\p{L}\p{N}_]+/giu,
  /@?[\p{L}\p{N}_]+\s+(?:(?:yang|yg)\s+)?(?:paid|pays|bayar|bayarin|traktir|nalangin)\b/giu,
];

export function mentionedIds(text: string, ctx: ParseCtx): Set<string> | null {
  // "Bob paid" names the payer, not someone who shares the bill.
  const low = PAYER_PHRASES.reduce((t, re) => t.replace(re, " "), text.toLowerCase());
  const words = low.split(/[^\p{L}\p{N}@_]+/u).map((w) => w.replace(/^@/, "")).filter(Boolean);
  if (words.some((w) => ALL.has(w)) || /\ball of us\b/.test(low)) return null;
  const out = new Set<string>([ctx.sender]);
  let named = words.some((w) => ME.has(w));
  for (const m of ctx.members) {
    const names = [m.name.toLowerCase(), (m.username ?? "").toLowerCase()].filter(Boolean);
    const hit = names.some((n) => low.includes(n) || words.some((w) => w.length >= 3 && fuzzyScore(w, n) >= 85));
    if (hit) { out.add(m.id); named = true; }
  }
  return named ? out : null;
}

function _onlyMentioned(ids: string[], keep: Set<string> | null): string[] {
  if (!keep) return ids;
  const kept = ids.filter((id) => keep.has(id));
  return kept.length ? kept : ids;
}

const ADJ_WORD: [RegExp, DraftAdj["kind"]][] = [
  [/^(discount|diskon|disc|promo|voucher|potongan)\b/i, "discount"],
  [/^(tax|pajak|ppn|pb1|vat|gst)\b/i, "tax"],
  [/^(service|servis|layanan|sc)\b/i, "service"],
  [/^(tip|tips)\b/i, "tip"],
];

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

/** The model copies "2 hari lalu" as days_ago: 2; the date math is ours. */
function _chatDate(parsed: any, today: string): string {
  const n = parsed?.days_ago;
  if (Number.isInteger(n) && n >= 0 && n <= 400) return addDays(today, -n);
  return _date(parsed?.date, today);
}

function _currency(v: unknown, fallback: string): string {
  const c = normCurrency(v);
  return isCurrency(c) ? c : fallback;
}

const DOLLARS = new Set(["USD", "SGD", "AUD", "NZD", "CAD", "HKD", "TWD", "BND", "FJD"]);
const SYMBOLS: [RegExp, string][] = [
  [/US\$/, "USD"], [/S\$/, "SGD"], [/A\$/, "AUD"], [/NZ\$/, "NZD"], [/HK\$/, "HKD"],
  [/\bRp\.?\s?\d/i, "IDR"], [/\bRM\s?\d/, "MYR"], [/€/, "EUR"], [/£/, "GBP"], [/₩/, "KRW"], [/฿/, "THB"], [/₱/, "PHP"], [/₫/, "VND"],
];

/**
 * A currency the message itself shows ("$15", "S$20", "120 SGD", "Rp 25.000").
 * Code reads it so a model that forgets the symbol cannot turn 15 USD into
 * 15 IDR. Null unless exactly one currency is shown.
 */
export function currencyInText(text: string, groupCurrency: string): string | null {
  const found = new Set<string>();
  let rest = text;
  for (const [re, code] of SYMBOLS) {
    if (re.test(rest)) { found.add(code); rest = rest.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), " "); }
  }
  if (/\$/.test(rest)) found.add(DOLLARS.has(groupCurrency) ? groupCurrency : "USD");
  for (const m of text.matchAll(/\b([A-Z]{3})\s?\d|\d\s?([A-Z]{3})\b/g)) {
    const c = m[1] ?? m[2];
    if (isCurrency(c)) found.add(c);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function draftFromChat(parsed: any, ctx: ParseCtx, source: "chat" | "telegram" = "chat", text = ""): Draft {
  const unknown = new Set<string>();
  const currency = currencyInText(text, ctx.currency) ?? _currency(parsed?.currency, ctx.currency);
  const dp = minorUnits(currency);
  const payerR = parsed?.payer ? _resolve([parsed.payer], ctx, unknown) : { ids: [], missing: [] };
  const d: Draft = {
    description: cleanText(parsed?.description, 120) || "Bill",
    date: _chatDate(parsed, ctx.today),
    currency,
    mode: "items",
    payer: payerR.ids[0] ?? ctx.sender,
    unknown: [],
    source,
  };
  if (!payerR.ids.length && payerR.missing.length) d.payer_unknown = payerR.missing[0];
  let mode = ["items", "even", "percent"].includes(parsed?.mode) ? parsed.mode : "items";
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  if (mode === "items" && !items.length && parsed?.total_expr) mode = "even";

  const keep = text ? mentionedIds(text, ctx) : null;
  if (mode === "items") {
    const adjKinds = new Set((Array.isArray(parsed?.adjustments) ? parsed.adjustments : []).map((a: any) => a?.kind));
    let draftItems: DraftItem[] = items.slice(0, 100)
      // A discount or tax the model listed as an item AND as an adjustment would count twice.
      .filter((it: any) => !ADJ_WORD.some(([re, kind]) => re.test(String(it?.name ?? "").trim()) && adjKinds.has(kind)))
      .map((it: any): DraftItem => {
        const amt = readAmount(it?.amount_expr, dp, true);
        const r = _resolve(it?.people, ctx, unknown);
        let who = _onlyMentioned(r.ids, keep);
        if (!who.length && !(Array.isArray(it?.people) && it.people.length)) who = ctx.members.filter((m) => m.active).map((m) => m.id);
        const item = { name: cleanText(it?.name, 120) || "Item", qty: "1", amount: amt === null ? null : amt.toString(), members: who };
        return _line(item, r.missing, _saysAll(it?.people));
      });
    draftItems = _dropRestatedTotal(draftItems, ctx).filter((it) => it.amount !== null || !_isPersonLine(it, ctx));
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
      const r = _resolve(parsed?.people, ctx, unknown);
      let who = _onlyMentioned(r.ids, keep);
      if (!who.length && !(Array.isArray(parsed?.people) && parsed.people.length)) who = ctx.members.filter((m) => m.active).map((m) => m.id);
      d.participants = who.map((member) => ({ member }));
      if (r.missing.length) d.participants_unknown = r.missing.map((name) => ({ name }));
      if (_saysAll(parsed?.people)) d.participants_everyone = true;
    } else {
      d.participants = [];
      const missing: { name: string; bp: number }[] = [];
      for (const p of Array.isArray(parsed?.percents) ? parsed.percents : []) {
        const r = _resolve([p?.name], ctx, unknown);
        const id = r.ids[0];
        let bp = 0;
        try { bp = parsePercent(p?.percent); } catch { bp = 0; }
        if (id && bp > 0 && !d.participants.some((x) => x.member === id)) d.participants.push({ member: id, bp });
        else if (!id && r.missing.length && bp > 0 && !missing.some((x) => x.name === r.missing[0])) missing.push({ name: r.missing[0], bp });
      }
      if (missing.length) d.participants_unknown = missing;
    }
  }
  d.mode = mode;
  d.unknown = [...unknown];
  return d;
}

/**
 * "Dinner 300k, Ali 100k Bob 200k": when every other item is one person's own
 * amount (named after that person), an item equal to their sum is the bill
 * total said again, not a third thing to split.
 */
/** A line named after the one member it belongs to ("Ali 100k"). An empty one is noise. */
function _isPersonLine(it: DraftItem, ctx: ParseCtx): boolean {
  return it.members.length === 1 && ctx.members.some((m) => m.id === it.members[0] && m.name.toLowerCase() === it.name.toLowerCase());
}

function _dropRestatedTotal(items: DraftItem[], ctx: ParseCtx): DraftItem[] {
  if (items.length < 3) return items;
  const isPerson = (it: DraftItem) => _isPersonLine(it, ctx);
  const persons = items.filter(isPerson);
  const rest = items.filter((it) => !isPerson(it));
  if (rest.length !== 1 || persons.length < 2 || !rest[0].amount) return items;
  const sum = persons.reduce((s, it) => s + (it.amount ? BigInt(it.amount) : 0n), 0n);
  return BigInt(rest[0].amount) === sum ? persons : items;
}

export async function parseChat(text: string, ctx: ParseCtx, source: "chat" | "telegram" = "chat") {
  const user = `${_ctxText(ctx)}\nMessage: ${text.slice(0, 2000)}`;
  const [parsed, usage] = await textJson(CHAT_SYSTEM, user, {
    schema: CHAT_SCHEMA,
    validate: (p) => p && typeof p === "object" && typeof p.mode === "string",
  });
  return { draft: draftFromChat(parsed, ctx, source, text), usage, raw: parsed };
}

// ── photo ───────────────────────────────────────────────────────────────────

export function draftFromReceipt(rec: any, assign: any, ctx: ParseCtx, source: "photo" | "telegram" = "photo"): Draft {
  const unknown = new Set<string>();
  const currency = _currency(rec?.currency, ctx.currency);
  const dp = minorUnits(currency);
  const everyone = ctx.members.filter((m) => m.active).map((m) => m.id);
  const byItem = new Map<number, { ids: string[]; missing: string[]; all: boolean }>();
  for (const a of Array.isArray(assign?.assign) ? assign.assign : []) {
    const n = Number(a?.item);
    // An empty list is "not said", so the item falls back to the default people.
    if (Number.isInteger(n) && Array.isArray(a?.people) && a.people.length) byItem.set(n, { ..._resolve(a.people, ctx, unknown), all: _saysAll(a.people) });
  }
  // No note: every line is everybody's. A note that names nobody for a line leaves it empty.
  const fallback = assign?.default_people?.length
    ? { ..._resolve(assign.default_people, ctx, unknown), all: _saysAll(assign.default_people) }
    : { ids: assign ? [] : everyone, missing: [] as string[], all: !assign };
  const items: DraftItem[] = (Array.isArray(rec?.items) ? rec.items : []).slice(0, 150).map((it: any, i: number) => {
    const amt = readAmount(it?.amount, dp, true);
    const qty = Number(it?.qty);
    const q = Number.isFinite(qty) && qty > 0 && qty < 1e6 ? String(Math.round(qty * 1000) / 1000) : "1";
    const who = byItem.get(i + 1) ?? fallback;
    return _line({
      name: cleanText(it?.name, 120) || `#${i + 1}`,
      qty: q,
      amount: amt === null ? null : amt.toString(),
      members: who.ids,
    }, who.missing, who.all);
  });
  const adjustments: DraftAdj[] = [];
  for (const kind of ["tax", "service", "tip", "discount"] as const) {
    const v = readAmount(rec?.[kind], dp);
    if (v !== null && v > 0n) adjustments.push({ kind, amount: (kind === "discount" ? -v : v).toString() });
  }
  // Rounding keeps its printed sign ("Pembulatan -11"); it is an "other" line.
  const rnd = readAmount(rec?.rounding, dp);
  if (rnd !== null && rnd > 0n) adjustments.push({ kind: "other", amount: (/^[^\d]*[-\u2212(]/.test(String(rec.rounding)) ? -rnd : rnd).toString() });
  const total = readAmount(rec?.total, dp);
  const payerR = assign?.payer ? _resolve([assign.payer], ctx, unknown) : { ids: [], missing: [] };
  const d: Draft = {
    description: cleanText(rec?.merchant, 120) || "Receipt",
    date: _date(rec?.date, ctx.today),
    currency,
    mode: "items",
    payer: payerR.ids[0] ?? ctx.sender,
    items,
    adjustments,
    stated_total: total === null ? null : total.toString(),
    unknown: [...unknown],
    source,
  };
  if (!payerR.ids.length && payerR.missing.length) d.payer_unknown = payerR.missing[0];
  return d;
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
    // The receipt is already read: a slow or failed note step must not throw it
    // away. The draft then gives every item to everyone and the person fixes it.
    try {
      [assign, u2] = await textJson(ASSIGN_SYSTEM, `${_ctxText(ctx)}\nItems:\n${list}\nNote: ${note.slice(0, 500)}`, {
        timeoutMs: 15000,
        validate: (p) => p && typeof p === "object",
      });
    } catch {
      assign = null;
    }
  }
  return { draft: draftFromReceipt(rec, assign, ctx, source), usage: [u1, u2].filter(Boolean), raw: { receipt: rec, assign } };
}
