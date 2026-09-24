/**
 * 002_guard_audit_nulls — let an account delete pass the settled-group guard.
 *
 * Deleting a user sets bills.created_by / updated_by and fx_rates.set_by to
 * NULL (ON DELETE SET NULL). Postgres runs that as an UPDATE, so in a settled
 * group sb_guard_open refused it and the account could never be deleted.
 *
 * The one exemption: an UPDATE where every column is unchanged except those
 * audit columns, each either unchanged or becoming NULL. No amount, line,
 * date, payer or rate can change through it. Everything else is refused
 * exactly as before, and the deferred bill checks are untouched.
 */
const sql = String.raw`
CREATE OR REPLACE FUNCTION sb_guard_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  gid   TEXT;
  st    TEXT;
  audit TEXT[];
  n     JSONB;
  o     JSONB;
BEGIN
  gid := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  SELECT status INTO st FROM groups WHERE group_id = gid;
  -- NULL: the group row itself is being deleted and this is its cascade.
  IF st = 'settled' THEN
    IF TG_OP = 'UPDATE' THEN
      audit := CASE TG_TABLE_NAME
        WHEN 'bills' THEN ARRAY['created_by', 'updated_by']
        WHEN 'fx_rates' THEN ARRAY['set_by']
      END;
      IF audit IS NOT NULL THEN
        n := to_jsonb(NEW);
        o := to_jsonb(OLD);
        IF (n - audit) = (o - audit) AND NOT EXISTS (
          SELECT 1 FROM unnest(audit) AS c
           WHERE n -> c <> 'null'::jsonb AND (n -> c) IS DISTINCT FROM (o -> c)
        ) THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'group % is settled', gid USING ERRCODE = 'P0001', HINT = 'group_settled';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
`;

export default sql;
