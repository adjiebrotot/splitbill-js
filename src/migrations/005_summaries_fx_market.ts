/**
 * 005_summaries_fx_market — two derived tables, both safe to empty at any time.
 *
 * group_summaries: the home list's figures per group (services/ledger.ts
 * summaryOf), written by write() in the same transaction as the change and
 * valid only while `revision` equals the group's and `version` equals the
 * code's (engine + summary shape). Anything else is recomputed from the books
 * and stored again. It never feeds a write.
 *
 * fx_market: market rates fetched from the provider, one per pair per day
 * (fx_providers.ts). A split is not a bank: one day's rate serves every
 * lookup of that day, across every instance. Only prefills and auto rates use
 * it; a group's own fx_rates rows stay the only rates its books use.
 */
const sql = String.raw`
CREATE TABLE IF NOT EXISTS group_summaries (
  group_id TEXT PRIMARY KEY REFERENCES groups ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  version  TEXT NOT NULL,
  data     JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_market (
  base       CHAR(3) NOT NULL,
  quote      CHAR(3) NOT NULL,
  day        DATE NOT NULL,
  rate       DOUBLE PRECISION NOT NULL CHECK (rate > 0),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (base, quote, day)
);
`;

export default sql;
