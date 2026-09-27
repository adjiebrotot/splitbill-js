/**
 * 007_bill_receipts: proof behind the numbers.
 *
 * - receipts: a bill's photo, normalised (services/receipt.ts) and kept in
 *   Vercel Blob. `url` never leaves the server: members see it through
 *   GET receipt, which checks membership. `scanned_total` is the total the AI
 *   read off the photo (printed total, else its lines), written by the server
 *   when the photo was read, so a saved bill whose total differs can say so.
 *   `bill_id` is set the first time a bill takes the photo and never cleared:
 *   a replaced photo stays as history. One never attached is pruned after a
 *   day (cleanup()).
 * - bills.receipt_id: the bill's current photo.
 * - fx_rates.market_rate: the market rate (settlement units per foreign
 *   unit) when an owner set the rate, so a custom rate far from it shows.
 */
const sql = String.raw`
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id       BIGSERIAL PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups ON DELETE CASCADE,
  user_id          BIGINT REFERENCES users ON DELETE SET NULL,
  bill_id          BIGINT,
  url              TEXT NOT NULL,
  bytes            INT NOT NULL CHECK (bytes > 0),
  scanned_total    BIGINT CHECK (scanned_total > 0),
  scanned_currency CHAR(3),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS receipts_group ON receipts (group_id, bill_id);
CREATE INDEX IF NOT EXISTS receipts_loose ON receipts (created_at) WHERE bill_id IS NULL;
CREATE INDEX IF NOT EXISTS receipts_user ON receipts (user_id, created_at);

ALTER TABLE bills ADD COLUMN IF NOT EXISTS receipt_id BIGINT REFERENCES receipts ON DELETE SET NULL;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS market_rate NUMERIC;
`;

export default sql;
