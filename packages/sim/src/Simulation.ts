import { Vec3 } from './math/vec3.js';
import { SystemTree, type CelestialBodyDef } from './bodies/CelestialBody.js';
import { periapsis, apoapsis, type Orbit } from './orbit/Orbit.js';
import { elementsToStateVectors, stateVectorsToElements } from './orbit/stateVectors.js';
import {
  planTransitions,
  nextRadiusCrossing,
  physicsFloorRadius,
  type TransitionPlan,
} from './orbit/soiTransition.js';
import { Vessel, MAX_TURN_RATE, G0, type VesselConfig } from './vessel/Vessel.js';
import { rk4Step } from './flight/integrator.js';
import { vesselAcceleration, fuelFlowRate, surfaceVelocity } from './flight/forces.js';
import { airDensity } from './flight/atmosphere.js';

/** Fixed physics timestep, s (plan §3.1). Never change at runtime. */
export const TICK_DT = 0.02;

/** Surface-relative speed below which ground contact is a landing, not a crash, m/s. */
const SAFE_LANDING_SPEED = 10;

// --- re-entry heating (plan §3.8: q ∝ ρv³, per-vessel scalar, deterministic) ---
/** fraction of stagnation heat flux absorbed by the skin (blunt-body shielding) */
const HEAT_ABSORB = 0.008;
/**
 * Effective heat capacity, J/(kg·K) of *skin temperature per total mass* —
 * deliberately tiny because burn-up is a surface effect: only ~0.5% of the
 * vessel's mass is the skin that takes the heat. Tuned by reentry.test.ts.
 */
const HEAT_CAPACITY = 5;
/** radiative/conductive cooling rate, 1/s */
const HEAT_COOL_RATE = 0.03;
/** parachutes rip above this airspeed, m/s */
const CHUTE_SAFE_SPEED = 350;
/** parachutes auto-deploy below this altitude, m */
const CHUTE_DEPLOY_ALTITUDE = 5_000;

/** Warp factors that run real integration (more sub-steps, same dt). */
export const PHYSICS_WARP_TIERS = [1, 2, 3, 4] as const;
/** Warp factors that jump sim time analytically — rails only (plan §3.7). */
export const RAILS_WARP_TIERS = [1, 2, 4, 8, 15, 45, 100, 1_000, 10_000, 100_000] as const;
const MAX_PHYSICS_WARP = 4;
/** Cap on integration sub-steps per advance() call so a slow frame can't spiral. */
const MAX_TICKS_PER_ADVANCE = 800;

export type SimEvent =
  | { type: 'liftoff'; vesselId: string }
  | { type: 'landed'; vesselId: string }
  | { type: 'crashed'; vesselId: string }
  | { type: 'stage'; vesselId: string; stagesLeft: number }
  | { type: 'stageEmpty'; vesselId: string }
  | { type: 'onRails'; vesselId: string }
  | { type: 'offRails'; vesselId: string }
  | { type: 'soiChange'; vesselId: string; fromBodyId: string; toBodyId: string }
  | { type: 'warpChanged'; factor: number }
  | { type: 'chuteDeployed'; vesselId: string }
  | { type: 'overheated'; vesselId: string };

export type SimEventListener = (event: SimEvent) => void;

/**
 * The deterministic core loop: owns sim time, all vessels, and the
 * rails ↔ physics state machine. Identical on client and server.
 */
export class Simulation {
  simTime = 0;
  warp = 1;
  private readonly vesselMap = new Map<string, Vessel>();
  private readonly listeners: SimEventListener[] = [];
  private accumulator = 0;
  /** patched-conic lookahead per rails vessel, invalidated when its orbit changes */
  private readonly plans = new Map<string, TransitionPlan>();

  constructor(readonly tree: SystemTree) {}

  onEvent(listener: SimEventListener): void {
    this.listeners.push(listener);
  }

  private emit(event: SimEvent): void {
    for (const l of this.listeners) l(event);
  }

  vessels(): IterableIterator<Vessel> {
    return this.vesselMap.values();
  }

  getVessel(id: string): Vessel {
    const v = this.vesselMap.get(id);
    if (!v) throw new Error(`unknown vessel: ${id}`);
    return v;
  }

  /** Spawn a vessel resting on a body's equator at the given longitude. */
  spawnLanded(id: string, config: VesselConfig, bodyId: string, longitude: number): Vessel {
    const body = this.tree.get(bodyId);
    const angle = this.tree.rotationAngle(bodyId, this.simTime) + longitude;
    const r = new Vec3(Math.cos(angle), Math.sin(angle), 0).scale(body.radius);
    const vessel = new Vessel(id, config.name, config, {
      kind: 'physics',
      bodyId,
      r,
      v: surfaceVelocity(body, r),
      landed: true,
    });
    // point straight up off the pad
    vessel.heading = angle;
    this.vesselMap.set(id, vessel);
    return vessel;
  }

  /** Spawn a vessel with explicit motion (multiplayer remotes, mid-flight joins). */
  spawnVessel(id: string, config: VesselConfig, motion: Vessel['motion']): Vessel {
    const vessel = new Vessel(id, config.name, config, motion);
    this.vesselMap.set(id, vessel);
    return vessel;
  }

  removeVessel(id: string): void {
    this.vesselMap.delete(id);
    this.plans.delete(id);
  }

  hasVessel(id: string): boolean {
    return this.vesselMap.has(id);
  }

  /** Fire the next stage: jettison the spent bottom stage. */
  stage(vesselId: string): void {
    const vessel = this.getVessel(vesselId);
    if (vessel.destroyed) return;
    if (vessel.jettisonStage()) {
      this.emit({ type: 'stage', vesselId, stagesLeft: vessel.stages.length });
    }
  }

  setThrottle(vesselId: string, throttle: number): void {
    const vessel = this.getVessel(vesselId);
    vessel.throttle = Math.min(1, Math.max(0, throttle));
    // thrust demands physics simulation
    if (vessel.throttle > 0) this.ensureOffRails(vessel);
  }

  setTurnInput(vesselId: string, input: number): void {
    this.getVessel(vesselId).turnInput = Math.min(1, Math.max(-1, input));
  }

  // ---------------------------------------------------------------- time-warp

  /** Highest warp the current state allows: physics vessels cap warp at 4×. */
  maxAllowedWarp(): number {
    for (const vessel of this.vesselMap.values()) {
      if (!vessel.destroyed && vessel.motion.kind === 'physics') return MAX_PHYSICS_WARP;
    }
    return RAILS_WARP_TIERS[RAILS_WARP_TIERS.length - 1]!;
  }

  setWarp(factor: number): void {
    const clamped = Math.min(factor, this.maxAllowedWarp());
    if (clamped !== this.warp) {
      this.warp = clamped;
      this.emit({ type: 'warpChanged', factor: clamped });
    }
  }

  /** Advance by a real-time duration; warp scales it into sim time. */
  advance(dt: number): void {
    if (this.warp > MAX_PHYSICS_WARP) {
      this.railsAdvance(dt * this.warp);
      return;
    }
    this.accumulator += dt * this.warp;
    let ticks = 0;
    while (this.accumulator >= TICK_DT && ticks < MAX_TICKS_PER_ADVANCE) {
      this.accumulator -= TICK_DT;
      this.tick();
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_ADVANCE) this.accumulator = 0; // shed backlog
  }

  /**
   * On-rails warp: jump sim time analytically, clamping at every scheduled
   * transition (plan §3.4 — a warp tick must never step over one).
   */
  private railsAdvance(dt: number): void {
    if (this.maxAllowedWarp() <= MAX_PHYSICS_WARP) {
      // someone needs integration — warp silently degrades to physics-max
      this.setWarp(MAX_PHYSICS_WARP);
      this.advance(dt / this.warp);
      return;
    }

    let target = this.simTime + dt;
    for (let guard = 0; guard < 32 && this.simTime < target; guard++) {
      // earliest hard boundary among all rails vessels' plans
      let boundary = target;
      let boundaryVessel: Vessel | null = null;
      for (const vessel of this.vesselMap.values()) {
        if (vessel.destroyed || vessel.motion.kind !== 'rails') continue;
        const plan = this.planFor(vessel);
        const t = plan.next ? plan.next.time : plan.scannedUntil;
        if (t < boundary) {
          boundary = t;
          boundaryVessel = vessel;
        }
      }

      this.simTime = Math.min(boundary, target);

      if (boundaryVessel && this.simTime >= boundary) {
        const plan = this.planFor(boundaryVessel);
        if (plan.next && this.simTime >= plan.next.time) {
          this.executeTransition(boundaryVessel, plan.next.kind === 'soiEntry' ? plan.next.targetBodyId : null, plan.next.kind);
          if (plan.next.kind === 'dropToPhysics') {
            // physics takes over: stop warping, discard the rest of the jump
            this.setWarp(1);
            return;
          }
        } else {
          // scan horizon reached without an event — extend the plan
          this.replan(boundaryVessel);
        }
      }
    }
  }

  /** One fixed 0.02 s step. */
  tick(): void {
    this.simTime += TICK_DT;
    for (const vessel of this.vesselMap.values()) {
      if (vessel.destroyed) continue;
      // attitude is kinematic and integrates even on rails (it's render-only there)
      vessel.heading += vessel.turnInput * MAX_TURN_RATE * TICK_DT;
      if (vessel.motion.kind === 'physics') {
        this.tickPhysicsVessel(vessel);
      } else {
        // rails vessels still hit transitions at 1× speed
        const plan = this.planFor(vessel);
        if (plan.next && this.simTime >= plan.next.time) {
          this.executeTransition(
            vessel,
            plan.next.kind === 'soiEntry' ? plan.next.targetBodyId : null,
            plan.next.kind,
          );
        } else if (this.simTime >= plan.scannedUntil) {
          this.replan(vessel);
        }
      }
    }
  }

  // ------------------------------------------------- patched-conic transitions

  private planFor(vessel: Vessel): TransitionPlan {
    let plan = this.plans.get(vessel.id);
    if (!plan) plan = this.replan(vessel);
    return plan;
  }

  private replan(vessel: Vessel): TransitionPlan {
    if (vessel.motion.kind !== 'rails') {
      const empty: TransitionPlan = { next: null, scannedUntil: Infinity };
      this.plans.set(vessel.id, empty);
      return empty;
    }
    const plan = planTransitions(this.tree, vessel.motion.orbit, this.simTime);
    this.plans.set(vessel.id, plan);
    return plan;
  }

  /** Put a vessel on rails and schedule its next transition. */
  private setRails(vessel: Vessel, orbit: Orbit): void {
    vessel.motion = { kind: 'rails', orbit };
    this.plans.delete(vessel.id);
  }

  private executeTransition(
    vessel: Vessel,
    targetBodyId: string | null,
    kind: 'soiExit' | 'soiEntry' | 'dropToPhysics',
  ): void {
    if (vessel.motion.kind !== 'rails') return;
    const orbit = vessel.motion.orbit;
    const fromBody = this.tree.get(orbit.bodyId);
    const t = this.simTime;
    const local = elementsToStateVectors(orbit, fromBody.mu, t);

    if (kind === 'dropToPhysics') {
      vessel.motion = { kind: 'physics', bodyId: fromBody.id, r: local.r, v: local.v, landed: false };
      this.plans.delete(vessel.id);
      this.emit({ type: 'offRails', vesselId: vessel.id });
      return;
    }

    let newBodyId: string;
    let r: Vec3;
    let v: Vec3;
    if (kind === 'soiExit') {
      if (fromBody.parentId === undefined) return;
      newBodyId = fromBody.parentId;
      const bodyState = this.tree.localState(fromBody.id, t);
      r = local.r.add(bodyState.r);
      v = local.v.add(bodyState.v);
    } else {
      if (!targetBodyId) return;
      newBodyId = targetBodyId;
      const childState = this.tree.localState(targetBodyId, t);
      r = local.r.sub(childState.r);
      v = local.v.sub(childState.v);
    }

    const newBody = this.tree.get(newBodyId);
    this.setRails(vessel, stateVectorsToElements(r, v, newBody.mu, newBodyId, t));
    this.emit({ type: 'soiChange', vesselId: vessel.id, fromBodyId: fromBody.id, toBodyId: newBodyId });
  }

  /** Off-rails vessels change SOI by direct geometric checks each tick. */
  private checkPhysicsSoi(vessel: Vessel): void {
    const motion = vessel.motion;
    if (motion.kind !== 'physics' || motion.landed) return;
    const body = this.tree.get(motion.bodyId);
    const t = this.simTime;

    if (body.soiRadius !== Infinity && motion.r.length() >= body.soiRadius && body.parentId !== undefined) {
      const bodyState = this.tree.localState(body.id, t);
      motion.bodyId = body.parentId;
      motion.r = motion.r.add(bodyState.r);
      motion.v = motion.v.add(bodyState.v);
      this.emit({ type: 'soiChange', vesselId: vessel.id, fromBodyId: body.id, toBodyId: body.parentId });
      return;
    }

    for (const child of this.tree.children(body.id)) {
      const childState = this.tree.localState(child.id, t);
      if (motion.r.sub(childState.r).length() < child.soiRadius) {
        motion.bodyId = child.id;
        motion.r = motion.r.sub(childState.r);
        motion.v = motion.v.sub(childState.v);
        this.emit({ type: 'soiChange', vesselId: vessel.id, fromBodyId: body.id, toBodyId: child.id });
        return;
      }
    }
  }

  private tickPhysicsVessel(vessel: Vessel): void {
    const motion = vessel.motion;
    if (motion.kind !== 'physics') return;
    const body = this.tree.get(motion.bodyId);

    if (motion.landed) {
      this.tickLanded(vessel, body);
      return;
    }

    // integrate
    const next = rk4Step({ r: motion.r, v: motion.v }, TICK_DT, vesselAcceleration(body, vessel));
    motion.r = next.r;
    motion.v = next.v;

    // crossing an SOI boundary re-frames r/v and changes which body attracts
    this.checkPhysicsSoi(vessel);
    const frameBody = this.tree.get(motion.bodyId);

    const altitude = motion.r.length() - frameBody.radius;
    this.tickThermalAndChute(vessel, frameBody, altitude);
    if (vessel.destroyed) return;

    // burn propellant
    const flow = fuelFlowRate(vessel, body, altitude) * TICK_DT;
    if (flow > 0) {
      const stage = vessel.activeStage();
      stage.fuel -= flow;
      if (stage.fuel <= 0) {
        stage.fuel = 0;
        this.emit({ type: 'stageEmpty', vesselId: vessel.id });
      }
    }

    // ground contact
    if (altitude <= 0) {
      const groundSpeed = motion.v.sub(surfaceVelocity(frameBody, motion.r)).length();
      if (groundSpeed <= SAFE_LANDING_SPEED) {
        motion.r = motion.r.normalized().scale(frameBody.radius);
        motion.v = surfaceVelocity(frameBody, motion.r);
        motion.landed = true;
        this.emit({ type: 'landed', vesselId: vessel.id });
      } else {
        vessel.destroyed = true;
        this.emit({ type: 'crashed', vesselId: vessel.id });
      }
      return;
    }

    this.maybeGoOnRails(vessel, frameBody);
  }

  /** Re-entry heating and automatic parachute deployment (plan §3.8/M4). */
  private tickThermalAndChute(vessel: Vessel, body: CelestialBodyDef, altitude: number): void {
    const motion = vessel.motion;
    if (motion.kind !== 'physics') return;
    const rho = airDensity(body.atmosphere, altitude);

    if (rho > 0) {
      const vAir = motion.v.sub(surfaceVelocity(body, motion.r)).length();
      const flux = 0.5 * rho * vAir ** 3; // stagnation heat flux, W/m²
      const heating = (flux * vessel.dragArea() * HEAT_ABSORB) / (vessel.mass() * HEAT_CAPACITY);
      vessel.heat = Math.max(0, vessel.heat + (heating - HEAT_COOL_RATE * vessel.heat) * TICK_DT);
      if (vessel.heat > vessel.maxHeat()) {
        vessel.destroyed = true;
        this.emit({ type: 'overheated', vesselId: vessel.id });
        return;
      }

      // parachutes pop on their own once it's low, slow, and descending —
      // the descent check keeps them stowed during the slow initial liftoff
      const descending = motion.v.dot(motion.r.normalized()) < 0;
      if (
        !vessel.chuteDeployed &&
        vessel.chuteArea() > 0 &&
        altitude < CHUTE_DEPLOY_ALTITUDE &&
        vAir < CHUTE_SAFE_SPEED &&
        descending &&
        !motion.landed
      ) {
        vessel.chuteDeployed = true;
        this.emit({ type: 'chuteDeployed', vesselId: vessel.id });
      }
    } else {
      vessel.heat = Math.max(0, vessel.heat - HEAT_COOL_RATE * vessel.heat * TICK_DT);
    }
  }

  private tickLanded(vessel: Vessel, body: CelestialBodyDef): void {
    const motion = vessel.motion;
    if (motion.kind !== 'physics') return;

    // ride the surface rotation
    const omega = body.rotationPeriod === 0 ? 0 : (2 * Math.PI * TICK_DT) / body.rotationPeriod;
    const cos = Math.cos(omega);
    const sin = Math.sin(omega);
    motion.r = new Vec3(motion.r.x * cos - motion.r.y * sin, motion.r.x * sin + motion.r.y * cos, motion.r.z);
    motion.v = surfaceVelocity(body, motion.r);

    // a lit engine burns whether or not it lifts the rocket
    const flow = fuelFlowRate(vessel, body, 0) * TICK_DT;
    if (flow > 0) {
      const stage = vessel.activeStage();
      stage.fuel = Math.max(0, stage.fuel - flow);
    }

    // liftoff when thrust beats weight
    const twr = vessel.currentThrust() / (vessel.mass() * (body.mu / body.radius ** 2));
    if (twr > 1) {
      motion.landed = false;
      this.emit({ type: 'liftoff', vesselId: vessel.id });
    }
  }

  /** physics → rails: coasting in vacuum on an orbit that stays in vacuum. */
  private maybeGoOnRails(vessel: Vessel, body: CelestialBodyDef): void {
    const motion = vessel.motion;
    if (motion.kind !== 'physics' || motion.landed) return;
    if (vessel.currentThrust() > 0) return;

    // at or below the physics floor (atmosphere / terrain margin), integration
    // is mandatory — this is what makes impacts and re-entry actually happen
    const floor = physicsFloorRadius(body);
    if (motion.r.length() <= floor + 10) return;

    const orbit = stateVectorsToElements(motion.r, motion.v, body.mu, body.id, this.simTime);
    // suborbital arcs whose periapsis dips below the floor may go on rails
    // only if their scheduled dropToPhysics is comfortably in the future
    // (a just-dropped vessel has its crossing in the past → stays integrated)
    if (periapsis(orbit) <= floor) {
      const tDrop = nextRadiusCrossing(orbit, body.mu, floor + 10, this.simTime, 'descending');
      if (tDrop === null || tDrop < this.simTime + 5) return;
    }

    this.setRails(vessel, orbit);
    this.emit({ type: 'onRails', vesselId: vessel.id });
  }

  /** rails → physics (e.g. the player throttles up). */
  private ensureOffRails(vessel: Vessel): void {
    if (vessel.motion.kind !== 'rails') return;
    if (this.warp > MAX_PHYSICS_WARP) this.setWarp(1);
    const orbit = vessel.motion.orbit;
    const body = this.tree.get(orbit.bodyId);
    const { r, v } = elementsToStateVectors(orbit, body.mu, this.simTime);
    vessel.motion = { kind: 'physics', bodyId: body.id, r, v, landed: false };
    this.plans.delete(vessel.id);
    this.emit({ type: 'offRails', vesselId: vessel.id });
  }

  /** The vessel's next scheduled patched-conic event (null while off rails). */
  nextTransition(vesselId: string) {
    const vessel = this.getVessel(vesselId);
    if (vessel.motion.kind !== 'rails' || vessel.destroyed) return null;
    return this.planFor(vessel).next;
  }

  /** Current position/velocity in the SOI body frame, regardless of motion kind. */
  vesselState(vesselId: string): { bodyId: string; r: Vec3; v: Vec3 } {
    const vessel = this.getVessel(vesselId);
    if (vessel.motion.kind === 'physics') {
      const { bodyId, r, v } = vessel.motion;
      return { bodyId, r, v };
    }
    const orbit = vessel.motion.orbit;
    const body = this.tree.get(orbit.bodyId);
    const { r, v } = elementsToStateVectors(orbit, body.mu, this.simTime);
    return { bodyId: body.id, r, v };
  }

  /** Convenience readouts for the HUD/map (orbit computed from current state). */
  vesselReadout(vesselId: string) {
    const vessel = this.getVessel(vesselId);
    const { bodyId, r, v } = this.vesselState(vesselId);
    const body = this.tree.get(bodyId);
    const altitude = r.length() - body.radius;
    const surfaceSpeed = v.sub(surfaceVelocity(body, r)).length();

    let apo = 0;
    let peri = 0;
    try {
      const orbit =
        vessel.motion.kind === 'rails'
          ? vessel.motion.orbit
          : stateVectorsToElements(r, v, body.mu, bodyId, this.simTime);
      apo = apoapsis(orbit) - body.radius;
      peri = periapsis(orbit) - body.radius;
    } catch {
      // degenerate (e.g. sitting on the pad) — leave apo/peri at 0
    }

    return {
      bodyId,
      altitude,
      speed: v.length(),
      surfaceSpeed,
      apoapsis: apo,
      periapsis: peri,
      throttle: vessel.throttle,
      fuel: vessel.activeStage().fuel,
      fuelCapacity: vessel.activeStage().def.fuelMass,
      stagesLeft: vessel.stages.length,
      mass: vessel.mass(),
      landed: vessel.motion.kind === 'physics' && vessel.motion.landed,
      onRails: vessel.motion.kind === 'rails',
      destroyed: vessel.destroyed,
      heading: vessel.heading,
      heatFraction: vessel.heat / vessel.maxHeat(),
      chuteDeployed: vessel.chuteDeployed,
    };
  }

  /** TWR of a landed/flying vessel at its current position (HUD helper). */
  twr(vesselId: string): number {
    const vessel = this.getVessel(vesselId);
    const { bodyId, r } = this.vesselState(vesselId);
    const body = this.tree.get(bodyId);
    const g = body.mu / r.lengthSq();
    return vessel.currentThrust() / (vessel.mass() * g) || 0;
  }
}

export { G0 };
