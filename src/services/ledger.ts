/**
 * services/ledger.ts — group rows -> engine input -> the numbers every medium
 * shows. The only bridge between the database shape and the engine.
 */
import { computeGroup, type GroupIn, type GroupOut, type BillIn } from "../engine";
import type { GroupState } from "./repo";

export function billToEngine(b: GroupState["bills"][number]): BillIn {
  const items = b.mode === "items";
  return {
    payer: b.payer,
    mode: b.mode,
    total: BigInt(b.total),
    items: items ? b.items.map((i) => ({ name: i.name, amount: BigInt(i.amount), members: i.members })) : undefined,
    adjustments: items ? b.adjustments.map((a) => ({ kind: a.kind, amount: BigInt(a.amount) })) : undefined,
    participants: items ? undefined : b.participants.map((p) => ({ member: p.member, bp: p.bp ?? undefined })),
  };
}

export function toEngine(s: GroupState): GroupIn {
  return {
    currency: s.group.currency,
    dp: s.group.dp,
    members: s.members.map((m) => ({ id: m.id, position: m.position })),
    bills: s.bills.map((b) => ({ id: b.id, currency: b.currency, dp: b.dp, date: b.date, bill: billToEngine(b) })),
    payments: s.payments.map((p) => ({ id: p.id, from: p.from, to: p.to, currency: p.currency, dp: p.dp, amount: BigInt(p.amount), date: p.date })),
    rates: s.rates.map((r) => ({ currency: r.currency, effective: r.effective, rate: r.rate, inverted: r.inverted })),
  };
}

export function compute(s: GroupState): GroupOut {
  return computeGroup(toEngine(s));
}

export type Stage = "open" | "final" | "settled";

/**
 * Where a split stands, the one rule every medium shows:
 * - open: bills can still be added (a trip before Finalise, a one-off with no bill yet);
 * - final: the numbers are locked (a finalised trip, a one-off once its bill is saved)
 *   and some transfer is still unpaid;
 * - settled: final, nobody owes anybody, and every bill and payment computed.
 * `owed` counts the transfers still unpaid. An incomplete group (a bill or
 * payment the engine could not convert) is never settled: its skipped line
 * would make the balances look even.
 */
export function stageOf(g: { kind: string; status: string }, bills: number, owed: number, complete = true): Stage {
  const locked = g.status === "settled" || (g.kind !== "travel" && bills > 0);
  if (!locked) return "open";
  return owed > 0 || !complete ? "final" : "settled";
}

/**
 * The stage of a loaded group. A finalised trip counts its stored unpaid
 * transfers (the post-write gate keeps them equal to the balances); an open
 * group counts the engine's suggested transfers.
 */
export function stageFor(s: GroupState, out: GroupOut): Stage {
  const owed = s.group.status === "settled" ? s.transfers.filter((t) => t.status === "pending").length : out.transfers.length;
  return stageOf(s.group, s.bills.length, owed, out.complete);
}

/** Plain-JSON view of a computed group (bigint -> string happens in json()). */
export function viewOf(s: GroupState, out: GroupOut, meUserId: string | null) {
  const me = s.members.find((m) => m.user_id !== null && m.user_id === meUserId) ?? null;
  const billOut = new Map(out.bills.map((b) => [b.id, b]));
  const payOut = new Map(out.payments.map((p) => [p.id, p]));
  const settled = s.group.status === "settled";
  return {
    group: s.group,
    stage: stageFor(s, out),
    me: me ? me.id : null,
    is_owner: meUserId !== null && s.group.owner === meUserId,
    members: s.members,
    bills: s.bills.map((b) => {
      const o = billOut.get(b.id)!;
      return {
        ...b,
        converted: o.converted,
        rate: o.rate,
        shares: Object.fromEntries([...o.shares].map(([m, [x, c]]) => [m, [x, c]])),
        error: o.error ? { code: o.error.code, params: o.error.params } : null,
      };
    }),
    payments: s.payments.map((p) => {
      const o = payOut.get(p.id)!;
      return { ...p, converted: o.converted, rate: o.rate, error: o.error ? { code: o.error.code, params: o.error.params } : null };
    }),
    rates: s.rates,
    balances: out.balances,
    transfers: settled
      ? s.transfers.map((t) => ({ id: t.id, from: t.from, to: t.to, amount: t.amount, status: t.status }))
      : out.transfers.map((t) => ({ id: null, from: t.from, to: t.to, amount: t.amount, status: "suggested" })),
    spent: out.spent,
    complete: out.complete,
    missing: out.missing,
    optimal: out.optimal,
  };
}

export type GroupView = ReturnType<typeof viewOf>;
