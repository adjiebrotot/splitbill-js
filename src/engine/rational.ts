/**
 * engine/rational.ts — exact integer arithmetic on bigint.
 *
 * Every money figure in the app is an integer count of minor units, and every
 * intermediate share is an exact fraction num/den. Nothing here ever touches a
 * float, so a total always splits back to exactly itself.
 */

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return abs(a / gcd(a, b) * b);
}

/** floor(num / den) for den > 0, correct for negative num too. */
export function floorDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("floorDiv: den must be > 0");
  const q = num / den;
  return (num % den !== 0n && num < 0n) ? q - 1n : q;
}

/** round-half-to-even(num / den) for den > 0. */
export function roundHalfEven(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("roundHalfEven: den must be > 0");
  const q = floorDiv(num, den);
  const r = num - q * den; // 0 <= r < den
  const twice = 2n * r;
  if (twice < den) return q;
  if (twice > den) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("pow10: n must be a non-negative integer");
  return 10n ** BigInt(n);
}

/** An exact, positive-denominator fraction. */
export interface Frac {
  num: bigint;
  den: bigint;
}

export function frac(num: bigint, den: bigint = 1n): Frac {
  if (den === 0n) throw new RangeError("frac: zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}
