/**
 * services/repo.ts — load whole groups in ONE round trip.
 *
 * A group's state is built by Postgres as one JSON document per group
 * (subqueries + json_agg), so a group page costs a single statement on Neon's
 * HTTP path instead of nine. Reads outside a write go through a per-instance
 * cache keyed by revision (readGroups), checked in that same statement.
 */
import { fetchall, fetchone, inTransaction } from "../db";

export interface GroupRow {
  group_id: string;
  kind: "one_off" | "travel";
  name: string;
  owner: string;
  currency: string;
  dp: number;
  timezone: string;
  status: "open" | "settled";
  round: number;
  revision: string;
  invite_code: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface MemberRow {
  id: string;
  name: string;
  user_id: string | null;
  username: string | null;
  position: number;
  active: boolean;
}

export interface ItemRow {
  id: string;
  name: string;
  qty: string;
  amount: string;
  members: string[];
}

export interface AdjRow {
  kind: "tax" | "service" | "tip" | "discount" | "other";
  amount: string;
}

export interface PartRow {
  member: string;
  bp: number | null;
}

export interface BillRow {
  id: string;
  description: string;
  date: string;
  currency: string;
  dp: number;
  mode: "items" | "even" | "percent";
  total: string;
  stated: string | null;
  payer: string;
  source: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  items: ItemRow[];
  adjustments: AdjRow[];
  participants: PartRow[];
}

export interface PaymentRow {
  id: string;
  from: string;
  to: string;
  currency: string;
  dp: number;
  amount: string;
  date: string;
  note: string | null;
  transfer_id: string | null;
  round: number;
  created_by: string | null;
  created_at: string;
}

export interface TransferRow {
  id: string;
  round: number;
  from: string;
  to: string;
  amount: string;
  status: "pending" | "paid" | "superseded";
}

export interface RateRow {
  currency: string;
  effective: string;
  rate: string;
  inverted: boolean;
  source: "manual" | "auto";
  set_at: string;
}

export interface GroupState {
  group: GroupRow;
  members: MemberRow[];
  bills: BillRow[];
  payments: PaymentRow[];
  transfers: TransferRow[];
  rates: RateRow[];
}

/**
 * One group's whole state as JSON. `g` is a groups row. Every id and money
 * value is cast to TEXT, so nothing passes through a JS float.
 */
const STATE_JSON = `json_build_object(
  'group', json_build_object(
    'group_id', g.group_id, 'kind', g.kind, 'name', g.name, 'owner', g.owner_user_id::text,
    'currency', g.currency, 'dp', g.minor_units, 'timezone', g.timezone, 'status', g.status,
    'round', g.round, 'revision', g.revision::text, 'invite_code', g.invite_code,
    'settled_at', g.settled_at, 'created_at', g.created_at),
  'members', COALESCE((
    SELECT json_agg(json_build_object(
      'id', m.member_id::text, 'name', m.display_name, 'user_id', m.user_id::text,
      'username', u.username, 'position', m.position, 'active', m.active) ORDER BY m.position)
    FROM members m LEFT JOIN users u ON u.user_id = m.user_id
    WHERE m.group_id = g.group_id), '[]'::json),
  'bills', COALESCE((
    SELECT json_agg(json_build_object(
      'id', b.bill_id::text, 'description', b.description, 'date', to_char(b.bill_date, 'YYYY-MM-DD'),
      'currency', b.currency, 'dp', b.minor_units, 'mode', b.mode, 'total', b.total_minor::text,
      'stated', b.stated_total::text, 'payer', b.payer_member_id::text, 'source', b.source,
      'created_by', b.created_by::text, 'created_at', b.created_at, 'updated_at', b.updated_at,
      'version', b.version,
      'items', COALESCE((
        SELECT json_agg(json_build_object(
          'id', i.item_id::text, 'name', i.name, 'qty', i.qty::text, 'amount', i.amount_minor::text,
          'members', COALESCE((
            SELECT json_agg(im.member_id::text ORDER BY im.member_id)
            FROM bill_item_members im WHERE im.item_id = i.item_id), '[]'::json)
        ) ORDER BY i.position)
        FROM bill_items i WHERE i.bill_id = b.bill_id), '[]'::json),
      'adjustments', COALESCE((
        SELECT json_agg(json_build_object('kind', a.kind, 'amount', a.amount_minor::text) ORDER BY a.position)
        FROM bill_adjustments a WHERE a.bill_id = b.bill_id), '[]'::json),
      'participants', COALESCE((
        SELECT json_agg(json_build_object('member', p.member_id::text, 'bp', p.bp) ORDER BY p.member_id)
        FROM bill_participants p WHERE p.bill_id = b.bill_id), '[]'::json)
    ) ORDER BY b.bill_date, b.bill_id)
    FROM bills b WHERE b.group_id = g.group_id AND b.deleted_at IS NULL), '[]'::json),
  'payments', COALESCE((
    SELECT json_agg(json_build_object(
      'id', p.payment_id::text, 'from', p.from_member::text, 'to', p.to_member::text,
      'currency', p.currency, 'dp', p.minor_units, 'amount', p.amount_minor::text,
      'date', to_char(p.pay_date, 'YYYY-MM-DD'), 'note', p.note, 'transfer_id', p.transfer_id::text,
      'round', p.round, 'created_by', p.created_by::text, 'created_at', p.created_at
    ) ORDER BY p.pay_date, p.payment_id)
    FROM payments p WHERE p.group_id = g.group_id AND p.voided_at IS NULL), '[]'::json),
  'transfers', COALESCE((
    SELECT json_agg(json_build_object(
      'id', t.transfer_id::text, 'round', t.round, 'from', t.from_member::text, 'to', t.to_member::text,
      'amount', t.amount_minor::text, 'status', t.status) ORDER BY t.transfer_id)
    FROM settlement_transfers t WHERE t.group_id = g.group_id AND t.round = g.round AND t.status <> 'superseded'), '[]'::json),
  'rates', COALESCE((
    SELECT json_agg(json_build_object(
      'currency', r.currency,
      'effective', CASE WHEN r.effective_date = '-infinity'::date THEN '-infinity' ELSE to_char(r.effective_date, 'YYYY-MM-DD') END,
      'rate', trim_scale(r.rate)::text, 'inverted', r.inverted, 'source', r.source, 'set_at', r.set_at
    ) ORDER BY r.currency, r.effective_date)
    FROM fx_rates r WHERE r.group_id = g.group_id), '[]'::json)
)`;

/**
 * What a cached state is valid for. Every write bumps `revision` in the same
 * transaction (write() in actions.ts, joinByInvite, admin handover, migration
 * 003), so an unchanged revision means unchanged books. The one thing a group
 * shows that lives outside it is each linked member's username (users table),
 * so those are part of the key too: a renamed or deleted account is never
 * served stale.
 */
const KEY_SQL = `g.revision::text || COALESCE((
    SELECT string_agg(':' || m.member_id || '=' || u.username, '' ORDER BY m.member_id)
    FROM members m JOIN users u ON u.user_id = m.user_id WHERE m.group_id = g.group_id), '')`;

/**
 * `from` yields the groups rows; $2/$3 are the (id, key) pairs the caller
 * already holds. A row whose key still matches comes back with a NULL state:
 * Postgres skips building its JSON (CASE never evaluates the other branch),
 * so a warm read is one small row per group instead of the whole document.
 */
function stateSql(from: string, order = ""): string {
  return `SELECT g.group_id, k.key, CASE WHEN k.key = kn.key THEN NULL ELSE ${STATE_JSON} END AS state
FROM ${from} g
CROSS JOIN LATERAL (SELECT ${KEY_SQL} AS key) k
LEFT JOIN unnest($2::text[], $3::text[]) AS kn(id, key) ON kn.id = g.group_id${order}`;
}

const BY_IDS_SQL = stateSql("(SELECT * FROM groups WHERE group_id = ANY($1::text[]) AND deleted_at IS NULL)");

/** A user's groups, newest first (the home list), in the same one statement. */
const BY_USER_SQL = stateSql(
  `(SELECT * FROM groups gg WHERE gg.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM members m WHERE m.group_id = gg.group_id AND m.user_id = $1)
    ORDER BY gg.created_at DESC LIMIT 200)`,
  "\nORDER BY g.created_at DESC",
);

function _parse(v: unknown): GroupState {
  return (typeof v === "string" ? JSON.parse(v) : v) as GroupState;
}

// ── per-instance cache ─────────────────────────────────────────────────────
//
// A warm serverless instance serves many requests. Keeping the last state of
// each group it saw, keyed as above, turns a repeat read into a key check.
// Never stale: every read still asks Postgres for the current key, and a
// mismatch returns the full state in the same round trip. Only committed
// data enters: reads inside a transaction bypass the cache, and write()
// stores its verified state only after COMMIT (rememberGroup).
//
// Cached states are shared between requests: callers must treat them (and
// compute()'s memoized output) as read-only.

const CACHE_MAX = 500;
const USERS_MAX = 2000;
interface Entry { key: string; s: GroupState }
const _cache = new Map<string, Entry>();
const _userGroups = new Map<string, string[]>();

function _lru<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > max) m.delete(m.keys().next().value as K);
}

export function rememberGroup(id: string, key: string, s: GroupState): void {
  _lru(_cache, id, { key, s }, CACHE_MAX);
}

/** Tests: start from a cold instance. */
export function _resetGroupCache(): void {
  _cache.clear();
  _userGroups.clear();
}

async function _read(sql: string, first: unknown, ids: string[], cached: boolean): Promise<Map<string, GroupState>> {
  const held = new Map<string, Entry>();
  if (cached) for (const id of ids) { const e = _cache.get(id); if (e) held.set(id, e); }
  const rows = await fetchall(sql, [first, [...held.keys()], [...held.values()].map((e) => e.key)]);
  const out = new Map<string, GroupState>();
  for (const r of rows) {
    const id = String(r[0]);
    const key = String(r[1]);
    const s = r[2] === null || r[2] === undefined ? held.get(id)!.s : _parse(r[2]);
    if (cached) rememberGroup(id, key, s);
    out.set(id, s);
  }
  return out;
}

/** Exact states, no cache (inside a transaction, or when a key is needed). */
export async function loadGroupsKeyed(ids: string[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  if (!ids.length) return out;
  for (const r of await fetchall(BY_IDS_SQL, [ids, [], []])) out.set(String(r[0]), { key: String(r[1]), s: _parse(r[2]) });
  return out;
}

export async function loadGroups(ids: string[]): Promise<Map<string, GroupState>> {
  const out = new Map<string, GroupState>();
  for (const [id, e] of await loadGroupsKeyed(ids)) out.set(id, e.s);
  return out;
}

export async function loadGroup(id: string): Promise<GroupState | null> {
  return (await loadGroups([id])).get(id) ?? null;
}

/**
 * Committed states for reads outside a write. One round trip, like
 * loadGroups, but a group this instance already holds at its current key
 * costs a key instead of its whole document.
 */
export async function readGroups(ids: string[]): Promise<Map<string, GroupState>> {
  if (!ids.length) return new Map();
  if (inTransaction()) return loadGroups(ids);
  return _read(BY_IDS_SQL, ids, ids, true);
}

export async function readGroup(id: string): Promise<GroupState | null> {
  return (await readGroups([id])).get(id) ?? null;
}

/** Every live group `userId` is a member of, newest first, at most 200. */
export async function readUserGroups(userId: string): Promise<GroupState[]> {
  const cached = !inTransaction();
  const m = await _read(BY_USER_SQL, userId, cached ? _userGroups.get(userId) ?? [] : [], cached);
  if (cached) _lru(_userGroups, userId, [...m.keys()], USERS_MAX);
  return [...m.values()];
}

/**
 * Lock the group row for the rest of the transaction. Must run inside
 * atomic(): every write serializes on this, including settle.
 */
export async function lockGroup(id: string): Promise<{ status: string; revision: string; owner: string; kind: string } | null> {
  const r = await fetchone(
    "SELECT status, revision::text, owner_user_id::text, kind FROM groups WHERE group_id = $1 AND deleted_at IS NULL FOR UPDATE",
    [id],
  );
  return r ? { status: String(r[0]), revision: String(r[1]), owner: String(r[2]), kind: String(r[3]) } : null;
}

/**
 * lockGroup and the revision bump in one statement: an UPDATE takes the same
 * row lock as FOR UPDATE. `revision` is the value before the bump. A throw
 * later in the transaction rolls the bump back with everything else.
 */
export async function lockAndBump(id: string): Promise<{ status: string; revision: string; owner: string; kind: string } | null> {
  const r = await fetchone(
    `UPDATE groups SET revision = revision + 1 WHERE group_id = $1 AND deleted_at IS NULL
     RETURNING status, (revision - 1)::text, owner_user_id::text, kind`,
    [id],
  );
  return r ? { status: String(r[0]), revision: String(r[1]), owner: String(r[2]), kind: String(r[3]) } : null;
}
