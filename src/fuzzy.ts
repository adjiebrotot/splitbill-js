/**
 * fuzzy.ts — fuzzy matching, ported from api/utils.py `fuzzy_score`.
 *
 * `fuzzy_score` uses python-Levenshtein's `ratio()`, which is the INDEL ratio:
 * edit distance where a substitution costs 2 (one delete + one insert), and
 *
 *     ratio = (len(a) + len(b) - indel_distance) / (len(a) + len(b))
 *
 * with ratio(a,b) = 1.0 when both strings are empty. `levRatio` reproduces this
 * exactly so downstream `resolve_bucket` / `resolve_category` thresholds
 * (60 / 55) match the Python behaviour.
 */

/** python-Levenshtein `ratio(a, b)` — indel-distance similarity in [0, 1]. */
export function levRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const lensum = la + lb;
  if (lensum === 0) return 1.0;

  // Indel distance: insert = 1, delete = 1, substitute = 2.
  // Single-row DP over the edit matrix.
  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 2;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      let m = del < ins ? del : ins;
      if (sub < m) m = sub;
      curr[j] = m;
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }

  const dist = prev[lb];
  return (lensum - dist) / lensum;
}

/** Ported from api/utils.py `fuzzy_score`. Returns an int score in [0, 100]. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (q === c) return 100;
  // Python `q in c or c in q`: substring test (note "" is a substring of all).
  if (c.includes(q) || q.includes(c)) return 85;
  return Math.trunc(levRatio(q, c) * 100);
}
