export { Vec3 } from './math/vec3.js';
export { Quat } from './math/quat.js';
export type { Orbit } from './orbit/Orbit.js';
export { meanMotion, period, meanAnomalyAt, periapsis, apoapsis } from './orbit/Orbit.js';
export {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  trueAnomalyFromEccentric,
  trueAnomalyFromHyperbolic,
  eccentricFromTrueAnomaly,
  hyperbolicFromTrueAnomaly,
} from './orbit/keplerSolver.js';
export type { StateVectors } from './orbit/stateVectors.js';
export {
  elementsToStateVectors,
  stateVectorsToElements,
  clampEccentricity,
  orbitPositionAtTrueAnomaly,
} from './orbit/stateVectors.js';
export type { CelestialBodyDef, AtmosphereDef } from './bodies/CelestialBody.js';
export { SystemTree } from './bodies/CelestialBody.js';
export { airDensity, atmosphereFraction } from './flight/atmosphere.js';
export { rk4Step } from './flight/integrator.js';
export type { BodyState, AccelerationFn } from './flight/integrator.js';
export { vesselAcceleration, fuelFlowRate, surfaceVelocity, bodyAngularVelocity } from './flight/forces.js';
export { Vessel, MAX_TURN_RATE, G0 } from './vessel/Vessel.js';
export type { StageDef, VesselConfig, VesselMotion, StageState } from './vessel/Vessel.js';
export {
  validateCraft,
  compileCraft,
  craftSections,
  craftStats,
  stackOf,
  sidePartsOn,
  isStackPart,
  migrateCraft,
  partsTouch,
  ATTACH_EPS,
} from './vessel/craft.js';
export type {
  PartDef,
  PartCategory,
  CraftDesign,
  LegacyCraftDesign,
  CraftPart,
  CraftIssue,
} from './vessel/craft.js';
export { Simulation, TICK_DT, PHYSICS_WARP_TIERS, RAILS_WARP_TIERS } from './Simulation.js';
export type { SimEvent, SimEventListener } from './Simulation.js';
export { planTransitions, findSoiEntry, nextRadiusCrossing } from './orbit/soiTransition.js';
export type { Transition, TransitionPlan } from './orbit/soiTransition.js';
