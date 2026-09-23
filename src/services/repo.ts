/**
 * services/repo.ts — load whole groups in ONE round trip.
 *
 * A group's state is built by Postgres as one JSON document per group
 * (subqueries + json_agg), so a group page costs a single statement on Neon's
 * HTTP path instead of nine. Every id and money value is cast to TEXT inside
 * the JSON, so nothing passes through a JS float.
 */
import { fetchall, fetchone } from "../db";

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

const STATE_SQL = `
SELECT g.group_id, json_build_object(
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
      'rate', r.rate::text, 'inverted', r.inverted, 'source', r.source, 'set_at', r.set_at
    ) ORDER BY r.currency, r.effective_date)
    FROM fx_rates r WHERE r.group_id = g.group_id), '[]'::json)
) AS state
FROM groups g
WHERE g.group_id = ANY($1::text[]) AND g.deleted_at IS NULL`;

function _parse(v: unknown): GroupState {
  return (typeof v === "string" ? JSON.parse(v) : v) as GroupState;
}

export async function loadGroups(ids: string[]): Promise<Map<string, GroupState>> {
  const out = new Map<string, GroupState>();
  if (!ids.length) return out;
  for (const r of await fetchall(STATE_SQL, [ids])) out.set(String(r[0]), _parse(r[1]));
  return out;
}

export async function loadGroup(id: string): Promise<GroupState | null> {
  return (await loadGroups([id])).get(id) ?? null;
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
