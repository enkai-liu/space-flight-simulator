import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/math/vec3.js';
import type { Orbit } from '../src/orbit/Orbit.js';
import { period } from '../src/orbit/Orbit.js';
import { elementsToStateVectors, stateVectorsToElements } from '../src/orbit/stateVectors.js';

const MU = 3.5316e12; // Terra
const BODY = 'terra';

function orbit(partial: Partial<Orbit>): Orbit {
  return { bodyId: BODY, a: 700_000, e: 0, i: 0, raan: 0, argPe: 0, m0: 0, epoch: 0, ...partial };
}

/** relative position error between two state-vector snapshots */
function relError(a: Vec3, b: Vec3): number {
  return a.sub(b).length() / Math.max(a.length(), 1);
}

describe('elementsToStateVectors', () => {
  it('circular equatorial orbit: |r| = a and |v| = sqrt(mu/a)', () => {
    const o = orbit({ a: 700_000 });
    const { r, v } = elementsToStateVectors(o, MU, 0);
    expect(r.length()).toBeCloseTo(700_000, 6);
    expect(v.length()).toBeCloseTo(Math.sqrt(MU / 700_000), 6);
    expect(Math.abs(r.dot(v))).toBeLessThan(1e-4); // circular ⇒ r ⊥ v
  });

  it('returns to the same state after exactly one period', () => {
    const o = orbit({ a: 900_000, e: 0.3, i: 0.4, raan: 1.1, argPe: 2.2, m0: 0.5 });
    const T = period(o, MU);
    const s0 = elementsToStateVectors(o, MU, 0);
    const s1 = elementsToStateVectors(o, MU, T);
    expect(relError(s0.r, s1.r)).toBeLessThan(1e-9);
    expect(relError(s0.v, s1.v)).toBeLessThan(1e-9);
  });

  it('satisfies vis-viva everywhere on elliptic and hyperbolic orbits', () => {
    const cases = [
      orbit({ a: 800_000, e: 0.5, i: 0.3, raan: 0.7, argPe: 1.9 }),
      orbit({ a: -800_000, e: 1.6, i: 1.0, raan: 2.5, argPe: -0.4 }),
    ];
    for (const o of cases) {
      for (const t of [0, 60, 600, 3600]) {
        const { r, v } = elementsToStateVectors(o, MU, t);
        const energy = v.lengthSq() / 2 - MU / r.length();
        expect(energy).toBeCloseTo(-MU / (2 * o.a), 4);
      }
    }
  });

  it('periapsis distance matches a(1-e)', () => {
    const o = orbit({ a: 1_000_000, e: 0.4, m0: 0 }); // m0=0 ⇒ at periapsis at t=0
    const { r } = elementsToStateVectors(o, MU, 0);
    expect(r.length()).toBeCloseTo(600_000, 4);
  });
});

describe('stateVectorsToElements round-trips', () => {
  const cases: Array<[string, Orbit]> = [
    ['generic elliptic', orbit({ a: 850_000, e: 0.25, i: 0.6, raan: 1.2, argPe: 0.8, m0: 1.5 })],
    ['near-circular inclined', orbit({ a: 700_000, e: 1e-9, i: 0.9, raan: 2.0, m0: 0.3 })],
    ['circular equatorial', orbit({ a: 700_000, e: 0, i: 0, m0: 0.7 })],
    ['elliptic equatorial', orbit({ a: 900_000, e: 0.35, i: 0, argPe: 2.4, m0: 1.1 })],
    ['retrograde equatorial', orbit({ a: 800_000, e: 0.2, i: Math.PI, argPe: 0.5, m0: 0.9 })],
    ['polar', orbit({ a: 750_000, e: 0.1, i: Math.PI / 2, raan: 0.4, argPe: 1.0, m0: 2.0 })],
    ['hyperbolic flyby', orbit({ a: -600_000, e: 1.8, i: 0.5, raan: 0.9, argPe: 1.4, m0: -0.5 })],
    ['high eccentricity', orbit({ a: 5_000_000, e: 0.93, i: 0.2, raan: 3.0, argPe: 2.8, m0: 0.1 })],
  ];

  for (const [label, o] of cases) {
    it(`${label}: elements → r,v → elements reproduces the trajectory`, () => {
      const t0 = 1000;
      const { r, v } = elementsToStateVectors(o, MU, t0);
      const back = stateVectorsToElements(r, v, MU, BODY, t0);

      // The recovered angle decomposition may differ in singular cases, so
      // compare trajectories, not raw angles: same state now and later.
      const s0 = elementsToStateVectors(back, MU, t0);
      expect(relError(r, s0.r), 'position at t0').toBeLessThan(1e-9);
      expect(relError(v, s0.v), 'velocity at t0').toBeLessThan(1e-9);

      const t1 = t0 + 1234.5;
      const expected = elementsToStateVectors(o, MU, t1);
      const actual = elementsToStateVectors(back, MU, t1);
      expect(relError(expected.r, actual.r), 'position at t1').toBeLessThan(1e-8);
      expect(relError(expected.v, actual.v), 'velocity at t1').toBeLessThan(1e-8);
    });
  }

  it('recovers scalar invariants (a, e, i) exactly enough', () => {
    const o = orbit({ a: 850_000, e: 0.25, i: 0.6, raan: 1.2, argPe: 0.8, m0: 1.5 });
    const { r, v } = elementsToStateVectors(o, MU, 500);
    const back = stateVectorsToElements(r, v, MU, BODY, 500);
    expect(back.a).toBeCloseTo(o.a, 3);
    expect(back.e).toBeCloseTo(o.e, 9);
    expect(back.i).toBeCloseTo(o.i, 9);
  });

  it('rejects degenerate radial trajectories', () => {
    const r = new Vec3(700_000, 0, 0);
    const v = new Vec3(100, 0, 0); // purely radial
    expect(() => stateVectorsToElements(r, v, MU, BODY, 0)).toThrow(/degenerate/);
  });
});
