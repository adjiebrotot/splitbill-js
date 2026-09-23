/**
 * engine/allocate.ts — who owes what for ONE bill. Pure and deterministic.
 *
 * Three split modes, one rounding rule:
 *
 *   1. Each participant's EXACT share s_m is a fraction that sums to the total
 *      exactly (items: T * sub_m / itemsSubtotal, which carries tax / service /
 *      discount in proportion to the items; even: T / n; percent: T * bp / 10000).
 *   2. Every share is floored ONCE, per member, per bill. Flooring per item or
 *      per adjustment and summing is the classic way a split stops adding up.
 *   3. The leftover L = T - sum(floors) is always < the number of fractional
 *      shares. It goes to the payer when the payer is in the split, so nobody
 *      owes the payer a rounding cent. Otherwise 1 unit each, in join order, to
 *      members whose exact share had a fraction; nobody whose share was already
 *      whole gets bumped.
 *
 * Conversion to the settlement currency reuses the same rule on the ROUNDED
 * bill-currency shares (c_m ~ C * x_m / T), so "3.33 x 16,000" is what a person
 * checking by hand gets, within one minor unit.
 */

import { fail } from "./errors";
import { floorDiv, frac, lcm, pow10, roundHalfEven, type Frac } from "./rational";
import { MAX_MINOR } from "./amount";

export type Mode = "items" | "even" | "percent";
export type AdjKind = "tax" | "service" | "tip" | "discount" | "other";
export const ADJ_KINDS: readonly AdjKind[] = ["tax", "service", "tip", "discount", "other"];

export interface ItemIn {
  name?: string;
  amount: bigint;
  members: string[];
}

export interface AdjIn {
  kind: AdjKind;
  /** Signed: a discount is negative, everything else positive ("other" either). */
  amount: bigint;
}

export interface PartIn {
  member: string;
  /** Percent mode only: basis points, 1..10000. */
  bp?: number;
}

export interface BillIn {
  payer: string;
  mode: Mode;
  /** Even / percent: the total. Items: derived, must be omitted or equal. */
  total?: bigint;
  items?: ItemIn[];
  adjustments?: AdjIn[];
  participants?: PartIn[];
}

/** Join position per member id. Every member a bill mentions must be here. */
export type Order = ReadonlyMap<string, number>;

export interface Allocation {
  total: bigint;
  /** Items mode: sum of item lines before adjustments. */
  itemsSubtotal: bigint | null;
  /** Exact share per participant (s_m > 0 only). */
  exact: Map<string, Frac>;
  /** Rounded bill-currency share per participant; sums to `total`. */
  shares: Map<string, bigint>;
  payerInSplit: boolean;
}

function _byOrder(order: Order) {
  return (a: string, b: string) => {
    const pa = order.get(a)!;
    const pb = order.get(b)!;
    return pa !== pb ? pa - pb : a < b ? -1 : a > b ? 1 : 0;
  };
}

function _known(order: Order, id: string, code: string, params: Record<string, string | number> = {}): void {
  if (!order.has(id)) fail(code, { member: id, ...params });
}

/** Sum of item lines plus adjustments: the total an items-mode bill derives. */
export function itemsTotal(items: readonly ItemIn[] = [], adjustments: readonly AdjIn[] = []): bigint {
  let t = 0n;
  for (const it of items) t += it.amount;
  for (const a of adjustments) t += a.amount;
  return t;
}

/**
 * Split `total` by exact fractions with the leftover rule. Exposed for the
 * conversion step and for tests; `exacts` must sum to `total` exactly.
 */
export function distribute(total: bigint, exacts: ReadonlyMap<string, Frac>, payer: string, payerInSplit: boolean, order: Order): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let sumNum = 0n;
  let commonDen = 1n;
  for (const f of exacts.values()) commonDen = lcm(commonDen, f.den);
  let floors = 0n;
  const fractional: string[] = [];
  for (const [id, f] of exacts) {
    sumNum += f.num * (commonDen / f.den);
    const x = floorDiv(f.num, f.den);
    out.set(id, x);
    floors += x;
    if (f.num % f.den !== 0n) fractional.push(id);
  }
  if (sumNum !== total * commonDen) fail("internal_exact_sum");
  let left = total - floors;
  if (left < 0n) fail("internal_leftover");
  if (left === 0n) return out;
  if (payerInSplit) {
    out.set(payer, (out.get(payer) ?? 0n) + left);
    return out;
  }
  fractional.sort(_byOrder(order));
  if (left > BigInt(fractional.length)) fail("internal_leftover");
  for (const id of fractional) {
    if (left === 0n) break;
    out.set(id, out.get(id)! + 1n);
    left -= 1n;
  }
  return out;
}

/** Validate a bill and compute its allocation in the bill currency. */
export function allocate(bill: BillIn, order: Order): Allocation {
  if (!bill || typeof bill !== "object") fail("bill_invalid");
  _known(order, bill.payer, "payer_unknown");
  const mode = bill.mode;
  const exact = new Map<string, Frac>();
  let total: bigint;
  let itemsSubtotal: bigint | null = null;

  if (mode === "items") {
    const items = bill.items ?? [];
    const adjustments = bill.adjustments ?? [];
    if (bill.participants && bill.participants.length) fail("participants_not_allowed");
    if (!items.length) fail("items_empty");
    let sub = 0n;
    let den = 1n;
    items.forEach((it, i) => {
      if (typeof it.amount !== "bigint") fail("item_invalid", { index: i + 1 });
      if (it.amount < 0n) fail("item_negative", { index: i + 1 });
      if (it.amount > MAX_MINOR) fail("amount_too_large");
      const members = it.members ?? [];
      if (new Set(members).size !== members.length) fail("item_duplicate_member", { index: i + 1 });
      for (const m of members) _known(order, m, "member_unknown", { index: i + 1 });
      if (it.amount === 0n) return;
      if (!members.length) fail("item_unassigned", { index: i + 1, name: it.name ?? "" });
      sub += it.amount;
      den = lcm(den, BigInt(members.length));
    });
    if (sub <= 0n) fail("items_subtotal_zero");
    adjustments.forEach((a, i) => {
      if (typeof a.amount !== "bigint" || !ADJ_KINDS.includes(a.kind)) fail("adjustment_invalid", { index: i + 1 });
      if (a.amount === 0n) fail("adjustment_zero", { index: i + 1 });
      if (a.kind === "discount" && a.amount > 0n) fail("adjustment_sign", { index: i + 1 });
      if ((a.kind === "tax" || a.kind === "service" || a.kind === "tip") && a.amount < 0n) fail("adjustment_sign", { index: i + 1 });
    });
    total = itemsTotal(items, adjustments);
    if (bill.total !== undefined && bill.total !== total) fail("total_mismatch", { diff: (bill.total - total).toString() });
    if (total <= 0n) fail("total_not_positive");
    if (total > MAX_MINOR) fail("amount_too_large");
    itemsSubtotal = sub;
    // W_m = sum over the member's items of amount * (den / k); sum W_m = sub * den.
    const weight = new Map<string, bigint>();
    for (const it of items) {
      if (it.amount === 0n) continue;
      const per = it.amount * (den / BigInt(it.members.length));
      for (const m of it.members) weight.set(m, (weight.get(m) ?? 0n) + per);
    }
    for (const [m, w] of weight) if (w > 0n) exact.set(m, frac(total * w, sub * den));
  } else if (mode === "even" || mode === "percent") {
    if ((bill.items && bill.items.length) || (bill.adjustments && bill.adjustments.length)) fail("adjustments_not_allowed");
    const parts = bill.participants ?? [];
    if (!parts.length) fail("participants_empty");
    if (typeof bill.total !== "bigint") fail("total_invalid");
    total = bill.total;
    if (total <= 0n) fail("total_not_positive");
    if (total > MAX_MINOR) fail("amount_too_large");
    const seen = new Set<string>();
    for (const p of parts) {
      _known(order, p.member, "member_unknown");
      if (seen.has(p.member)) fail("participant_duplicate", { member: p.member });
      seen.add(p.member);
    }
    if (mode === "even") {
      const n = BigInt(parts.length);
      for (const p of parts) exact.set(p.member, frac(total, n));
    } else {
      let sum = 0;
      for (const p of parts) {
        if (!Number.isInteger(p.bp) || (p.bp as number) < 1 || (p.bp as number) > 10000) fail("percent_invalid", { member: p.member });
        sum += p.bp as number;
      }
      if (sum !== 10000) fail("percent_sum", { sum });
      for (const p of parts) exact.set(p.member, frac(total * BigInt(p.bp as number), 10000n));
    }
  } else {
    fail("mode_invalid");
  }

  const payerInSplit = exact.has(bill.payer);
  const shares = distribute(total, exact, bill.payer, payerInSplit, order);
  return { total, itemsSubtotal, exact, shares, payerInSplit };
}

/** Settlement units per ONE bill-currency unit, as an exact fraction. */
export function factorFromRate(rate: Frac, inverted: boolean): Frac {
  return inverted ? frac(rate.den, rate.num) : rate;
}

/** C = roundHalfEven(T * factor) in settlement minor units. */
export function convertTotal(total: bigint, billDp: number, settleDp: number, factor: Frac): bigint {
  const c = roundHalfEven(total * factor.num * pow10(settleDp), factor.den * pow10(billDp));
  if (total > 0n && c <= 0n) fail("convert_zero");
  if (c > MAX_MINOR) fail("amount_too_large");
  return c;
}

/**
 * Convert rounded bill-currency shares to settlement shares that sum to C
 * exactly, with the same leftover rule. Identity when C === T.
 */
export function convertShares(alloc: Allocation, C: bigint, payer: string, order: Order): Map<string, bigint> {
  const exacts = new Map<string, Frac>();
  for (const [m, x] of alloc.shares) if (x > 0n) exacts.set(m, frac(C * x, alloc.total));
  return distribute(C, exacts, payer, alloc.payerInSplit, order);
}
