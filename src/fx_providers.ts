/**
 * fx_providers.ts: the "Auto rate" lookup. Adapted from finance-tracker
 * (fxratesapi, asked in whichever direction carries the digits), fiat only.
 * Never throws: a dead provider returns null and nothing is saved.
 */

async function _fetchJson(url: string, timeoutMs: number): Promise<Record<string, any> | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return (await resp.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

export async function fetchFxratesApi(fromCcy: string, toCcy: string, date: string | null): Promise<number | null> {
  if (fromCcy === toCcy) return 1;
  const url = date
    ? `https://api.fxratesapi.com/historical?date=${date}&currencies=${toCcy}&base=${fromCcy}`
    : `https://api.fxratesapi.com/latest?currencies=${toCcy}&base=${fromCcy}`;
  const data = await _fetchJson(url, 8000);
  if (data && data.success && data.rates && toCcy in data.rates) {
    const rate = Number(data.rates[toCcy]);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  return null;
}

/** The provider truncates tiny rates; ask the other way round and invert. */
export async function fetchFxratesBest(fromCcy: string, toCcy: string, date: string | null): Promise<number | null> {
  const direct = await fetchFxratesApi(fromCcy, toCcy, date);
  if (direct !== null && direct >= 1e-4) return direct;
  const inverse = await fetchFxratesApi(toCcy, fromCcy, date);
  if (inverse !== null && inverse > 0) return 1 / inverse;
  return direct;
}

/**
 * A float rate as the stored "big side first" pair: 1 foreign = x settlement
 * when x >= 1, else 1 settlement = (1/x) foreign (inverted). 10 significant
 * digits, no trailing zeros.
 */
export function bigSideFirst(settlementPerForeign: number): { rate: string; inverted: boolean } {
  const inverted = settlementPerForeign < 1;
  const v = inverted ? 1 / settlementPerForeign : settlementPerForeign;
  // v >= 1, so 10 significant digits never need more than 9 decimals. The
  // shortest round-trip form: toFixed(12) printed float noise (17948.302459999999).
  return { rate: String(Number(v.toPrecision(10))), inverted };
}

// ── one rate per pair per day ──────────────────────────────────────────────
//
// Market rates only prefill forms and fill a trip's missing rates, and a split
// is not a bank: the first rate fetched for a pair on a day serves the whole
// day, for every instance. Order: this instance's memory, then the shared
// fx_market table, then the provider (stored for everyone). A historical day
// never changes; "latest" is stored under today's UTC date. A provider that
// is down is not asked again for 5 minutes, so saves do not each wait for its
// timeout.

const MEM_MAX = 2000;
const NEG_MS = 5 * 60 * 1000;
const _mem = new Map<string, number>();
const _neg = new Map<string, number>();
const _inflight = new Map<string, Promise<number | null>>();

/** Tests: forget everything this instance remembers. */
export function _resetFxCache(): void {
  _mem.clear();
  _neg.clear();
  _inflight.clear();
}

function _utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function _stored(from: string, to: string, day: string): Promise<number | null> {
  try {
    const { fetchone } = await import("./db");
    const r = await fetchone("SELECT rate FROM fx_market WHERE base = $1 AND quote = $2 AND day = $3::date", [from, to, day]);
    return r ? Number(r[0]) : null;
  } catch {
    return null; // the cache is optional: a failed read just asks the provider
  }
}

async function _store(from: string, to: string, day: string, rate: number): Promise<void> {
  try {
    const { execute } = await import("./db");
    await execute("INSERT INTO fx_market (base, quote, day, rate) VALUES ($1, $2, $3::date, $4) ON CONFLICT DO NOTHING", [from, to, day, rate]);
  } catch {
    /* optional, as above */
  }
}

/** settlement-per-foreign rate for `date` (null = today), cached for the day. */
export async function marketRate(fromCcy: string, toCcy: string, date: string | null): Promise<number | null> {
  if (fromCcy === toCcy) return 1;
  const day = date ?? _utcToday();
  const key = `${fromCcy}>${toCcy}@${day}`;
  const hit = _mem.get(key);
  if (hit !== undefined) return hit;
  if ((_neg.get(key) ?? 0) > Date.now()) return null;
  let p = _inflight.get(key);
  if (!p) {
    p = (async () => {
      let rate = await _stored(fromCcy, toCcy, day);
      if (rate === null) {
        rate = await fetchFxratesBest(fromCcy, toCcy, date);
        if (rate === null) {
          _neg.set(key, Date.now() + NEG_MS);
          return null;
        }
        await _store(fromCcy, toCcy, day, rate);
      }
      _mem.delete(key);
      _mem.set(key, rate);
      if (_mem.size > MEM_MAX) _mem.delete(_mem.keys().next().value as string);
      return rate;
    })().finally(() => _inflight.delete(key));
    _inflight.set(key, p);
  }
  return p;
}
