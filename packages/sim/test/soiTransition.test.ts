import { describe, expect, it } from 'vitest';
import { SystemTree, type CelestialBodyDef } from '../src/bodies/CelestialBody.js';
import type { Orbit } from '../src/orbit/Orbit.js';
import { elementsToStateVectors } from '../src/orbit/stateVectors.js';
import { nextRadiusCrossing, findSoiEntry, planTransitions } from '../src/orbit/soiTransition.js';
import { Simulation, type SimEvent } from '../src/Simulation.js';

const HELIOS: CelestialBodyDef = {
  id: 'helios',
  name: 'Helios',
  mu: 1.172e18,
  radius: 26_160_000,
  soiRadius: Infinity,
  rotationPeriod: 0,
};
const TERRA: CelestialBodyDef = {
  id: 'terra',
  name: 'Terra',
  mu: 3.5316e12,
  radius: 600_000,
  soiRadius: 84_159_286,
  rotationPeriod: 21_600,
  atmosphere: { seaLevelDensity: 1.225, scaleHeight: 5_600, height: 70_000 },
  parentId: 'helios',
  orbit: { bodyId: 'helios', a: 13_599_840_256, e: 0, i: 0, raan: 0, argPe: 0, m0: 3.14, epoch: 0 },
};
const LUNA: CelestialBodyDef = {
  id: 'luna',
  name: 'Luna',
  mu: 6.5138e10,
  radius: 200_000,
  soiRadius: 2_429_559,
  rotationPeriod: 138_984,
  parentId: 'terra',
  orbit: { bodyId: 'terra', a: 12_000_000, e: 0, i: 0, raan: 0, argPe: 0, m0: 1.7, epoch: 0 },
};

const tree = new SystemTree([HELIOS, TERRA, LUNA]);
const MU = TERRA.mu;

/**
 * Hohmann-style transfer from a 675 km circular radius up to Luna's orbit,
 * with the apoapsis aimed at where Luna will be at arrival.
 */
function lunaTransferOrbit(): { orbit: Orbit; arrivalTime: number } {
  const r1 = 675_000;
  const r2 = 12_000_000;
  const a = (r1 + r2) / 2;
  const transferTime = Math.PI * Math.sqrt(a ** 3 / MU);
  const lunaN = Math.sqrt(MU / LUNA.orbit!.a ** 3);
  const lunaAngleAtArrival = LUNA.orbit!.m0 + lunaN * transferTime;
  return {
    orbit: {
      bodyId: 'terra',
      a,
      e: (r2 - r1) / (r2 + r1),
      i: 0,
      raan: 0,
      argPe: lunaAngleAtArrival - Math.PI, // apoapsis points at Luna's arrival spot
      m0: 0,
      epoch: 0,
    },
    arrivalTime: transferTime,
  };
}

describe('nextRadiusCrossing', () => {
  const orbit: Orbit = { bodyId: 'terra', a: 1_000_000, e: 0.3, i: 0.2, raan: 0.5, argPe: 1.1, m0: 0.7, epoch: 0 };

  it('matches a brute-force scan for ascending and descending crossings', () => {
    const target = 1_100_000;
    for (const direction of ['ascending', 'descending'] as const) {
      const predicted = nextRadiusCrossing(orbit, MU, target, 0, direction);
      expect(predicted).not.toBeNull();

      // brute force: 0.25 s scan for the first signed crossing
      let found: number | null = null;
      let prev = elementsToStateVectors(orbit, MU, 0).r.length() - target;
      for (let t = 0.25; t < 10_000; t += 0.25) {
        const d = elementsToStateVectors(orbit, MU, t).r.length() - target;
        const crossed = direction === 'ascending' ? prev < 0 && d >= 0 : prev > 0 && d <= 0;
        if (crossed) {
          found = t;
          break;
        }
        prev = d;
      }
      expect(found).not.toBeNull();
      expect(Math.abs(predicted! - found!)).toBeLessThan(0.5);
    }
  });

  it('returns null for radii the orbit never reaches', () => {
    expect(nextRadiusCrossing(orbit, MU, 100_000, 0, 'ascending')).toBeNull();
    expect(nextRadiusCrossing(orbit, MU, 5_000_000, 0, 'ascending')).toBeNull();
  });

  it('the crossing radius is exact when propagated', () => {
    const target = 1_200_000;
    const t = nextRadiusCrossing(orbit, MU, target, 0, 'ascending')!;
    const r = elementsToStateVectors(orbit, MU, t).r.length();
    expect(Math.abs(r - target) / target).toBeLessThan(1e-9);
  });
});

describe('findSoiEntry', () => {
  it('detects the Luna encounter of an aimed transfer orbit', () => {
    const { orbit, arrivalTime } = lunaTransferOrbit();
    const entry = findSoiEntry(tree, orbit, 0, arrivalTime * 1.2);
    expect(entry).not.toBeNull();
    expect(entry!.targetBodyId).toBe('luna');
    expect(entry!.time).toBeLessThan(arrivalTime);

    // at the reported time, distance to Luna equals Luna's SOI radius
    const vessel = elementsToStateVectors(orbit, MU, entry!.time).r;
    const luna = tree.localState('luna', entry!.time).r;
    expect(Math.abs(vessel.sub(luna).length() - LUNA.soiRadius) / LUNA.soiRadius).toBeLessThan(1e-6);

    // brute-force cross-check at 1 s resolution
    let bruteforce: number | null = null;
    for (let t = 0; t < arrivalTime * 1.2; t += 1) {
      const d = elementsToStateVectors(orbit, MU, t).r.sub(tree.localState('luna', t).r).length();
      if (d < LUNA.soiRadius) {
        bruteforce = t;
        break;
      }
    }
    expect(bruteforce).not.toBeNull();
    expect(Math.abs(entry!.time - bruteforce!)).toBeLessThan(2);
  });

  it('finds nothing for an orbit that stays far from Luna', () => {
    const low: Orbit = { bodyId: 'terra', a: 700_000, e: 0.01, i: 0, raan: 0, argPe: 0, m0: 0, epoch: 0 };
    expect(findSoiEntry(tree, low, 0, 500_000)).toBeNull();
  });
});

describe('planTransitions', () => {
  it('schedules soiExit for an escape trajectory', () => {
    // Luna-free tree: the aimed escape would otherwise (correctly!) clip Luna's SOI
    const noLuna = new SystemTree([HELIOS, TERRA]);
    const escape: Orbit = { bodyId: 'terra', a: -2_000_000, e: 1.5, i: 0, raan: 0, argPe: 0, m0: 0.1, epoch: 0 };
    const plan = planTransitions(noLuna, escape, 0);
    expect(plan.next?.kind).toBe('soiExit');
    const r = elementsToStateVectors(escape, MU, plan.next!.time).r.length();
    expect(Math.abs(r - TERRA.soiRadius) / TERRA.soiRadius).toBeLessThan(1e-9);
  });

  it('schedules dropToPhysics for an orbit dipping into the atmosphere', () => {
    const dipping: Orbit = { bodyId: 'terra', a: 800_000, e: 0.2, i: 0, raan: 0, argPe: 0, m0: Math.PI, epoch: 0 };
    // periapsis = 640 km radius = 40 km altitude → inside the 70 km atmosphere
    const plan = planTransitions(tree, dipping, 0);
    expect(plan.next?.kind).toBe('dropToPhysics');
    const r = elementsToStateVectors(dipping, MU, plan.next!.time).r.length();
    expect(Math.abs(r - (TERRA.radius + 70_000))).toBeLessThan(1);
  });

  it('prefers the Luna encounter when it comes first', () => {
    const { orbit } = lunaTransferOrbit();
    const plan = planTransitions(tree, orbit, 0);
    expect(plan.next?.kind).toBe('soiEntry');
  });
});

describe('Simulation warp across transitions', () => {
  /** Set up a sim with one on-rails vessel on the Luna transfer. */
  function makeTransferSim(): Simulation {
    const sim = new Simulation(new SystemTree([HELIOS, TERRA, LUNA]));
    const vessel = sim.spawnLanded('v', { name: 'probe', stages: [{ dryMass: 100, fuelMass: 0, thrust: 0, ispVac: 1, ispSL: 1, dragArea: 0 }] }, 'terra', 0);
    const { orbit } = lunaTransferOrbit();
    vessel.motion = { kind: 'rails', orbit };
    return sim;
  }

  it('warp clamps at the SOI boundary and re-frames the orbit around Luna', () => {
    const sim = makeTransferSim();
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));

    sim.setWarp(100_000);
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'soiChange'); i++) {
      sim.advance(0.5);
    }

    const soi = events.find((e) => e.type === 'soiChange');
    expect(soi).toBeTruthy();
    expect(soi!.type === 'soiChange' && soi!.toBodyId).toBe('luna');

    const state = sim.vesselState('v');
    expect(state.bodyId).toBe('luna');
    expect(state.r.length()).toBeLessThanOrEqual(LUNA.soiRadius * 1.001);
  });

  it('a dead-center transfer impacts Luna instead of sailing through it (regression)', () => {
    // the aimed Hohmann transfer has its Luna-flyby periapsis below the
    // surface; the vessel must drop to physics at the terrain margin and
    // crash — an earlier bug re-railed it and slingshotted it out of the system
    const sim = makeTransferSim();
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));

    sim.setWarp(100_000);
    for (let i = 0; i < 2000 && !events.some((e) => e.type === 'crashed'); i++) {
      sim.advance(0.5);
    }

    expect(events.some((e) => e.type === 'soiChange' && e.toBodyId === 'luna')).toBe(true);
    expect(events.some((e) => e.type === 'offRails')).toBe(true);
    expect(events.some((e) => e.type === 'crashed')).toBe(true);
    expect(sim.getVessel('v').destroyed).toBe(true);
    // and it never bounced back out of Luna's SOI
    expect(events.some((e) => e.type === 'soiChange' && e.toBodyId === 'terra')).toBe(false);
    expect(sim.vesselState('v').bodyId).toBe('luna');
  });

  it('different warp chunkings produce the same transition time and orbit', () => {
    const results = [100_000, 1_000].map((warp) => {
      const sim = makeTransferSim();
      let soiTime = 0;
      sim.onEvent((e) => {
        if (e.type === 'soiChange') soiTime = sim.simTime;
      });
      sim.setWarp(warp);
      for (let i = 0; i < 4000 && soiTime === 0; i++) sim.advance(0.11);
      const vessel = sim.getVessel('v');
      const orbit = vessel.motion.kind === 'rails' ? vessel.motion.orbit : null;
      return { soiTime, orbit };
    });

    expect(results[0]!.soiTime).toBeGreaterThan(0);
    expect(Math.abs(results[0]!.soiTime - results[1]!.soiTime)).toBeLessThan(1e-6);
    expect(results[0]!.orbit).not.toBeNull();
    expect(results[0]!.orbit!.a).toBeCloseTo(results[1]!.orbit!.a, 6);
    expect(results[0]!.orbit!.e).toBeCloseTo(results[1]!.orbit!.e, 10);
  });
});
