/**
 * Classical Keplerian elements describing a conic orbit around one body.
 * Angles in radians, distances in meters, time in seconds of sim time.
 *
 * Conventions:
 * - a > 0 for elliptic, a < 0 for hyperbolic (never exactly parabolic; callers
 *   must clamp e away from 1, see soiTransition/stateVectors).
 * - Reference frame is the body-centered non-rotating frame with +Z as the
 *   system "north" pole and +X the reference direction.
 */
export interface Orbit {
  /** id of the body this orbit is around (its mu comes from the body table) */
  bodyId: string;
  /** semi-major axis, m (negative for hyperbolic) */
  a: number;
  /** eccentricity (>= 0, != 1) */
  e: number;
  /** inclination, rad */
  i: number;
  /** right ascension of ascending node, rad */
  raan: number;
  /** argument of periapsis, rad */
  argPe: number;
  /** mean anomaly at `epoch`, rad */
  m0: number;
  /** sim time at which m0 is measured, s */
  epoch: number;
}

/** Mean motion n = sqrt(mu / |a|^3), rad/s. */
export function meanMotion(orbit: Orbit, mu: number): number {
  return Math.sqrt(mu / Math.abs(orbit.a) ** 3);
}

/** Orbital period for elliptic orbits, s. Infinity for hyperbolic. */
export function period(orbit: Orbit, mu: number): number {
  if (orbit.e >= 1) return Infinity;
  return (2 * Math.PI) / meanMotion(orbit, mu);
}

/** Mean anomaly at time t. Not wrapped for hyperbolic (it's unbounded). */
export function meanAnomalyAt(orbit: Orbit, mu: number, t: number): number {
  const m = orbit.m0 + meanMotion(orbit, mu) * (t - orbit.epoch);
  if (orbit.e < 1) {
    // wrap to [-pi, pi] for solver conditioning
    const twoPi = 2 * Math.PI;
    let wrapped = m % twoPi;
    if (wrapped > Math.PI) wrapped -= twoPi;
    if (wrapped < -Math.PI) wrapped += twoPi;
    return wrapped;
  }
  return m;
}

export function periapsis(orbit: Orbit): number {
  return orbit.a * (1 - orbit.e);
}

/** Apoapsis radius, m. Infinity for hyperbolic. */
export function apoapsis(orbit: Orbit): number {
  if (orbit.e >= 1) return Infinity;
  return orbit.a * (1 + orbit.e);
}
