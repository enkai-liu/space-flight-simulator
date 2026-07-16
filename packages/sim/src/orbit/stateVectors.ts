import { Vec3 } from '../math/vec3.js';
import type { Orbit } from './Orbit.js';
import { meanAnomalyAt } from './Orbit.js';
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  trueAnomalyFromEccentric,
  trueAnomalyFromHyperbolic,
  eccentricFromTrueAnomaly,
  hyperbolicFromTrueAnomaly,
} from './keplerSolver.js';

export interface StateVectors {
  /** position relative to the orbited body's center, m */
  r: Vec3;
  /** velocity relative to the orbited body, m/s */
  v: Vec3;
}

/**
 * Orbits are never allowed to be exactly parabolic; anything this close to
 * e = 1 is nudged to stay solvable (plan §3.3). In practice only transient
 * states during a burn can land here.
 */
const PARABOLIC_CLAMP = 1e-6;

export function clampEccentricity(e: number): number {
  if (Math.abs(e - 1) < PARABOLIC_CLAMP) {
    return e < 1 ? 1 - PARABOLIC_CLAMP : 1 + PARABOLIC_CLAMP;
  }
  return e;
}

/** Rotate a perifocal-frame vector into the body frame via 3-1-3 Euler angles. */
function perifocalToBodyFrame(p: Vec3, raan: number, i: number, argPe: number): Vec3 {
  const cosO = Math.cos(raan), sinO = Math.sin(raan);
  const cosI = Math.cos(i), sinI = Math.sin(i);
  const cosW = Math.cos(argPe), sinW = Math.sin(argPe);

  // R = Rz(raan) · Rx(i) · Rz(argPe), applied to p
  const r11 = cosO * cosW - sinO * sinW * cosI;
  const r12 = -cosO * sinW - sinO * cosW * cosI;
  const r21 = sinO * cosW + cosO * sinW * cosI;
  const r22 = -sinO * sinW + cosO * cosW * cosI;
  const r31 = sinW * sinI;
  const r32 = cosW * sinI;

  return new Vec3(
    r11 * p.x + r12 * p.y,
    r21 * p.x + r22 * p.y,
    r31 * p.x + r32 * p.y + p.z * 0, // p.z is always 0 in the perifocal plane
  );
}

/** Position and velocity at sim time t for a Kepler orbit. */
export function elementsToStateVectors(orbit: Orbit, mu: number, t: number): StateVectors {
  const e = orbit.e;
  const M = meanAnomalyAt(orbit, mu, t);

  let nu: number;
  let r: number;
  if (e < 1) {
    const E = solveKeplerElliptic(M, e);
    nu = trueAnomalyFromEccentric(E, e);
    r = orbit.a * (1 - e * Math.cos(E));
  } else {
    const H = solveKeplerHyperbolic(M, e);
    nu = trueAnomalyFromHyperbolic(H, e);
    r = orbit.a * (1 - e * Math.cosh(H));
  }

  // Perifocal frame: x toward periapsis, y along velocity at periapsis.
  const p = orbit.a * (1 - e * e); // semi-latus rectum (positive for both conics)
  const cosNu = Math.cos(nu), sinNu = Math.sin(nu);
  const rPerifocal = new Vec3(r * cosNu, r * sinNu, 0);
  const vScale = Math.sqrt(mu / p);
  const vPerifocal = new Vec3(-vScale * sinNu, vScale * (e + cosNu), 0);

  return {
    r: perifocalToBodyFrame(rPerifocal, orbit.raan, orbit.i, orbit.argPe),
    v: perifocalToBodyFrame(vPerifocal, orbit.raan, orbit.i, orbit.argPe),
  };
}

/**
 * Compute Keplerian elements from a state vector at sim time t.
 *
 * Near-singular handling: for near-circular and/or near-equatorial orbits the
 * classical raan/argPe decomposition is ill-defined. We keep the elements
 * finite and consistent (raan := 0 when equatorial, argPe measured from the
 * reference direction) so that elementsToStateVectors(stateVectorsToElements(s))
 * always round-trips, even though individual angles are then conventional.
 */
export function stateVectorsToElements(rVec: Vec3, vVec: Vec3, mu: number, bodyId: string, t: number): Orbit {
  const SINGULAR_EPS = 1e-11;

  const r = rVec.length();
  const v2 = vVec.lengthSq();

  const hVec = rVec.cross(vVec); // specific angular momentum
  const h = hVec.length();
  if (h < SINGULAR_EPS) {
    throw new Error('degenerate orbit: radial trajectory (r × v ≈ 0)');
  }

  // Eccentricity vector points at periapsis.
  const eVec = vVec.cross(hVec).scale(1 / mu).sub(rVec.normalized());
  const e = clampEccentricity(eVec.length());

  const energy = v2 / 2 - mu / r;
  const a = -mu / (2 * energy); // negative for hyperbolic, as desired

  const i = Math.acos(Math.min(1, Math.max(-1, hVec.z / h)));

  // Node vector: points at the ascending node (z × h).
  const nVec = new Vec3(-hVec.y, hVec.x, 0);
  const n = nVec.length();
  const equatorial = n < SINGULAR_EPS * h;
  const circular = e < SINGULAR_EPS;

  let raan: number;
  let argPe: number;
  let nu: number; // true anomaly

  if (equatorial) {
    raan = 0;
    if (circular) {
      argPe = 0;
      // True anomaly measured from reference direction, signed by orbit normal.
      nu = Math.atan2(rVec.y * Math.sign(hVec.z || 1), rVec.x);
    } else {
      // Longitude of periapsis from the reference direction.
      argPe = Math.atan2(eVec.y * Math.sign(hVec.z || 1), eVec.x);
      nu = angleBetweenSigned(eVec, rVec, hVec);
    }
  } else {
    raan = Math.atan2(nVec.y, nVec.x);
    if (circular) {
      argPe = 0;
      nu = angleBetweenSigned(nVec, rVec, hVec);
    } else {
      argPe = angleBetweenSigned(nVec, eVec, hVec);
      nu = angleBetweenSigned(eVec, rVec, hVec);
    }
  }

  // Mean anomaly at t from true anomaly.
  let m0: number;
  if (e < 1) {
    const E = eccentricFromTrueAnomaly(nu, e);
    m0 = E - e * Math.sin(E);
  } else {
    const H = hyperbolicFromTrueAnomaly(nu, e);
    m0 = e * Math.sinh(H) - H;
  }

  return { bodyId, a, e, i, raan, argPe, m0, epoch: t };
}

/**
 * Position on the conic at a given true anomaly (no time solve). Used for
 * drawing orbit lines. For hyperbolic orbits, nu must stay inside the
 * asymptote range |nu| < acos(-1/e).
 */
export function orbitPositionAtTrueAnomaly(orbit: Orbit, nu: number): Vec3 {
  const p = orbit.a * (1 - orbit.e * orbit.e);
  const r = p / (1 + orbit.e * Math.cos(nu));
  const rPerifocal = new Vec3(r * Math.cos(nu), r * Math.sin(nu), 0);
  return perifocalToBodyFrame(rPerifocal, orbit.raan, orbit.i, orbit.argPe);
}

/** Signed angle from `from` to `to` around the plane normal `normal`. */
function angleBetweenSigned(from: Vec3, to: Vec3, normal: Vec3): number {
  const f = from.normalized();
  const tv = to.normalized();
  const sin = f.cross(tv).dot(normal.normalized());
  return Math.atan2(sin, f.dot(tv));
}
