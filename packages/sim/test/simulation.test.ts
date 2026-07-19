import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/math/vec3.js';
import { SystemTree } from '../src/bodies/CelestialBody.js';
import { Simulation, TICK_DT, type SimEvent } from '../src/Simulation.js';
import type { CelestialBodyDef } from '../src/bodies/CelestialBody.js';
import type { VesselConfig } from '../src/vessel/Vessel.js';
import { G0 } from '../src/vessel/Vessel.js';

// Terra-alone system keeps these tests independent of @sfs/data
const TERRA: CelestialBodyDef = {
  id: 'terra',
  name: 'Terra',
  mu: 3.5316e12,
  radius: 600_000,
  soiRadius: Infinity,
  rotationPeriod: 21_600,
  atmosphere: { seaLevelDensity: 1.225, scaleHeight: 5_600, height: 70_000 },
};

const TEST_ROCKET: VesselConfig = {
  name: 'Test Rocket',
  stages: [
    { dryMass: 4_000, fuelMass: 16_000, thrust: 450_000, ispVac: 290, ispSL: 250, dragArea: 4 },
    { dryMass: 800, fuelMass: 2_700, thrust: 60_000, ispVac: 340, ispSL: 120, dragArea: 1.2 },
    { dryMass: 800, fuelMass: 0, thrust: 0, ispVac: 1, ispSL: 1, dragArea: 0.8 },
  ],
};

function makeSim(): Simulation {
  return new Simulation(new SystemTree([TERRA]));
}

function run(sim: Simulation, seconds: number): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) sim.tick();
}

describe('landed vessel', () => {
  it('rides the surface rotation without drifting in altitude', () => {
    const sim = makeSim();
    sim.spawnLanded('v1', TEST_ROCKET, 'terra', 0);
    run(sim, 600);
    const readout = sim.vesselReadout('v1');
    expect(readout.landed).toBe(true);
    expect(Math.abs(readout.altitude)).toBeLessThan(1e-6);
    // surface speed relative to the rotating ground stays ~0
    expect(readout.surfaceSpeed).toBeLessThan(1e-6);
  });

  it('does not lift off below TWR 1 but burns fuel trying', () => {
    const weak: VesselConfig = {
      name: 'Weak',
      stages: [{ dryMass: 10_000, fuelMass: 10_000, thrust: 100_000, ispVac: 300, ispSL: 250, dragArea: 2 }],
    };
    const sim = makeSim();
    const vessel = sim.spawnLanded('v1', weak, 'terra', 0);
    sim.setThrottle('v1', 1);
    run(sim, 10);
    expect(sim.vesselReadout('v1').landed).toBe(true);
    expect(vessel.activeStage().fuel).toBeLessThan(10_000);
  });

  it('lifts off at full throttle and climbs', () => {
    const sim = makeSim();
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));
    sim.spawnLanded('v1', TEST_ROCKET, 'terra', 0);
    sim.setThrottle('v1', 1);
    run(sim, 20);
    expect(events.some((e) => e.type === 'liftoff')).toBe(true);
    const readout = sim.vesselReadout('v1');
    expect(readout.landed).toBe(false);
    expect(readout.altitude).toBeGreaterThan(500);
  });
});

describe('fuel flow', () => {
  it('drains at thrust/(Isp·g0) in vacuum conditions', () => {
    // spawn on an airless copy of Terra so Isp is exactly ispVac
    const airless: CelestialBodyDef = { ...TERRA, atmosphere: undefined };
    const sim = new Simulation(new SystemTree([airless]));
    const vessel = sim.spawnLanded('v1', TEST_ROCKET, 'terra', 0);
    sim.setThrottle('v1', 1);
    const burn = 10;
    run(sim, burn);
    const expected = (450_000 / (290 * G0)) * burn;
    const burned = 16_000 - vessel.activeStage().fuel;
    expect(burned).toBeCloseTo(expected, 0);
  });

  it('an empty stage produces no thrust', () => {
    const tiny: VesselConfig = {
      name: 'Tiny',
      stages: [
        { dryMass: 500, fuelMass: 20, thrust: 50_000, ispVac: 300, ispSL: 250, dragArea: 1 },
        { dryMass: 300, fuelMass: 0, thrust: 0, ispVac: 1, ispSL: 1, dragArea: 0.5 },
      ],
    };
    const sim = makeSim();
    const vessel = sim.spawnLanded('v1', tiny, 'terra', 0);
    sim.setThrottle('v1', 1);
    run(sim, 30);
    expect(vessel.activeStage().fuel).toBe(0);
    expect(vessel.currentThrust()).toBe(0);
  });
});

// TEST_ROCKET with individually switchable engines (part iids 1 and 5)
const SWITCH_ROCKET: VesselConfig = {
  name: 'Switchable',
  stages: [
    {
      dryMass: 4_000,
      fuelMass: 16_000,
      thrust: 450_000,
      ispVac: 290,
      ispSL: 250,
      dragArea: 4,
      engines: [{ iid: 1, title: 'Main', thrust: 450_000, ispVac: 290, ispSL: 250 }],
    },
    {
      dryMass: 800,
      fuelMass: 2_700,
      thrust: 60_000,
      ispVac: 340,
      ispSL: 120,
      dragArea: 1.2,
      engines: [{ iid: 5, title: 'Vac', thrust: 60_000, ispVac: 340, ispSL: 120 }],
    },
    { dryMass: 800, fuelMass: 0, thrust: 0, ispVac: 1, ispSL: 1, dragArea: 0.8, engines: [] },
  ],
};

describe('engine switches', () => {
  it('lights only the bottom stage at spawn', () => {
    const sim = makeSim();
    const vessel = sim.spawnLanded('v1', SWITCH_ROCKET, 'terra', 0);
    expect(vessel.engineOn.get(1)).toBe(true);
    expect(vessel.engineOn.get(5)).toBe(false);
  });

  it('produces no thrust and burns no fuel with the main engine switched off', () => {
    const sim = makeSim();
    const vessel = sim.spawnLanded('v1', SWITCH_ROCKET, 'terra', 0);
    sim.setEngine('v1', 1, false);
    sim.setThrottle('v1', 1);
    run(sim, 5);
    expect(vessel.currentThrust()).toBe(0);
    expect(sim.vesselReadout('v1').landed).toBe(true);
    expect(vessel.stages[0]!.fuel).toBe(16_000);
  });

  it('a lit upper-stage engine burns its own tank, not the bottom one', () => {
    const sim = makeSim();
    const vessel = sim.spawnLanded('v1', SWITCH_ROCKET, 'terra', 0);
    sim.setEngine('v1', 1, false);
    sim.setEngine('v1', 5, true);
    sim.setThrottle('v1', 1);
    expect(vessel.currentThrust()).toBe(60_000);
    run(sim, 5);
    expect(vessel.stages[0]!.fuel).toBe(16_000);
    expect(vessel.stages[1]!.fuel).toBeLessThan(2_700);
  });

  it('staging jettisons the old engine switch and auto-ignites the next stage', () => {
    const sim = makeSim();
    const vessel = sim.spawnLanded('v1', SWITCH_ROCKET, 'terra', 0);
    sim.stage('v1');
    expect(vessel.engineOn.has(1)).toBe(false);
    expect(vessel.engineOn.get(5)).toBe(true);
    expect(vessel.engineList()).toEqual([
      { iid: 5, title: 'Vac', on: true, hasFuel: true, stageIndex: 0 },
    ]);
  });
});

describe('staging debris', () => {
  it('detaches the spent stage as a falling vessel that despawns on impact', () => {
    const sim = makeSim();
    sim.debrisEnabled = true;
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));
    const vessel = sim.spawnLanded('v1', TEST_ROCKET, 'terra', 0);
    sim.setThrottle('v1', 1);
    run(sim, 20); // well clear of the pad
    sim.setThrottle('v1', 0);
    const fuelAtSeparation = vessel.stages[0]!.fuel;
    sim.stage('v1');

    const spawned = events.find((e) => e.type === 'debrisSpawned');
    expect(spawned).toMatchObject({ fromVesselId: 'v1', sectionIndex: 0 });
    const debrisId = (spawned as { vesselId: string }).vesselId;
    const debris = sim.getVessel(debrisId);
    expect(debris.isDebris).toBe(true);
    expect(debris.stages.length).toBe(1);
    // inherits the jettisoned stage's mass and remaining fuel
    expect(debris.stages[0]!.def.dryMass).toBe(4_000);
    expect(debris.stages[0]!.fuel).toBe(fuelAtSeparation);
    expect(debris.currentThrust()).toBe(0);

    // gravity takes over: it falls back and is removed on ground impact
    run(sim, 120);
    expect(sim.hasVessel(debrisId)).toBe(false);
    expect(events.some((e) => e.type === 'debrisRemoved' && e.vesselId === debrisId)).toBe(true);
  });

  it('spawns no debris when disabled (server default)', () => {
    const sim = makeSim();
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));
    sim.spawnLanded('v1', TEST_ROCKET, 'terra', 0);
    sim.setThrottle('v1', 1);
    run(sim, 20);
    sim.stage('v1');
    expect(events.some((e) => e.type === 'debrisSpawned')).toBe(false);
    expect([...sim.vessels()].length).toBe(1);
  });

  it('never blocks warp: physics debris is culled when rails warp starts', () => {
    const sim = makeSim();
    sim.debrisEnabled = true;
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));
    // player safely on rails in a 700 km circular orbit
    sim.spawnVessel('v1', TEST_ROCKET, {
      kind: 'rails',
      orbit: { bodyId: 'terra', a: 700_000, e: 0, i: 0, raan: 0, argPe: 0, m0: 0, epoch: 0 },
    });
    // leftover debris still falling through the atmosphere
    sim.spawnVessel(
      'd1',
      { name: 'junk', stages: [TEST_ROCKET.stages[0]!], debris: true },
      {
        kind: 'physics',
        bodyId: 'terra',
        r: new Vec3(660_000, 0, 0),
        v: new Vec3(0, 100, 0),
        landed: false,
      },
    );

    expect(sim.maxAllowedWarp()).toBeGreaterThan(4);
    sim.setWarp(1_000);
    sim.advance(0.1);
    expect(sim.hasVessel('d1')).toBe(false);
    expect(events.some((e) => e.type === 'debrisRemoved' && e.vesselId === 'd1')).toBe(true);
    expect(sim.hasVessel('v1')).toBe(true);
  });
});

describe('staging', () => {
  it('drops mass and emits an event, but never discards the last stage', () => {
    const sim = makeSim();
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));
    const vessel = sim.spawnLanded('v1', TEST_ROCKET, 'terra', 0);
    const m0 = vessel.mass();

    sim.stage('v1');
    expect(vessel.mass()).toBeLessThan(m0);
    expect(vessel.stages.length).toBe(2);
    expect(events.filter((e) => e.type === 'stage').length).toBe(1);

    sim.stage('v1');
    sim.stage('v1'); // no-op: capsule remains
    expect(vessel.stages.length).toBe(1);
  });
});

describe('scripted launch to orbit', () => {
  it('a simple gravity turn reaches a stable orbit and goes on rails', () => {
    const sim = makeSim();
    const events: SimEvent[] = [];
    sim.onEvent((e) => events.push(e));
    const vessel = sim.spawnLanded('kerman', TEST_ROCKET, 'terra', 0);
    sim.setThrottle('kerman', 1);

    const radialHeading = () => {
      const { r } = sim.vesselState('kerman');
      return Math.atan2(r.y, r.x);
    };
    // prograde = radial rotated -90° (eastward, with the planet's spin)
    const progradeHeading = () => radialHeading() - Math.PI / 2;

    // naive closed-loop ascent: pitch from up to prograde as apoapsis rises
    for (let i = 0; i < 60_000; i++) {
      const readout = sim.vesselReadout('kerman');
      // suborbital coasts can go on rails too (M2); done only once peri is up
      if (readout.onRails && readout.periapsis > 74_000) break;

      const apoFrac = Math.min(1, Math.max(0, readout.apoapsis / 90_000));
      // blend heading from radial-up to horizontal-prograde
      vessel.heading = radialHeading() - (Math.PI / 2) * apoFrac;

      if (readout.stagesLeft === 3 && readout.fuel <= 0) sim.stage('kerman');

      if (readout.apoapsis > 90_000 && readout.altitude < 71_000) {
        sim.setThrottle('kerman', 0); // coast out of the atmosphere
      } else if (readout.altitude >= 71_000 && readout.periapsis < 75_000) {
        // circularize near apoapsis: burn prograde once past the atmosphere
        vessel.heading = progradeHeading();
        sim.setThrottle('kerman', readout.speed > 0 ? 1 : 0);
        if (readout.stagesLeft === 3) sim.stage('kerman');
      } else if (readout.periapsis >= 75_000) {
        sim.setThrottle('kerman', 0);
      }

      sim.tick();
    }

    const final = sim.vesselReadout('kerman');
    expect(final.destroyed).toBe(false);
    expect(final.onRails).toBe(true);
    expect(final.periapsis).toBeGreaterThan(70_000);
    expect(final.apoapsis).toBeGreaterThan(final.periapsis - 1);
    expect(events.some((e) => e.type === 'onRails')).toBe(true);

    // sanity: orbital speed near vis-viva for the achieved orbit
    const { r, v } = sim.vesselState('kerman');
    const visViva = Math.sqrt(TERRA.mu * (2 / r.length() - 1 / (r.length() / (1 - 0)))); // ~circular bound
    expect(v.length()).toBeGreaterThan(0.8 * visViva);
  });
});
