/**
 * engine/settle.ts — the fewest transfers that zero every balance.
 *
 * With n non-zero balances summing to 0, the minimum number of transfers is
 * n - k, where k is the largest number of disjoint subsets that each sum to 0:
 * a zero-sum group of size c needs c - 1 transfers and cannot do with fewer,
 * and no transfer ever needs to cross two groups.
 *
 *   1. Exact opposite pairs (+a / -a) are always in some optimal partition, so
 *      they are pulled out first (one transfer each).
 *   2. Up to EXACT_MAX remaining members: bitmask DP, O(n * 2^n), for the true
 *      maximum k. Above that: greedy (still <= n - 1 transfers).
 *   3. Inside a group, the largest debtor pays the largest creditor.
 *
 * Every tie breaks on (join position, member id), so the same balances always
 * produce the same transfers, on the server and in the browser.
 */

import { fail } from "./errors";

export const EXACT_MAX = 18;

export interface Balance {
  id: string;
  position: number;
  amount: bigint; // > 0: is owed money; < 0: owes money
}

export interface Transfer {
  from: string;
  to: string;
  amount: bigint;
}

function _cmp(a: Balance, b: Balance): number {
  return a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Largest debtor pays largest creditor until everyone is at zero. */
function _greedy(group: Balance[], out: Transfer[]): void {
  const left = group.map((b) => ({ ...b }));
  for (;;) {
    let debtor: (typeof left)[number] | null = null;
    let creditor: (typeof left)[number] | null = null;
    for (const b of left) {
      if (b.amount < 0n && (!debtor || -b.amount > -debtor.amount)) debtor = b;
      if (b.amount > 0n && (!creditor || b.amount > creditor.amount)) creditor = b;
    }
    if (!debtor || !creditor) break;
    const amt = -debtor.amount < creditor.amount ? -debtor.amount : creditor.amount;
    out.push({ from: debtor.id, to: creditor.id, amount: amt });
    debtor.amount += amt;
    creditor.amount -= amt;
  }
}

/** Partition into the maximum number of zero-sum groups (n <= EXACT_MAX). */
function _zeroSumGroups(bs: Balance[]): Balance[][] {
  const n = bs.length;
  const N = 1 << n;
  const sum = new BigInt64Array(N);
  const dp = new Int8Array(N);
  for (let m = 1; m < N; m++) {
    const low = m & -m;
    const i = 31 - Math.clz32(low);
    sum[m] = sum[m ^ low] + bs[i].amount;
    let best = 0;
    for (let j = 0, x = m; x; j++, x >>>= 1) {
      if (x & 1) {
        const v = dp[m ^ (1 << j)];
        if (v > best) best = v;
      }
    }
    dp[m] = best + (sum[m] === 0n ? 1 : 0);
  }
  // Rebuild one optimal ordering, always removing the smallest usable index,
  // then cut it wherever the running sum returns to zero.
  const seq: number[] = [];
  let m = N - 1;
  while (m) {
    const z = sum[m] === 0n ? 1 : 0;
    let pick = -1;
    for (let j = 0; j < n; j++) {
      if ((m >> j) & 1 && dp[m ^ (1 << j)] + z === dp[m]) {
        pick = j;
        break;
      }
    }
    seq.push(pick);
    m ^= 1 << pick;
  }
  seq.reverse();
  const groups: Balance[][] = [];
  let cur: Balance[] = [];
  let run = 0n;
  for (const j of seq) {
    cur.push(bs[j]);
    run += bs[j].amount;
    if (run === 0n) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) fail("internal_settle_partition");
  return groups;
}

export interface SettleResult {
  transfers: Transfer[];
  /** False when above EXACT_MAX and greedy was used. */
  optimal: boolean;
}

export function settle(balances: readonly Balance[]): SettleResult {
  let total = 0n;
  const ids = new Set<string>();
  for (const b of balances) {
    if (ids.has(b.id)) fail("internal_duplicate_member");
    ids.add(b.id);
    total += b.amount;
  }
  if (total !== 0n) fail("internal_unbalanced");

  const live = balances.filter((b) => b.amount !== 0n).map((b) => ({ ...b })).sort(_cmp);
  const transfers: Transfer[] = [];

  // 1. exact opposite pairs, matched in join order
  const used = new Set<string>();
  for (const d of live) {
    if (d.amount >= 0n || used.has(d.id)) continue;
    const c = live.find((x) => !used.has(x.id) && x.amount === -d.amount);
    if (c) {
      used.add(d.id);
      used.add(c.id);
      transfers.push({ from: d.id, to: c.id, amount: c.amount });
    }
  }
  const rest = live.filter((b) => !used.has(b.id));

  // 2. + 3.
  let optimal = true;
  let magnitude = 0n;
  for (const b of rest) magnitude += b.amount < 0n ? -b.amount : b.amount;
  // BigInt64Array wraps silently past 2^63; never let the DP near that.
  if (rest.length <= EXACT_MAX && magnitude < 2n ** 62n) {
    for (const g of _zeroSumGroups(rest)) _greedy(g.sort(_cmp), transfers);
  } else {
    optimal = false;
    _greedy(rest, transfers);
  }

  // Invariant: applying the transfers zeroes every balance.
  const check = new Map<string, bigint>();
  for (const b of balances) check.set(b.id, b.amount);
  for (const t of transfers) {
    if (t.amount <= 0n || t.from === t.to) fail("internal_bad_transfer");
    check.set(t.from, check.get(t.from)! + t.amount);
    check.set(t.to, check.get(t.to)! - t.amount);
  }
  for (const v of check.values()) if (v !== 0n) fail("internal_settle_residual");
  return { transfers, optimal };
}
