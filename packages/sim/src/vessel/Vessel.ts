import { Vec3 } from '../math/vec3.js';
import type { Orbit } from '../orbit/Orbit.js';

/**
 * M1 vessel model: a serial stack of stages, bottom stage active. This is the
 * flight-dynamics view of a craft (mass, thrust, drag per stage); M3 replaces
 * its *construction* with the part tree, which will compile down to the same
 * per-stage quantities.
 */
/** One individually switchable engine within a stage. */
export interface EngineDef {
  /** craft part instance id (stable across client/server for commands) */
  iid: number;
  title: string;
  thrust: number;
  ispVac: number;
  ispSL: number;
}

export interface StageDef {
  /** structure mass without fuel, kg */
  dryMass: number;
  /** initial propellant, kg */
  fuelMass: number;
  /** vacuum thrust, N (0 for unpowered stages, e.g. the capsule) */
  thrust: number;
  ispVac: number;
  ispSL: number;
  /**
   * Individually switchable engines summing (at most) to `thrust`. When
   * absent (legacy aggregate configs) the stage burns as one implicit engine
   * that only fires while it is the active bottom stage.
   */
  engines?: EngineDef[];
  /** drag coefficient × reference area contribution while attached, m² */
  dragArea: number;
  /** parachute Cd·A available in this section, m² */
  chuteArea?: number;
  /** heat tolerance, K above ambient (sturdiest part shields the section) */
  maxHeat?: number;
}

/** Fallback stage heat tolerance, K above ambient. */
export const DEFAULT_MAX_HEAT = 1_400;

export interface VesselConfig {
  name: string;
  /** index 0 = bottom stage, fired first, jettisoned first */
  stages: StageDef[];
  /** uncontrolled jettisoned hardware: engines stay off, never blocks warp */
  debris?: boolean;
}

export type VesselMotion =
  | { kind: 'rails'; orbit: Orbit }
  | {
      kind: 'physics';
      /** SOI body whose non-rotating frame r/v live in */
      bodyId: string;
      r: Vec3;
      v: Vec3;
      /** resting on the surface, co-rotating with it */
      landed: boolean;
    };

export interface StageState {
  def: StageDef;
  fuel: number;
}

export const G0 = 9.80665;

/** Max commanded turn rate, rad/s (kinematic attitude, plan §3.6). */
export const MAX_TURN_RATE = (45 * Math.PI) / 180;

export class Vessel {
  motion: VesselMotion;
  /** remaining stages, [0] = bottom = active */
  readonly stages: StageState[];
  /** stage count at construction — locates jettisoned sections in the design */
  readonly initialStageCount: number;
  readonly isDebris: boolean;
  /** ignition switch per engine iid; missing iid = engine already jettisoned */
  readonly engineOn = new Map<number, boolean>();
  /**
   * M1 planar attitude: direction of the vessel's long axis (thrust direction)
   * in the equatorial (XY) plane, measured from +X. Full 3D attitude arrives
   * with the navball.
   */
  heading = Math.PI / 2;
  /** commanded rotation, -1 | 0 | 1, scaled by MAX_TURN_RATE */
  turnInput = 0;
  /** 0..1 */
  throttle = 0;
  destroyed = false;
  /** skin temperature, K above ambient (re-entry heating) */
  heat = 0;
  chuteDeployed = false;

  constructor(
    readonly id: string,
    readonly name: string,
    config: VesselConfig,
    motion: VesselMotion,
  ) {
    if (config.stages.length === 0) throw new Error('vessel needs at least one stage');
    this.stages = config.stages.map((def) => ({ def, fuel: def.fuelMass }));
    this.initialStageCount = config.stages.length;
    this.isDebris = config.debris ?? false;
    // the bottom stage lights at spawn (matching the pre-switch behavior);
    // upper stages auto-ignite when staging makes them the bottom
    for (const [index, stage] of config.stages.entries()) {
      for (const engine of stage.engines ?? []) {
        this.engineOn.set(engine.iid, index === 0 && !this.isDebris);
      }
    }
    this.motion = motion;
  }

  /** current total mass, kg */
  mass(): number {
    let m = 0;
    for (const s of this.stages) m += s.def.dryMass + s.fuel;
    return m;
  }

  /** summed Cd·A of attached stages (+ canopy when deployed), m² */
  dragArea(): number {
    let a = 0;
    for (const s of this.stages) a += s.def.dragArea;
    if (this.chuteDeployed) a += this.chuteArea();
    return a;
  }

  /** total parachute Cd·A carried by the remaining stages, m² */
  chuteArea(): number {
    let a = 0;
    for (const s of this.stages) a += s.def.chuteArea ?? 0;
    return a;
  }

  /** heat tolerance of the stage facing the flow (the bottom one), K */
  maxHeat(): number {
    return this.activeStage().def.maxHeat ?? DEFAULT_MAX_HEAT;
  }

  /** the bottom of the remaining stack (fuel gauge, heat shielding) */
  activeStage(): StageState {
    return this.stages[0]!;
  }

  /** Flip one engine's ignition switch (unknown/jettisoned iids are ignored). */
  setEngine(iid: number, on: boolean): void {
    if (this.engineOn.has(iid)) this.engineOn.set(iid, on);
  }

  /**
   * Thrust available from one stage at full throttle, N: its switched-on
   * engines while it has fuel. Legacy aggregate stages (no engine list) fire
   * only while they are the bottom stage.
   */
  stageThrust(index: number): number {
    const stage = this.stages[index]!;
    if (stage.fuel <= 0) return 0;
    const engines = stage.def.engines;
    if (!engines) return index === 0 ? stage.def.thrust : 0;
    let thrust = 0;
    for (const e of engines) if (this.engineOn.get(e.iid)) thrust += e.thrust;
    return thrust;
  }

  /**
   * Effective Isp of one stage's firing engines, thrust-weighted and blended
   * between sea level and vacuum by atmosphere fraction.
   */
  stageIsp(index: number, atmosphereFraction: number): number {
    const stage = this.stages[index]!;
    const engines = stage.def.engines;
    if (!engines) {
      const { ispVac, ispSL } = stage.def;
      return ispVac + (ispSL - ispVac) * atmosphereFraction;
    }
    let thrust = 0;
    let weighted = 0;
    for (const e of engines) {
      if (!this.engineOn.get(e.iid)) continue;
      thrust += e.thrust;
      weighted += e.thrust * (e.ispVac + (e.ispSL - e.ispVac) * atmosphereFraction);
    }
    return thrust > 0 ? weighted / thrust : 1;
  }

  /** current thrust magnitude, N — all firing engines scaled by throttle */
  currentThrust(): number {
    let thrust = 0;
    for (let i = 0; i < this.stages.length; i++) thrust += this.stageThrust(i);
    return thrust * this.throttle;
  }

  /** per-engine state for UI/net sync, bottom stage first */
  engineList(): Array<{ iid: number; title: string; on: boolean; hasFuel: boolean; stageIndex: number }> {
    const list: Array<{ iid: number; title: string; on: boolean; hasFuel: boolean; stageIndex: number }> = [];
    for (const [stageIndex, stage] of this.stages.entries()) {
      for (const e of stage.def.engines ?? []) {
        list.push({
          iid: e.iid,
          title: e.title,
          on: this.engineOn.get(e.iid) === true,
          hasFuel: stage.fuel > 0,
          stageIndex,
        });
      }
    }
    return list;
  }

  /** thrust/long-axis direction as a unit vector in the SOI body frame */
  thrustDirection(): Vec3 {
    return new Vec3(Math.cos(this.heading), Math.sin(this.heading), 0);
  }

  /**
   * Drop the bottom stage. Returns the jettisoned stage state, or null if
   * this is the last stage (a lone capsule can't discard itself). The newly
   * exposed stage's engines auto-ignite, KSP-style.
   */
  jettisonStage(): StageState | null {
    if (this.stages.length <= 1) return null;
    const jettisoned = this.stages.shift()!;
    for (const e of jettisoned.def.engines ?? []) this.engineOn.delete(e.iid);
    for (const e of this.stages[0]!.def.engines ?? []) this.engineOn.set(e.iid, true);
    return jettisoned;
  }
}
