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
