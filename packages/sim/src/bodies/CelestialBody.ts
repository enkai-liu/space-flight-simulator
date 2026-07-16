import { Vec3 } from '../math/vec3.js';
import type { Orbit } from '../orbit/Orbit.js';
import { elementsToStateVectors } from '../orbit/stateVectors.js';

export interface AtmosphereDef {
  /** density at zero altitude, kg/m³ */
  seaLevelDensity: number;
  /** exponential scale height, m */
  scaleHeight: number;
  /** altitude above which density is treated as exactly 0, m */
  height: number;
}

/** Static definition of a celestial body (content data, never mutated by sim). */
export interface CelestialBodyDef {
  id: string;
  name: string;
  /** gravitational parameter GM, m³/s² */
  mu: number;
  /** mean radius, m */
  radius: number;
  /**
   * Sphere-of-influence radius, m. Infinity for the root star.
   * Precomputed in the data package as a·(m/M)^0.4.
   */
  soiRadius: number;
  /** sidereal rotation period, s (positive = counterclockwise seen from +Z) */
  rotationPeriod: number;
  atmosphere?: AtmosphereDef;
  /** orbit around parent; undefined only for the root star */
  orbit?: Orbit;
  parentId?: string;
}

/**
 * The solar system as an SOI tree. Bodies are always on-rails: their state at
 * any sim time is analytic, so this class is pure lookup + Kepler propagation.
 */
export class SystemTree {
  private readonly byId = new Map<string, CelestialBodyDef>();
  private readonly childrenOf = new Map<string, CelestialBodyDef[]>();
  readonly root: CelestialBodyDef;

  constructor(defs: CelestialBodyDef[]) {
    let root: CelestialBodyDef | undefined;
    for (const def of defs) {
      this.byId.set(def.id, def);
      if (def.parentId === undefined) {
        if (root) throw new Error(`multiple root bodies: ${root.id}, ${def.id}`);
        root = def;
      } else {
        const siblings = this.childrenOf.get(def.parentId) ?? [];
        siblings.push(def);
        this.childrenOf.set(def.parentId, siblings);
      }
    }
    if (!root) throw new Error('system has no root body');
    for (const def of defs) {
      if (def.parentId !== undefined && !this.byId.has(def.parentId)) {
        throw new Error(`body ${def.id} has unknown parent ${def.parentId}`);
      }
    }
    this.root = root;
  }

  get(id: string): CelestialBodyDef {
    const body = this.byId.get(id);
    if (!body) throw new Error(`unknown body: ${id}`);
    return body;
  }

  children(id: string): readonly CelestialBodyDef[] {
    return this.childrenOf.get(id) ?? [];
  }

  all(): IterableIterator<CelestialBodyDef> {
    return this.byId.values();
  }

  /** Body position/velocity relative to its own parent at sim time t. */
  localState(id: string, t: number): { r: Vec3; v: Vec3 } {
    const body = this.get(id);
    if (!body.orbit || body.parentId === undefined) {
      return { r: Vec3.ZERO, v: Vec3.ZERO };
    }
    const parent = this.get(body.parentId);
    return elementsToStateVectors(body.orbit, parent.mu, t);
  }

  /** Body position/velocity in root-frame (star-centered) coordinates at t. */
  globalState(id: string, t: number): { r: Vec3; v: Vec3 } {
    let r = Vec3.ZERO;
    let v = Vec3.ZERO;
    let current: CelestialBodyDef | undefined = this.get(id);
    while (current) {
      const local = this.localState(current.id, t);
      r = r.add(local.r);
      v = v.add(local.v);
      current = current.parentId !== undefined ? this.get(current.parentId) : undefined;
    }
    return { r, v };
  }

  /** Rotation angle of the body's surface around +Z at sim time t, rad. */
  rotationAngle(id: string, t: number): number {
    const body = this.get(id);
    if (body.rotationPeriod === 0) return 0;
    return ((2 * Math.PI * t) / body.rotationPeriod) % (2 * Math.PI);
  }
}
