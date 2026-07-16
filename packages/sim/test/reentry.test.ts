import { describe, expect, it } from 'vitest';
import { SystemTree, type CelestialBodyDef } from '../src/bodies/CelestialBody.js';
import type { Orbit } from '../src/orbit/Orbit.js';
import { Simulation, type SimEvent } from '../src/Simulation.js';
import type { VesselConfig } from '../src/vessel/Vessel.js';

const TERRA: CelestialBodyDef = {
  id: 'terra',
  name: 'Terra',
  mu: 3.5316e12,
  radius: 600_000,
  soiRadius: Infinity,
  rotationPeriod: 21_600,
  atmosphere: { seaLevelDensity: 1.225, scaleHeight: 5_600, height: 70_000 },
};

const CAPSULE: VesselConfig = {
  name: 'Capsule',
  stages: [
    { dryMass: 880, fuelMass: 0, thrust: 0, ispVac: 1, ispSL: 1, dragArea: 0.9, chuteArea: 250, maxHeat: 2600 },
  ],
};

const BARE_TANK: VesselConfig = {
  name: 'Debris',
  stages: [{ dryMass: 1_000, fuelMass: 0, thrust: 0, ispVac: 1, ispSL: 1, dragArea: 1.4, maxHeat: 1200 }],
};

/** Put a vessel on a decaying orbit and run until it lands or dies. */
function runReentry(config: VesselConfig, orbit: Orbit) {
  const sim = new Simulation(new SystemTree([TERRA]));
  const vessel = sim.spawnLanded('v', config, 'terra', 0);
  vessel.motion = { kind: 'rails', orbit };
  const events: SimEvent[] = [];
  sim.onEvent((e) => events.push(e));

  // warp to the atmosphere interface (sim auto-drops to physics there)…
  sim.setWarp(1_000);
  for (let i = 0; i < 500 && !events.some((e) => e.type === 'offRails'); i++) sim.advance(0.1);
  // …then integrate the entry
  sim.setWarp(4);
  for (
    let i = 0;
    i < 60_000 && !events.some((e) => e.type === 'landed' || e.type === 'crashed' || e.type === 'overheated');
    i++
  ) {
    sim.advance(0.1);
  }
  return { sim, vessel, events };
}

describe('re-entry (tuning-pinned behavior)', () => {
  it('a capsule with a parachute survives LEO re-entry', () => {
    // 75 km apoapsis, 30 km periapsis — a deorbited low-orbit capsule
    const { events, vessel } = runReentry(CAPSULE, {
      bodyId: 'terra',
      a: 652_500,
      e: 0.034,
      i: 0,
      raan: 0,
      argPe: 0,
      m0: Math.PI, // start at apoapsis
      epoch: 0,
    });
    expect(events.some((e) => e.type === 'offRails')).toBe(true);
    expect(events.some((e) => e.type === 'overheated')).toBe(false);
    expect(events.some((e) => e.type === 'chuteDeployed')).toBe(true);
    expect(events.some((e) => e.type === 'landed')).toBe(true);
    expect(vessel.destroyed).toBe(false);
  });

  it('an unshielded tank burns up on a fast Luna-return entry', () => {
    // apoapsis at Luna distance, periapsis 30 km → ~3.2 km/s at interface
    const { events, vessel } = runReentry(BARE_TANK, {
      bodyId: 'terra',
      a: 6_315_000,
      e: 0.9,
      i: 0,
      raan: 0,
      argPe: 0,
      m0: Math.PI,
      epoch: 0,
    });
    expect(events.some((e) => e.type === 'overheated')).toBe(true);
    expect(vessel.destroyed).toBe(true);
  });

  it('parachute terminal velocity is a safe landing speed', () => {
    const { events } = runReentry(CAPSULE, {
      bodyId: 'terra',
      a: 652_500,
      e: 0.034,
      i: 0,
      raan: 0,
      argPe: 0,
      m0: Math.PI,
      epoch: 0,
    });
    // landed (not crashed) already asserts touchdown below the crash threshold
    expect(events.some((e) => e.type === 'landed')).toBe(true);
    expect(events.some((e) => e.type === 'crashed')).toBe(false);
  });
});
