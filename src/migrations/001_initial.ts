/**
 * 001_initial — the whole Split Bill schema.
 *
 * Money is BIGINT minor units everywhere, with the currency's minor-unit count
 * stored next to it. Integrity is enforced twice: once by the service layer
 * through the engine, and again here, so a bug above can never commit a bill
 * that does not add up:
 *
 *   - composite foreign keys (group_id, member_id) stop a row from pointing at
 *     another group's member;
 *   - sb_guard_open refuses any bill / rate write while the group is settled;
 *   - sb_check_bill, a DEFERRED constraint trigger, re-checks every touched
 *     bill at COMMIT: items + adjustments = total, percents sum to 100.00%,
 *     every priced item is assigned, rows match the split mode, and a one-off
 *     has at most one live bill.
 */
const sql = String.raw`
CREATE TABLE users (
  user_id          BIGSERIAL PRIMARY KEY,
  username         TEXT NOT NULL,
  display_name     TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  email            TEXT,
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  password         TEXT,
  language         TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'id')),
  timezone         TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  default_currency CHAR(3) NOT NULL DEFAULT 'IDR',
  telegram_id      BIGINT UNIQUE,
  telegram_group   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX users_username_lower ON users (LOWER(username));
CREATE UNIQUE INDEX users_email_lower ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE email_verifications (
  user_id    BIGINT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE groups (
  group_id      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('one_off', 'travel')),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  owner_user_id BIGINT NOT NULL REFERENCES users,
  currency      CHAR(3) NOT NULL,
  minor_units   SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  timezone      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled')),
  round         INT NOT NULL DEFAULT 0,
  revision      BIGINT NOT NULL DEFAULT 1,
  invite_code   TEXT UNIQUE,
  settled_at    TIMESTAMPTZ,
  settled_by    BIGINT REFERENCES users ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX groups_owner ON groups (owner_user_id);

CREATE TABLE members (
  member_id    BIGSERIAL PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  user_id      BIGINT REFERENCES users ON DELETE SET NULL,
  position     INT NOT NULL CHECK (position > 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, member_id),
  UNIQUE (group_id, position)
);
CREATE UNIQUE INDEX members_user ON members (group_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX members_name ON members (group_id, LOWER(display_name)) WHERE active;
CREATE INDEX members_by_user ON members (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE fx_rates (
  group_id       TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  currency       CHAR(3) NOT NULL,
  effective_date DATE NOT NULL,
  rate           NUMERIC(22, 12) NOT NULL CHECK (rate > 0 AND rate <= 1000000000),
  inverted       BOOLEAN NOT NULL DEFAULT FALSE,
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  set_by         BIGINT REFERENCES users ON DELETE SET NULL,
  set_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, currency, effective_date)
);

CREATE TABLE bills (
  bill_id         BIGSERIAL PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  description     TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  bill_date       DATE NOT NULL,
  currency        CHAR(3) NOT NULL,
  minor_units     SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  mode            TEXT NOT NULL CHECK (mode IN ('items', 'even', 'percent')),
  total_minor     BIGINT NOT NULL CHECK (total_minor > 0 AND total_minor <= 1000000000000000),
  stated_total    BIGINT CHECK (stated_total > 0),
  payer_member_id BIGINT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'form' CHECK (source IN ('form', 'chat', 'photo', 'telegram')),
  created_by      BIGINT REFERENCES users ON DELETE SET NULL,
  updated_by      BIGINT REFERENCES users ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INT NOT NULL DEFAULT 1,
  client_key      TEXT,
  deleted_at      TIMESTAMPTZ,
  UNIQUE (group_id, bill_id),
  FOREIGN KEY (group_id, payer_member_id) REFERENCES members (group_id, member_id)
);
CREATE UNIQUE INDEX bills_client_key ON bills (group_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX bills_group ON bills (group_id) WHERE deleted_at IS NULL;

CREATE TABLE bill_items (
  item_id      BIGSERIAL PRIMARY KEY,
  group_id     TEXT NOT NULL,
  bill_id      BIGINT NOT NULL,
  position     INT NOT NULL,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  qty          NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (group_id, item_id),
  UNIQUE (bill_id, position),
  FOREIGN KEY (group_id, bill_id) REFERENCES bills (group_id, bill_id) ON DELETE CASCADE
);

CREATE TABLE bill_item_members (
  group_id  TEXT NOT NULL,
  item_id   BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  PRIMARY KEY (item_id, member_id),
  FOREIGN KEY (group_id, item_id) REFERENCES bill_items (group_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, member_id) REFERENCES members (group_id, member_id)
);

CREATE TABLE bill_adjustments (
  adjustment_id BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL,
  bill_id       BIGINT NOT NULL,
  position      INT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('tax', 'service', 'tip', 'discount', 'other')),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor <> 0),
  UNIQUE (bill_id, position),
  CHECK ((kind = 'discount' AND amount_minor < 0) OR (kind IN ('tax', 'service', 'tip') AND amount_minor > 0) OR kind = 'other'),
  FOREIGN KEY (group_id, bill_id) REFERENCES bills (group_id, bill_id) ON DELETE CASCADE
);

CREATE TABLE bill_participants (
  group_id  TEXT NOT NULL,
  bill_id   BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  bp        INT CHECK (bp BETWEEN 1 AND 10000),
  PRIMARY KEY (bill_id, member_id),
  FOREIGN KEY (group_id, bill_id) REFERENCES bills (group_id, bill_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, member_id) REFERENCES members (group_id, member_id)
);

CREATE TABLE settlement_transfers (
  transfer_id  BIGSERIAL PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  round        INT NOT NULL,
  from_member  BIGINT NOT NULL,
  to_member    BIGINT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'superseded')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_member <> to_member),
  UNIQUE (group_id, transfer_id),
  FOREIGN KEY (group_id, from_member) REFERENCES members (group_id, member_id),
  FOREIGN KEY (group_id, to_member) REFERENCES members (group_id, member_id)
);
CREATE INDEX transfers_group_round ON settlement_transfers (group_id, round);

CREATE TABLE payments (
  payment_id   BIGSERIAL PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  from_member  BIGINT NOT NULL,
  to_member    BIGINT NOT NULL,
  currency     CHAR(3) NOT NULL,
  minor_units  SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
  pay_date     DATE NOT NULL,
  note         TEXT CHECK (note IS NULL OR length(note) <= 120),
  transfer_id  BIGINT,
  round        INT NOT NULL,
  created_by   BIGINT REFERENCES users ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    BIGINT REFERENCES users ON DELETE SET NULL,
  CHECK (from_member <> to_member),
  FOREIGN KEY (group_id, from_member) REFERENCES members (group_id, member_id),
  FOREIGN KEY (group_id, to_member) REFERENCES members (group_id, member_id),
  FOREIGN KEY (group_id, transfer_id) REFERENCES settlement_transfers (group_id, transfer_id)
);
CREATE UNIQUE INDEX payments_one_per_transfer ON payments (transfer_id) WHERE transfer_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX payments_group ON payments (group_id) WHERE voided_at IS NULL;

CREATE TABLE settlement_rounds (
  group_id       TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  round          INT NOT NULL,
  settled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_by     BIGINT REFERENCES users ON DELETE SET NULL,
  engine_version INT NOT NULL,
  snapshot       JSONB NOT NULL,
  PRIMARY KEY (group_id, round)
);

CREATE TABLE group_events (
  event_id   BIGSERIAL PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  user_id    BIGINT REFERENCES users ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  data       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX group_events_group ON group_events (group_id, event_id);

CREATE TABLE drafts (
  draft_id   TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('chat', 'photo', 'telegram')),
  payload    JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE ai_usage (
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  day     DATE NOT NULL,
  count   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE telegram_link_codes (
  code       TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('link', 'bind')),
  group_id   TEXT REFERENCES groups ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE TABLE telegram_chats (
  chat_id  BIGINT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  bound_by BIGINT REFERENCES users ON DELETE SET NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE telegram_updates (
  update_id   BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE telegram_pending (
  chat_id    BIGINT NOT NULL,
  tg_user_id BIGINT NOT NULL,
  kind       TEXT NOT NULL,
  data       JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_id, tg_user_id)
);

-- ── Guards ──────────────────────────────────────────────────────────────────

-- A settled group is read-only for bills, their lines and its rate table.
CREATE FUNCTION sb_guard_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  gid TEXT;
  st  TEXT;
BEGIN
  gid := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  SELECT status INTO st FROM groups WHERE group_id = gid;
  -- NULL: the group row itself is being deleted and this is its cascade.
  IF st = 'settled' THEN
    RAISE EXCEPTION 'group % is settled', gid USING ERRCODE = 'P0001', HINT = 'group_settled';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER bills_open BEFORE INSERT OR UPDATE OR DELETE ON bills FOR EACH ROW EXECUTE FUNCTION sb_guard_open();
CREATE TRIGGER items_open BEFORE INSERT OR UPDATE OR DELETE ON bill_items FOR EACH ROW EXECUTE FUNCTION sb_guard_open();
CREATE TRIGGER item_members_open BEFORE INSERT OR UPDATE OR DELETE ON bill_item_members FOR EACH ROW EXECUTE FUNCTION sb_guard_open();
CREATE TRIGGER adjustments_open BEFORE INSERT OR UPDATE OR DELETE ON bill_adjustments FOR EACH ROW EXECUTE FUNCTION sb_guard_open();
CREATE TRIGGER participants_open BEFORE INSERT OR UPDATE OR DELETE ON bill_participants FOR EACH ROW EXECUTE FUNCTION sb_guard_open();
CREATE TRIGGER rates_open BEFORE INSERT OR UPDATE OR DELETE ON fx_rates FOR EACH ROW EXECUTE FUNCTION sb_guard_open();

-- The settlement currency never has a rate row: it is always exactly 1.
CREATE FUNCTION sb_guard_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM groups WHERE group_id = NEW.group_id AND (currency = NEW.currency OR kind = 'one_off')) THEN
    RAISE EXCEPTION 'rate row not allowed' USING ERRCODE = 'P0001', HINT = 'rate_not_allowed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rates_valid BEFORE INSERT OR UPDATE ON fx_rates FOR EACH ROW EXECUTE FUNCTION sb_guard_rate();

-- Re-check one bill as a whole. Called at COMMIT for every bill a
-- transaction touched, so multi-row edits are judged in their final state.
CREATE FUNCTION sb_check_bill(p_bill BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  b          bills%ROWTYPE;
  n_items    INT;
  n_parts    INT;
  n_adj      INT;
  items_sum  NUMERIC;
  adj_sum    NUMERIC;
  bp_sum     BIGINT;
  bp_null    INT;
  unassigned INT;
  live_bills INT;
  gkind      TEXT;
BEGIN
  SELECT * INTO b FROM bills WHERE bill_id = p_bill;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COUNT(*), COALESCE(SUM(amount_minor), 0) INTO n_items, items_sum FROM bill_items WHERE bill_id = p_bill;
  SELECT COUNT(*), COALESCE(SUM(amount_minor), 0) INTO n_adj, adj_sum FROM bill_adjustments WHERE bill_id = p_bill;
  SELECT COUNT(*), COALESCE(SUM(bp), 0), COUNT(*) FILTER (WHERE bp IS NULL) INTO n_parts, bp_sum, bp_null
    FROM bill_participants WHERE bill_id = p_bill;

  IF b.mode = 'items' THEN
    IF n_items = 0 OR n_parts > 0 THEN
      RAISE EXCEPTION 'bill % rows do not match mode', p_bill USING ERRCODE = 'P0001', HINT = 'bill_rows_mode';
    END IF;
    IF items_sum <= 0 THEN
      RAISE EXCEPTION 'bill % items subtotal is zero', p_bill USING ERRCODE = 'P0001', HINT = 'items_subtotal_zero';
    END IF;
    IF items_sum + adj_sum <> b.total_minor THEN
      RAISE EXCEPTION 'bill % items + adjustments <> total', p_bill USING ERRCODE = 'P0001', HINT = 'bill_unbalanced';
    END IF;
    SELECT COUNT(*) INTO unassigned FROM bill_items i
     WHERE i.bill_id = p_bill AND i.amount_minor > 0
       AND NOT EXISTS (SELECT 1 FROM bill_item_members m WHERE m.item_id = i.item_id);
    IF unassigned > 0 THEN
      RAISE EXCEPTION 'bill % has unassigned items', p_bill USING ERRCODE = 'P0001', HINT = 'item_unassigned';
    END IF;
  ELSE
    IF n_items > 0 OR n_adj > 0 OR n_parts = 0 THEN
      RAISE EXCEPTION 'bill % rows do not match mode', p_bill USING ERRCODE = 'P0001', HINT = 'bill_rows_mode';
    END IF;
    IF b.mode = 'even' AND bp_null <> n_parts THEN
      RAISE EXCEPTION 'bill % even split carries percents', p_bill USING ERRCODE = 'P0001', HINT = 'bill_rows_mode';
    END IF;
    IF b.mode = 'percent' AND (bp_null > 0 OR bp_sum <> 10000) THEN
      RAISE EXCEPTION 'bill % percents do not sum to 100', p_bill USING ERRCODE = 'P0001', HINT = 'percent_sum';
    END IF;
  END IF;

  SELECT kind INTO gkind FROM groups WHERE group_id = b.group_id;
  IF gkind = 'one_off' THEN
    SELECT COUNT(*) INTO live_bills FROM bills WHERE group_id = b.group_id AND deleted_at IS NULL;
    IF live_bills > 1 THEN
      RAISE EXCEPTION 'one-off % has more than one bill', b.group_id USING ERRCODE = 'P0001', HINT = 'one_off_single_bill';
    END IF;
  END IF;
END $$;

CREATE FUNCTION sb_bill_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'bill_item_members' THEN
    PERFORM sb_check_bill((SELECT bill_id FROM bill_items WHERE item_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END));
  ELSE
    PERFORM sb_check_bill(CASE WHEN TG_OP = 'DELETE' THEN OLD.bill_id ELSE NEW.bill_id END);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER bills_check AFTER INSERT OR UPDATE ON bills
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sb_bill_changed();
CREATE CONSTRAINT TRIGGER items_check AFTER INSERT OR UPDATE OR DELETE ON bill_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sb_bill_changed();
CREATE CONSTRAINT TRIGGER item_members_check AFTER INSERT OR UPDATE OR DELETE ON bill_item_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sb_bill_changed();
CREATE CONSTRAINT TRIGGER adjustments_check AFTER INSERT OR UPDATE OR DELETE ON bill_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sb_bill_changed();
CREATE CONSTRAINT TRIGGER participants_check AFTER INSERT OR UPDATE OR DELETE ON bill_participants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sb_bill_changed();
`;

export default sql;
