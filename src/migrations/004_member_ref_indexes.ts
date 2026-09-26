/**
 * 004_member_ref_indexes — index every place that points at a member.
 *
 * Removing or linking a member runs `_hasActivity` (actions.ts) and, on a
 * delete, Postgres's own foreign-key checks. Both look rows up by
 * (group_id, member) in tables whose keys start elsewhere: bill_item_members
 * and bill_participants are keyed by item / bill, bills_group and
 * payments_group are partial (live rows only). So each lookup scanned the
 * whole table, across every group, and got slower as the app grew.
 *
 * telegram_chats is read by group on a group delete. Plain CREATE INDEX (not
 * CONCURRENTLY): a migration runs in a transaction, and these tables are
 * written only through the group lock anyway.
 */
const sql = String.raw`
CREATE INDEX IF NOT EXISTS bill_item_members_member ON bill_item_members (group_id, member_id);
CREATE INDEX IF NOT EXISTS bill_participants_member ON bill_participants (group_id, member_id);
CREATE INDEX IF NOT EXISTS bills_payer ON bills (group_id, payer_member_id);
CREATE INDEX IF NOT EXISTS payments_from ON payments (group_id, from_member);
CREATE INDEX IF NOT EXISTS payments_to ON payments (group_id, to_member);
CREATE INDEX IF NOT EXISTS telegram_chats_group ON telegram_chats (group_id);
`;

export default sql;
