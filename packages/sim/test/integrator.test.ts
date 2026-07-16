import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/math/vec3.js';
import { rk4Step } from '../src/flight/integrator.js';
import { airDensity } from '../src/flight/atmosphere.js';
import { elementsToStateVectors, stateVectorsToElements } from '../src/orbit/stateVectors.js';
import { period } from '../src/orbit/Orbit.js';

const MU = 3.5316e12;

describe('rk4Step on a pure two-body problem', () => {
  const gravity = (r: Vec3) => r.scale(-MU / r.length() ** 3);
  const accel = (r: Vec3) => gravity(r);

  it('tracks the analytic Kepler solution around one full orbit', () => {
    const orbit = { bodyId: 'terra', a: 700_000, e: 0.1, i: 0, raan: 0, argPe: 0, m0: 0, epoch: 0 };
    const T = period(orbit, MU);
    let state = elementsToStateVectors(orbit, MU, 0);

    const dt = 0.02;
    const steps = Math.round(T / dt);
    for (let i = 0; i < steps; i++) {
      state = rk4Step(state, dt, accel);
    }

    const expected = elementsToStateVectors(orbit, MU, steps * dt);
    const posError = state.r.sub(expected.r).length();
    // < 1 m error after a ~40 min orbit of ~4.4M m circumference
    expect(posError).toBeLessThan(1);
  });

  it('conserves specific energy to ~1e-9 relative over 10 orbits', () => {
    const orbit = { bodyId: 'terra', a: 680_000, e: 0.05, i: 0, raan: 0, argPe: 0, m0: 0, epoch: 0 };
    let state = elementsToStateVectors(orbit, MU, 0);
    const energy = (s: { r: Vec3; v: Vec3 }) => s.v.lengthSq() / 2 - MU / s.r.length();
    const e0 = energy(state);

    const T = period(orbit, MU);
    const dt = 0.02;
    const steps = Math.round((10 * T) / dt);
    for (let i = 0; i < steps; i++) {
      state = rk4Step(state, dt, accel);
    }

    expect(Math.abs((energy(state) - e0) / e0)).toBeLessThan(1e-9);
  });

  it('conserves angular momentum direction and magnitude', () => {
    const orbit = { bodyId: 'terra', a: 750_000, e: 0.2, i: 0.5, raan: 1, argPe: 2, m0: 0.4, epoch: 0 };
    let state = elementsToStateVectors(orbit, MU, 0);
    const h0 = state.r.cross(state.v);
    for (let i = 0; i < 50_000; i++) {
      state = rk4Step(state, 0.02, accel);
    }
    const h1 = state.r.cross(state.v);
    expect(h1.sub(h0).length() / h0.length()).toBeLessThan(1e-10);
  });

  it('integrated state round-trips through element extraction', () => {
    const orbit = { bodyId: 'terra', a: 900_000, e: 0.3, i: 0.2, raan: 0.5, argPe: 1.5, m0: 1, epoch: 0 };
    let state = elementsToStateVectors(orbit, MU, 0);
    for (let i = 0; i < 10_000; i++) state = rk4Step(state, 0.02, accel);
    const recovered = stateVectorsToElements(state.r, state.v, MU, 'terra', 200);
    expect(recovered.a).toBeCloseTo(orbit.a, 0);
    expect(recovered.e).toBeCloseTo(orbit.e, 6);
    expect(recovered.i).toBeCloseTo(orbit.i, 8);
  });
});

describe('airDensity', () => {
  const atmo = { seaLevelDensity: 1.225, scaleHeight: 5_600, height: 70_000 };

  it('matches sea level and decays exponentially', () => {
    expect(airDensity(atmo, 0)).toBeCloseTo(1.225, 10);
    expect(airDensity(atmo, 5_600)).toBeCloseTo(1.225 / Math.E, 6);
  });

  it('is exactly zero above the cutoff and without an atmosphere', () => {
    expect(airDensity(atmo, 70_000)).toBe(0);
    expect(airDensity(atmo, 1e6)).toBe(0);
    expect(airDensity(undefined, 0)).toBe(0);
  });

  it('clamps below-ground altitude to sea level density', () => {
    expect(airDensity(atmo, -50)).toBeCloseTo(1.225, 10);
  });
});
