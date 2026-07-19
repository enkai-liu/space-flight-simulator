import { Vec3 } from '../math/vec3.js';
import type { CelestialBodyDef } from '../bodies/CelestialBody.js';
import type { Vessel } from '../vessel/Vessel.js';
import { airDensity, atmosphereFraction } from './atmosphere.js';
import type { AccelerationFn } from './integrator.js';

/** Angular velocity vector of a body's rotation (about the +Z pole), rad/s. */
export function bodyAngularVelocity(body: CelestialBodyDef): Vec3 {
  if (body.rotationPeriod === 0) return Vec3.ZERO;
  return new Vec3(0, 0, (2 * Math.PI) / body.rotationPeriod);
}

/** Velocity of the co-rotating atmosphere/surface at position r in the body frame. */
export function surfaceVelocity(body: CelestialBodyDef, r: Vec3): Vec3 {
  return bodyAngularVelocity(body).cross(r);
}

/**
 * Builds the acceleration function for one off-rails vessel around one body:
 * point gravity + engine thrust + atmospheric drag (patched-conic consistent —
 * only the SOI body attracts).
 *
 * Mass and thrust are frozen for the duration of one 0.02 s step; fuel is
 * drained after the step (error is negligible at this dt).
 */
export function vesselAcceleration(body: CelestialBodyDef, vessel: Vessel): AccelerationFn {
  const mass = vessel.mass();
  const dragArea = vessel.dragArea();
  const thrustDir = vessel.thrustDirection();

  return (r: Vec3, v: Vec3): Vec3 => {
    const rLen = r.length();

    // gravity
    let accel = r.scale(-body.mu / (rLen * rLen * rLen));

    // thrust (Isp blending affects fuel burn, not thrust magnitude, in M1)
    const thrust = vessel.currentThrust();
    if (thrust > 0) {
      accel = accel.add(thrustDir.scale(thrust / mass));
    }

    // drag against the co-rotating atmosphere
    const altitude = rLen - body.radius;
    const rho = airDensity(body.atmosphere, altitude);
    if (rho > 0 && dragArea > 0) {
      const vAir = v.sub(surfaceVelocity(body, r));
      const speed = vAir.length();
      if (speed > 0) {
        const dragAccel = (0.5 * rho * speed * speed * dragArea) / mass;
        accel = accel.add(vAir.scale(-dragAccel / speed));
      }
    }

    return accel;
  };
}

/**
 * Propellant mass-flow rate per stage, kg/s — each stage's firing engines
 * drain that stage's own tanks (index-aligned with vessel.stages).
 */
export function stageFuelFlows(vessel: Vessel, body: CelestialBodyDef, altitude: number): number[] {
  if (vessel.throttle <= 0) return vessel.stages.map(() => 0);
  const frac = atmosphereFraction(body.atmosphere, altitude);
  return vessel.stages.map((_, i) => {
    const thrust = vessel.stageThrust(i) * vessel.throttle;
    if (thrust <= 0) return 0;
    return thrust / (vessel.stageIsp(i, frac) * 9.80665);
  });
}

/** Total propellant mass-flow rate at the vessel's current thrust, kg/s. */
export function fuelFlowRate(vessel: Vessel, body: CelestialBodyDef, altitude: number): number {
  return stageFuelFlows(vessel, body, altitude).reduce((sum, f) => sum + f, 0);
}
