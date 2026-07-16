import { Vec3 } from '../math/vec3.js';
import type { SystemTree } from '../bodies/CelestialBody.js';
import type { Orbit } from './Orbit.js';
import { meanMotion, period, periapsis, apoapsis, meanAnomalyAt } from './Orbit.js';
import { elementsToStateVectors } from './stateVectors.js';
import {
  eccentricFromTrueAnomaly,
  hyperbolicFromTrueAnomaly,
} from './keplerSolver.js';

/**
 * Patched-conic event detection for on-rails vessels (plan §3.4): the next
 * moment a coasting orbit leaves its SOI, enters a child body's SOI, or dips
 * low enough that physics must take over (atmosphere or terrain).
 */
export type Transition =
  | { kind: 'soiExit'; time: number }
  | { kind: 'soiEntry'; time: number; targetBodyId: string }
  | { kind: 'dropToPhysics'; time: number };

/**
 * A transition plan is only trustworthy up to `scannedUntil`: SOI-entry
 * scanning uses a finite horizon, so when sim time passes it with no event,
 * the caller must re-scan from there.
 */
export interface TransitionPlan {
  next: Transition | null;
  scannedUntil: number;
}

/** True anomaly (>0) at which the orbit reaches radius r, or null if it never does. */
function trueAnomalyAtRadius(orbit: Orbit, r: number): number | null {
  const p = orbit.a * (1 - orbit.e * orbit.e);
  if (orbit.e === 0) return null;
  const cosNu = (p / r - 1) / orbit.e;
  if (cosNu < -1 || cosNu > 1) return null;
  return Math.acos(cosNu);
}

/** Mean anomaly corresponding to a true anomaly. */
function meanFromTrueAnomaly(orbit: Orbit, nu: number): number {
  if (orbit.e < 1) {
    const E = eccentricFromTrueAnomaly(nu, orbit.e);
    return E - orbit.e * Math.sin(E);
  }
  const H = hyperbolicFromTrueAnomaly(nu, orbit.e);
  return orbit.e * Math.sinh(H) - H;
}

/**
 * Earliest time strictly after t0 at which the orbital radius crosses
 * `targetRadius` moving in the given radial direction ('ascending' = outward).
 * Returns null when the orbit never crosses that radius (or already did, for
 * hyperbolic orbits).
 */
export function nextRadiusCrossing(
  orbit: Orbit,
  mu: number,
  targetRadius: number,
  t0: number,
  direction: 'ascending' | 'descending',
): number | null {
  if (targetRadius <= periapsis(orbit) || targetRadius >= apoapsis(orbit)) return null;
  const nuStar = trueAnomalyAtRadius(orbit, targetRadius);
  if (nuStar === null) return null;

  // radial rate ~ e·sin(nu): outward for nu in (0, π), inward for (-π, 0)
  const nu = direction === 'ascending' ? nuStar : -nuStar;
  const mTarget = meanFromTrueAnomaly(orbit, nu);
  const n = meanMotion(orbit, mu);

  if (orbit.e >= 1) {
    // single pass: mean anomaly increases monotonically through the encounter
    const t = orbit.epoch + (mTarget - orbit.m0) / n;
    return t > t0 ? t : null;
  }

  // elliptic: wrap to the first occurrence after t0
  const mNow = meanAnomalyAt(orbit, mu, t0);
  let dM = mTarget - mNow;
  const twoPi = 2 * Math.PI;
  while (dM <= 0) dM += twoPi;
  return t0 + dM / n;
}

/** Vessel position in its orbit body's frame at time t. */
function vesselLocalPos(orbit: Orbit, mu: number, t: number): Vec3 {
  return elementsToStateVectors(orbit, mu, t).r;
}

/**
 * First time in [t0, tMax] at which the vessel's distance to a child body
 * drops below that child's SOI radius. Coarse scan + bisection refinement
 * (plan §3.4). Child positions are analytic, so this is exact enough
 * (refined to <1 ms) without being fragile.
 */
export function findSoiEntry(
  tree: SystemTree,
  orbit: Orbit,
  t0: number,
  tMax: number,
): { time: number; targetBodyId: string } | null {
  const body = tree.get(orbit.bodyId);
  const children = tree.children(body.id);
  if (children.length === 0 || tMax <= t0) return null;

  const peri = periapsis(orbit);
  const apo = apoapsis(orbit);

  let best: { time: number; targetBodyId: string } | null = null;

  for (const child of children) {
    if (!child.orbit) continue;
    // radial-window prefilter: can the two orbits even come near each other?
    const childPeri = periapsis(child.orbit) - child.soiRadius;
    const childApo = apoapsis(child.orbit) + child.soiRadius;
    if (apo < childPeri || peri > childApo) continue;

    const distance = (t: number): number =>
      vesselLocalPos(orbit, body.mu, t).sub(tree.localState(child.id, t).r).length() -
      child.soiRadius;

    // explicit annotation breaks a circular control-flow inference through `best`
    const horizon: number = best ? Math.min(tMax, best.time) : tMax;
    const samples = 600;
    const step = (horizon - t0) / samples;
    if (step <= 0) continue;

    let prevT = t0;
    let prevD = distance(t0);
    // "already inside" needs a real margin: right after an SOI exit the vessel
    // sits exactly on the boundary, and float noise must not bounce it back in
    if (prevD <= -1) return { time: t0, targetBodyId: child.id };

    for (let i = 1; i <= samples; i++) {
      const t = t0 + i * step;
      const d = distance(t);
      if (d <= 0) {
        // bracketed a crossing in (prevT, t]; bisect to ~1 ms
        let lo = prevT;
        let hi = t;
        for (let iter = 0; iter < 60 && hi - lo > 1e-3; iter++) {
          const mid = (lo + hi) / 2;
          if (distance(mid) <= 0) hi = mid;
          else lo = mid;
        }
        if (!best || hi < best.time) best = { time: hi, targetBodyId: child.id };
        break;
      }
      prevT = t;
      prevD = d;
    }
  }

  return best;
}

/** How far ahead one SOI-entry scan looks, s. */
export const ENTRY_SCAN_HORIZON = 14 * 6 * 3600; // 14 six-hour Terra days

/**
 * Radius below which a vessel must be integrated rather than kept on rails:
 * the atmosphere top, or a small margin above terrain for airless bodies.
 * Shared by transition planning and the rails-eligibility check so they can
 * never disagree.
 */
export function physicsFloorRadius(body: { radius: number; atmosphere?: { height: number } }): number {
  return body.radius + (body.atmosphere ? body.atmosphere.height : 2_000);
}

/**
 * Compute the vessel's next patched-conic event. `physicsFloor` is the radius
 * below which the sim must integrate (atmosphere top, or just above terrain
 * for airless bodies).
 */
export function planTransitions(tree: SystemTree, orbit: Orbit, t0: number): TransitionPlan {
  const body = tree.get(orbit.bodyId);

  const candidates: Transition[] = [];

  // leaving this SOI
  if (body.soiRadius !== Infinity) {
    const tExit = nextRadiusCrossing(orbit, body.mu, body.soiRadius, t0, 'ascending');
    if (tExit !== null) candidates.push({ kind: 'soiExit', time: tExit });
    if (orbit.e >= 1 && tExit === null) {
      // outbound hyperbolic already beyond computed crossing — treat as immediate
      const { r } = elementsToStateVectors(orbit, body.mu, t0);
      if (r.length() >= body.soiRadius) candidates.push({ kind: 'soiExit', time: t0 });
    }
  }

  // dropping into atmosphere / terrain
  const tDrop = nextRadiusCrossing(orbit, body.mu, physicsFloorRadius(body), t0, 'descending');
  if (tDrop !== null) candidates.push({ kind: 'dropToPhysics', time: tDrop });

  // encountering a child SOI — bounded by the earliest of the above
  let horizon = t0 + ENTRY_SCAN_HORIZON;
  for (const c of candidates) horizon = Math.min(horizon, c.time);
  const entry = findSoiEntry(tree, orbit, t0, horizon);
  if (entry) candidates.push({ kind: 'soiEntry', time: entry.time, targetBodyId: entry.targetBodyId });

  candidates.sort((a, b) => a.time - b.time);
  return {
    next: candidates[0] ?? null,
    scannedUntil: candidates[0] ? candidates[0].time : horizon,
  };
}
