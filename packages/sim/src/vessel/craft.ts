import type { StageDef, VesselConfig } from './Vessel.js';

/**
 * Craft construction model (plan §5): a 2.5D SFS-style vertical stack with
 * radially attached side parts. Shared by builder UI, local saves, craft
 * sharing, and multiplayer launch messages — the server runs the same
 * validator/compiler.
 */

export type PartCategory =
  | 'capsule'
  | 'tank'
  | 'engine'
  | 'decoupler'
  | 'fin'
  | 'nose'
  | 'parachute'
  | 'heatshield';

export interface PartDef {
  id: string;
  title: string;
  category: PartCategory;
  /** structure mass, kg */
  massDry: number;
  /** propellant capacity, kg (tanks) */
  fuel?: number;
  engine?: { thrust: number; ispVac: number; ispSL: number };
  parachute?: { dragArea: number };
  /** Cd·A contribution, m² */
  dragArea: number;
  /** heat tolerance, K above ambient (capsules are blunt-body tough) */
  maxHeat?: number;
  /** silhouette/mesh: truncated cone, meters */
  shape: { rTop: number; rBottom: number; height: number };
  attach: { top: boolean; bottom: boolean; side?: boolean };
}

export interface CraftPart {
  /** instance id, unique within the craft */
  iid: number;
  /** PartDef id */
  part: string;
  /** center x in meters (grid-snapped by the builder) */
  x: number;
  /** bottom y in meters (0 = launch pad) */
  y: number;
  /** side parts (fins): iid of the stack part they attach to */
  host?: number;
}

export interface CraftDesign {
  format: 2;
  name: string;
  parts: CraftPart[];
}

/** Pre-free-placement format: stack y = ordinal, side parts x = ±1 / y = host iid. */
export interface LegacyCraftDesign {
  format: 1;
  name: string;
  parts: Array<{ iid: number; part: string; x: number; y: number }>;
}

export interface CraftIssue {
  severity: 'error' | 'warning';
  message: string;
}

export function isStackPart(p: CraftPart): boolean {
  return p.host === undefined;
}

/** Stack parts ordered bottom → top by position. */
export function stackOf(design: CraftDesign): CraftPart[] {
  return design.parts.filter(isStackPart).sort((a, b) => a.y - b.y);
}

export function sidePartsOn(design: CraftDesign, stackIid: number): CraftPart[] {
  return design.parts.filter((p) => p.host === stackIid);
}

/** Positions match when within this tolerance — covers float drift in summed grid coords. */
export const ATTACH_EPS = 0.01;

/** True when `upper` sits exactly on `lower` (same column, touching faces). */
export function partsTouch(lower: CraftPart, lowerDef: PartDef, upper: CraftPart): boolean {
  return (
    Math.abs(lower.x - upper.x) < ATTACH_EPS &&
    Math.abs(lower.y + lowerDef.shape.height - upper.y) < ATTACH_EPS
  );
}

/**
 * Convert a legacy ordinal-stack design (format 1) to free positions
 * (format 2). Stack ordinals become cumulative heights; side parts get real
 * flank positions and an explicit host reference.
 */
export function migrateCraft(
  design: CraftDesign | LegacyCraftDesign,
  catalog: Map<string, PartDef>,
): CraftDesign {
  if (design.format !== 1) return design;
  const parts: CraftPart[] = [];
  const hostPos = new Map<number, { x: number; y: number; def: PartDef | undefined }>();
  let y = 0;
  const stack = design.parts.filter((p) => p.x === 0).sort((a, b) => a.y - b.y);
  for (const p of stack) {
    const def = catalog.get(p.part);
    hostPos.set(p.iid, { x: 0, y, def });
    parts.push({ iid: p.iid, part: p.part, x: 0, y });
    y += def?.shape.height ?? 1;
  }
  for (const p of design.parts) {
    if (p.x === 0) continue;
    const host = hostPos.get(p.y);
    const r = host?.def?.shape.rBottom ?? 0.7;
    parts.push({
      iid: p.iid,
      part: p.part,
      x: (host?.x ?? 0) + Math.sign(p.x) * r,
      y: host?.y ?? 0,
      host: p.y,
    });
  }
  return { format: 2, name: design.name, parts };
}

/**
 * Validate a craft design. Errors make it unlaunchable; warnings are surfaced
 * in the builder but allowed (bold players may fly fuel-less contraptions).
 */
export function validateCraft(design: CraftDesign, catalog: Map<string, PartDef>): CraftIssue[] {
  const issues: CraftIssue[] = [];
  if (design.parts.length === 0) {
    return [{ severity: 'error', message: 'craft has no parts' }];
  }

  const seen = new Set<number>();
  for (const p of design.parts) {
    if (seen.has(p.iid)) issues.push({ severity: 'error', message: `duplicate part instance id ${p.iid}` });
    seen.add(p.iid);
    const def = catalog.get(p.part);
    if (!def) {
      issues.push({ severity: 'error', message: `unknown part "${p.part}"` });
      continue;
    }
    if (!isStackPart(p)) {
      if (!def.attach.side) issues.push({ severity: 'error', message: `${def.title} cannot side-attach` });
      const host = design.parts.find((q) => q.iid === p.host && isStackPart(q));
      if (!host) issues.push({ severity: 'error', message: `${def.title} attached to missing stack part` });
    } else if (def.attach.side) {
      issues.push({ severity: 'error', message: `${def.title} must attach to the side of a stack part` });
    }
  }

  const stack = stackOf(design);
  if (stack.length === 0) issues.push({ severity: 'error', message: 'craft has no stack' });
  for (let i = 1; i < stack.length; i++) {
    const lower = stack[i - 1]!;
    const lowerDef = catalog.get(lower.part);
    if (!lowerDef || !catalog.get(stack[i]!.part)) continue; // unknown parts already reported
    if (!partsTouch(lower, lowerDef, stack[i]!)) {
      issues.push({
        severity: 'error',
        message: 'parts are not all connected — drag them together until they snap',
      });
      break;
    }
  }
  const capsules = design.parts.filter((p) => catalog.get(p.part)?.category === 'capsule');
  if (capsules.length !== 1) {
    issues.push({ severity: 'error', message: 'craft needs exactly one command capsule' });
  }
  if (!design.parts.some((p) => catalog.get(p.part)?.engine)) {
    issues.push({ severity: 'warning', message: 'craft has no engine' });
  }
  return issues;
}

/**
 * Split the stack into serial sections at decouplers, bottom → top. Each
 * decoupler is discarded with the section below it. Used by both the flight
 * compiler and the vessel renderer so they can never disagree about staging.
 */
export function craftSections(design: CraftDesign, catalog: Map<string, PartDef>): CraftPart[][] {
  const sections: CraftPart[][] = [];
  let current: CraftPart[] = [];
  for (const part of stackOf(design)) {
    current.push(part, ...sidePartsOn(design, part.iid));
    if (catalog.get(part.part)?.category === 'decoupler') {
      sections.push(current);
      current = [];
    }
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

/**
 * Compile a craft into the flight model: each section's parts are aggregated
 * into one StageDef.
 */
export function compileCraft(design: CraftDesign, catalog: Map<string, PartDef>): VesselConfig {
  const errors = validateCraft(design, catalog).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`invalid craft: ${errors.map((e) => e.message).join('; ')}`);
  }

  const sections = craftSections(design, catalog);

  const stages: StageDef[] = sections.map((parts) => {
    let dryMass = 0;
    let fuelMass = 0;
    let thrust = 0;
    let ispVacWeighted = 0;
    let ispSLWeighted = 0;
    let dragArea = 0;
    let chuteArea = 0;
    let maxHeat = 0;
    for (const p of parts) {
      const def = catalog.get(p.part)!;
      dryMass += def.massDry;
      fuelMass += def.fuel ?? 0;
      dragArea += def.dragArea;
      chuteArea += def.parachute?.dragArea ?? 0;
      // the sturdiest part shields its section
      maxHeat = Math.max(maxHeat, def.maxHeat ?? 0);
      if (def.engine) {
        thrust += def.engine.thrust;
        ispVacWeighted += def.engine.thrust * def.engine.ispVac;
        ispSLWeighted += def.engine.thrust * def.engine.ispSL;
      }
    }
    return {
      dryMass,
      fuelMass,
      thrust,
      ispVac: thrust > 0 ? ispVacWeighted / thrust : 1,
      ispSL: thrust > 0 ? ispSLWeighted / thrust : 1,
      // nose cones reduce drag but can never make a section a net thruster
      dragArea: Math.max(0.05, dragArea),
      chuteArea,
      maxHeat: maxHeat > 0 ? maxHeat : undefined,
    };
  });

  return { name: design.name, stages };
}

const G0 = 9.80665;

/** Per-stage Δv and initial TWR at a given surface gravity — builder readouts. */
export function craftStats(config: VesselConfig, surfaceGravity: number) {
  let massAbove = 0;
  const stages = [...config.stages].reverse().map((stage) => {
    const m1 = massAbove + stage.dryMass;
    const m0 = m1 + stage.fuelMass;
    const deltaV = stage.thrust > 0 ? stage.ispVac * G0 * Math.log(m0 / m1) : 0;
    massAbove = m0;
    return { deltaV, m0 };
  });
  stages.reverse(); // back to bottom-first
  const launchMass = massAbove;
  const bottom = config.stages[0];
  return {
    launchMass,
    twr: bottom && bottom.thrust > 0 ? bottom.thrust / (launchMass * surfaceGravity) : 0,
    deltaVPerStage: stages.map((s) => s.deltaV),
    totalDeltaV: stages.reduce((sum, s) => sum + s.deltaV, 0),
  };
}
