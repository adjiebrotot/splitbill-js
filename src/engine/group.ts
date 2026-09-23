/**
 * engine/group.ts — a whole group's numbers from its raw rows.
 *
 * Input is exactly what the database holds (bills with their lines, payments,
 * the rate table); output is every figure any screen, report or bot message
 * shows. Nothing downstream does arithmetic of its own.
 */

import { fail, EngineError } from "./errors";
import { allocate, convertShares, convertTotal, factorFromRate, type BillIn, type Order } from "./allocate";
import { parseRate } from "./amount";
import { settle, type Transfer } from "./settle";

export interface MemberIn {
  id: string;
  position: number;
}

export interface RateIn {
  currency: string;
  /** "YYYY-MM-DD", or "-infinity" for "from the start". */
  effective: string;
  rate: string;
  inverted: boolean;
}

export interface GroupBillIn {
  id: string;
  currency: string;
  dp: number;
  date: string;
  bill: BillIn;
}

export interface PaymentIn {
  id: string;
  from: string;
  to: string;
  currency: string;
  dp: number;
  amount: bigint;
  date: string;
}

export interface GroupIn {
  currency: string;
  dp: number;
  members: MemberIn[];
  bills: GroupBillIn[];
  payments: PaymentIn[];
  rates: RateIn[];
}

export interface RateUsed {
  currency: string;
  effective: string;
  rate: string;
  inverted: boolean;
}

export interface BillOut {
  id: string;
  total: bigint;
  converted: bigint | null;
  rate: RateUsed | null;
  payer: string;
  /** member -> [bill-currency share, settlement share] */
  shares: Map<string, [bigint, bigint | null]>;
  error: EngineError | null;
}

export interface PaymentOut {
  id: string;
  converted: bigint | null;
  rate: RateUsed | null;
  error: EngineError | null;
}

export interface MemberBalance {
  id: string;
  position: number;
  /** Sum of C for bills this member paid. */
  paid: bigint;
  /** Sum of this member's settlement shares. */
  share: bigint;
  /** Payments this member handed over / received. */
  sent: bigint;
  received: bigint;
  /** paid - share + sent - received. > 0: is owed. */
  net: bigint;
}

export interface GroupOut {
  bills: BillOut[];
  payments: PaymentOut[];
  balances: MemberBalance[];
  transfers: Transfer[];
  optimal: boolean;
  /** Sum of converted bill totals. */
  spent: bigint;
  /** True when every bill and payment converted; settle requires it. */
  complete: boolean;
  missing: { currency: string; date: string }[];
}

/** Latest rate with effective date <= date. "-infinity" sorts first. */
export function findRate(rates: readonly RateIn[], currency: string, date: string): RateIn | null {
  // "-infinity" < any "YYYY-MM-DD"; plain dates compare as strings.
  const key = (e: string) => (e === "-infinity" ? "" : e);
  let best: RateIn | null = null;
  for (const r of rates) {
    if (r.currency !== currency) continue;
    if (key(r.effective) > date) continue;
    if (!best || key(r.effective) > key(best.effective)) best = r;
  }
  return best;
}

function _convert(amount: bigint, currency: string, dp: number, date: string, g: GroupIn): { c: bigint; rate: RateUsed | null } {
  if (currency === g.currency) {
    if (dp !== g.dp) fail("internal_dp_mismatch");
    return { c: amount, rate: null };
  }
  const r = findRate(g.rates, currency, date);
  if (!r) fail("rate_missing", { currency, date });
  const parsed = parseRate(r.rate);
  const c = convertTotal(amount, dp, g.dp, factorFromRate(parsed.value, r.inverted));
  return { c, rate: { currency: r.currency, effective: r.effective, rate: parsed.text, inverted: r.inverted } };
}

export function computeGroup(g: GroupIn): GroupOut {
  const order: Order = new Map(g.members.map((m) => [m.id, m.position]));
  const bal = new Map<string, MemberBalance>();
  for (const m of g.members) {
    bal.set(m.id, { id: m.id, position: m.position, paid: 0n, share: 0n, sent: 0n, received: 0n, net: 0n });
  }
  const missing: { currency: string; date: string }[] = [];
  let complete = true;
  let spent = 0n;

  const bills: BillOut[] = g.bills.map((b) => {
    const out: BillOut = { id: b.id, total: 0n, converted: null, rate: null, payer: b.bill.payer, shares: new Map(), error: null };
    try {
      const alloc = allocate(b.bill, order);
      out.total = alloc.total;
      for (const [m, x] of alloc.shares) out.shares.set(m, [x, null]);
      const { c, rate } = _convert(alloc.total, b.currency, b.dp, b.date, g);
      out.converted = c;
      out.rate = rate;
      const conv = convertShares(alloc, c, b.bill.payer, order);
      let sum = 0n;
      for (const [m, cm] of conv) {
        const prev = out.shares.get(m);
        out.shares.set(m, [prev ? prev[0] : 0n, cm]);
        sum += cm;
      }
      if (sum !== c) fail("internal_convert_sum");
      bal.get(b.bill.payer)!.paid += c;
      for (const [m, cm] of conv) bal.get(m)!.share += cm;
      spent += c;
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      out.error = e;
      complete = false;
      if (e.code === "rate_missing") missing.push({ currency: String(e.params.currency), date: String(e.params.date) });
    }
    return out;
  });

  const payments: PaymentOut[] = g.payments.map((p) => {
    const out: PaymentOut = { id: p.id, converted: null, rate: null, error: null };
    try {
      if (!order.has(p.from) || !order.has(p.to)) fail("member_unknown");
      if (p.from === p.to) fail("payment_self");
      if (p.amount <= 0n) fail("amount_zero");
      const { c, rate } = _convert(p.amount, p.currency, p.dp, p.date, g);
      out.converted = c;
      out.rate = rate;
      bal.get(p.from)!.sent += c;
      bal.get(p.to)!.received += c;
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      out.error = e;
      complete = false;
      if (e.code === "rate_missing") missing.push({ currency: String(e.params.currency), date: String(e.params.date) });
    }
    return out;
  });

  let total = 0n;
  const balances = g.members.map((m) => {
    const b = bal.get(m.id)!;
    b.net = b.paid - b.share + b.sent - b.received;
    total += b.net;
    return b;
  });
  if (total !== 0n) fail("internal_unbalanced");

  const { transfers, optimal } = settle(balances.map((b) => ({ id: b.id, position: b.position, amount: b.net })));
  return { bills, payments, balances, transfers, optimal, spent, complete, missing };
}
