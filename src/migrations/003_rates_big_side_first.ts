/**
 * 003_rates_big_side_first — store every rate big side first.
 *
 * A rate under 1 (1 IDR = 0.00007901521 AUD) loses digits in the 12-decimal
 * column and reads badly; its reciprocal (1 AUD = 12655.79121 IDR) does not.
 * New rates are stored that way by bigSideRate() in the engine. This flips
 * the rows saved before: reciprocal to 10 significant digits, `inverted`
 * negated, one group_events row each, and the group's revision bumped.
 *
 * Settled groups are left alone (their books are locked; reopenGroup flips
 * them). A reciprocal past the largest rate (1e9) stays as it is, as in the
 * engine. Idempotent: a flipped rate is >= 1, so a re-run finds nothing.
 */
const sql = String.raw`
DO $$
DECLARE
  r RECORD;
  v NUMERIC;
  flipped NUMERIC;
BEGIN
  FOR r IN
    SELECT f.group_id, f.currency, f.effective_date, f.rate, f.inverted
      FROM fx_rates f JOIN groups g ON g.group_id = f.group_id
     WHERE g.status <> 'settled' AND f.rate < 1 AND f.rate >= 0.000000001
     ORDER BY f.group_id, f.currency, f.effective_date
  LOOP
    v := 1 / r.rate;
    flipped := trim_scale(round(v, GREATEST(0, 10 - length(trunc(v)::text))));
    UPDATE fx_rates SET rate = flipped, inverted = NOT r.inverted
     WHERE group_id = r.group_id AND currency = r.currency AND effective_date = r.effective_date;
    INSERT INTO group_events (group_id, user_id, action, entity, entity_id, data)
    VALUES (r.group_id, NULL, 'set', 'rate', r.currency || '|' || r.effective_date::text,
            jsonb_build_object('rate', flipped::text, 'inverted', NOT r.inverted, 'from', r.rate::text, 'source', 'big_side_first'));
    UPDATE groups SET revision = revision + 1 WHERE group_id = r.group_id;
  END LOOP;
END $$;
`;

export default sql;
