import { Vec3 } from '../math/vec3.js';
import type { Orbit } from '../orbit/Orbit.js';

/**
 * M1 vessel model: a serial stack of stages, bottom stage active. This is the
 * flight-dynamics view of a craft (mass, thrust, drag per stage); M3 replaces
 * its *construction* with the part tree, which will compile down to the same
 * per-stage quantities.
 */
export interface StageDef {
  /** structure mass without fuel, kg */
  dryMass: number;
  /** initial propellant, kg */
  fuelMass: number;
  /** vacuum thrust, N (0 for unpowered stages, e.g. the capsule) */
  thrust: number;
  ispVac: number;
  ispSL: number;
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

  /** the stage currently providing thrust (bottom of the remaining stack) */
  activeStage(): StageState {
    return this.stages[0]!;
  }

  /** effective Isp blended between sea level and vacuum by atmosphere fraction */
  effectiveIsp(atmosphereFraction: number): number {
    const { ispVac, ispSL } = this.activeStage().def;
    return ispVac + (ispSL - ispVac) * atmosphereFraction;
  }

  /** current thrust magnitude, N (0 when out of fuel or throttled down) */
  currentThrust(): number {
    const stage = this.activeStage();
    if (stage.fuel <= 0) return 0;
    return stage.def.thrust * this.throttle;
  }

  /** thrust/long-axis direction as a unit vector in the SOI body frame */
  thrustDirection(): Vec3 {
    return new Vec3(Math.cos(this.heading), Math.sin(this.heading), 0);
  }

  /**
   * Drop the bottom stage. Returns the jettisoned stage state, or null if
   * this is the last stage (a lone capsule can't discard itself).
   */
  jettisonStage(): StageState | null {
    if (this.stages.length <= 1) return null;
    return this.stages.shift() ?? null;
  }
}
