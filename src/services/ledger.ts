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

const _outs = new WeakMap<GroupState, GroupOut>();

/**
 * compute(), once per state object. For states nobody mutates: the shared
 * ones from repo.ts readGroups (cached across requests) and the one write()
 * verified and cached. The engine is pure, so the numbers are the same; the
 * result is shared too, so treat it as read-only.
 */
export function computeShared(s: GroupState): GroupOut {
  let out = _outs.get(s);
  if (!out) {
    out = compute(s);
    _outs.set(s, out);
  }
  return out;
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

// ── home-list summary ──────────────────────────────────────────────────────

/**
 * What the home list shows of one group, for every linked member at once.
 * Derived from the engine's numbers (never computed on its own), and stored
 * by write() in group_summaries tagged with the group's revision, so the home
 * list reads small rows instead of loading and computing every group. Money
 * is kept as minor-unit strings.
 */
export interface GroupSummary {
  kind: string;
  name: string;
  currency: string;
  dp: number;
  status: string;
  members: number;
  bills: number;
  spent: string;
  owed: number;
  stage: Stage;
  created_at: string;
  last_at: string;
  /** Per linked user: can they still add bills, their share and net. */
  users: Record<string, { active: boolean; share: string; net: string }>;
}

/** Bump when GroupSummary's shape or meaning changes: old rows are then recomputed. */
export const SUMMARY_VERSION = 1;

function _lastActivity(s: GroupState): string {
  let best = String(s.group.created_at);
  let bestT = Date.parse(best) || 0;
  const stamps = [...s.bills.map((b) => b.updated_at ?? b.created_at), ...s.payments.map((p) => p.created_at)];
  for (const at of stamps) {
    const tm = Date.parse(String(at));
    if (tm > bestT) { bestT = tm; best = String(at); }
  }
  return best;
}

export function summaryOf(s: GroupState, out: GroupOut): GroupSummary {
  const bal = new Map(out.balances.map((b) => [b.id, b]));
  const users: GroupSummary["users"] = {};
  for (const m of s.members) {
    if (m.user_id === null) continue;
    const b = bal.get(m.id);
    users[m.user_id] = { active: m.active, share: String(b?.share ?? 0n), net: String(b?.net ?? 0n) };
  }
  return {
    kind: s.group.kind,
    name: s.group.name,
    currency: s.group.currency,
    dp: s.group.dp,
    status: s.group.status,
    members: s.members.filter((m) => m.active).length,
    bills: s.bills.length,
    spent: String(out.spent),
    // Payments still owed (a finalised trip's balances equal its unpaid transfers).
    owed: out.transfers.length,
    stage: stageFor(s, out),
    created_at: String(s.group.created_at),
    // Newest activity: the last bill or payment written, else the split itself.
    last_at: _lastActivity(s),
    users,
  };
}

/** One home-list row for `userId`, or null when they are not a linked member. */
export function listRow(groupId: string, g: GroupSummary, userId: string) {
  const u = g.users[userId];
  if (!u) return null;
  return {
    group_id: groupId,
    kind: g.kind,
    name: g.name,
    currency: g.currency,
    dp: g.dp,
    status: g.status,
    // Can this viewer still add bills here (the home page's trip shortcuts)?
    active: u.active,
    members: g.members,
    bills: g.bills,
    spent: BigInt(g.spent),
    // The viewer's own spending: their share of every bill, not what they paid.
    my_share: BigInt(u.share),
    my_net: BigInt(u.net),
    owed: g.owed,
    stage: g.stage,
    created_at: g.created_at,
    last_at: g.last_at,
  };
}

export type ListRow = NonNullable<ReturnType<typeof listRow>>;
