/**
 * Kepler's equation solvers. Per-conic (elliptic / hyperbolic) rather than
 * universal variables: boring, branchy, and easy to test — see plan §3.3.
 */

const TOL = 1e-12;
const MAX_NEWTON_ITERS = 30;

/**
 * Solve M = E - e·sin(E) for eccentric anomaly E.
 * Expects M wrapped to [-pi, pi]; returns E in [-pi, pi].
 */
export function solveKeplerElliptic(M: number, e: number): number {
  if (e < 0 || e >= 1) throw new RangeError(`elliptic solver needs 0 <= e < 1, got ${e}`);
  if (e === 0 || M === 0) return M;

  // Standard starter: M works for low e; near-parabolic needs a biased guess.
  let E = e < 0.8 ? M : M >= 0 ? Math.PI : -Math.PI;

  for (let iter = 0; iter < MAX_NEWTON_ITERS; iter++) {
    const f = E - e * Math.sin(E) - M;
    const fPrime = 1 - e * Math.cos(E);
    const step = f / fPrime;
    E -= step;
    if (Math.abs(step) < TOL) return E;
  }

  // Newton failed to converge (pathological high-e case): bisection fallback.
  // f(E) is monotonic in E, so the root is bracketed by [-pi, pi] for wrapped M.
  let lo = -Math.PI;
  let hi = Math.PI;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const f = mid - e * Math.sin(mid) - M;
    if (Math.abs(f) < TOL) return mid;
    if (f > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Solve M = e·sinh(H) - H for hyperbolic anomaly H. M is unbounded.
 */
export function solveKeplerHyperbolic(M: number, e: number): number {
  if (e <= 1) throw new RangeError(`hyperbolic solver needs e > 1, got ${e}`);

  let H = Math.asinh(M / e);

  for (let iter = 0; iter < MAX_NEWTON_ITERS; iter++) {
    const f = e * Math.sinh(H) - H - M;
    const fPrime = e * Math.cosh(H) - 1;
    const step = f / fPrime;
    H -= step;
    if (Math.abs(step) < TOL) return H;
  }

  // Bisection fallback on an expanding bracket.
  let lo = H - 1;
  let hi = H + 1;
  const f = (x: number) => e * Math.sinh(x) - x - M;
  while (f(lo) > 0) lo -= 1;
  while (f(hi) < 0) hi += 1;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < TOL) return mid;
    if (fm > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** True anomaly from eccentric anomaly (elliptic). */
export function trueAnomalyFromEccentric(E: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

/** True anomaly from hyperbolic anomaly. */
export function trueAnomalyFromHyperbolic(H: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(e + 1) * Math.sinh(H / 2), Math.sqrt(e - 1) * Math.cosh(H / 2));
}

/** Eccentric anomaly from true anomaly (elliptic). */
export function eccentricFromTrueAnomaly(nu: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
}

/** Hyperbolic anomaly from true anomaly. */
export function hyperbolicFromTrueAnomaly(nu: number, e: number): number {
  return 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
}
