import { describe, expect, it } from 'vitest';
import {
  compileCraft,
  validateCraft,
  craftStats,
  migrateCraft,
  type CraftDesign,
  type LegacyCraftDesign,
} from '@sfs/sim';
import { PART_CATALOG, KARMAN_I_DESIGN } from '../src/index.js';

describe('compileCraft on the stock Karman I design', () => {
  const config = compileCraft(KARMAN_I_DESIGN, PART_CATALOG);

  it('splits into three flight stages at the decouplers', () => {
    expect(config.stages.length).toBe(3);
  });

  it('aggregates masses and drag per section', () => {
    const [booster, upper, reentry] = config.stages;
    // hawk 1200 + 2×tank-l 2000 + decoupler 120
    expect(booster!.dryMass).toBeCloseTo(3_320, 5);
    expect(booster!.fuelMass).toBe(16_000);
    expect(booster!.thrust).toBe(400_000);
    // kite 450 + tank-m 500 + decoupler 120
    expect(upper!.dryMass).toBeCloseTo(1_070, 5);
    expect(upper!.fuelMass).toBe(4_000);
    expect(upper!.thrust).toBe(60_000);
    // heat shield 180 + capsule 800 + chute 80, shielded to the shield's rating
    expect(reentry!.dryMass).toBeCloseTo(1_060, 5);
    expect(reentry!.thrust).toBe(0);
    expect(reentry!.maxHeat).toBe(3_400);
  });

  it('lists each engine part individually for in-flight switching', () => {
    const [booster, upper, reentry] = config.stages;
    expect(booster!.engines).toEqual([
      { iid: 1, title: 'Hawk Engine', thrust: 400_000, ispVac: 290, ispSL: 250 },
    ]);
    expect(upper!.engines).toEqual([
      { iid: 5, title: 'Kite Vacuum Engine', thrust: 60_000, ispVac: 340, ispSL: 120 },
    ]);
    expect(reentry!.engines).toEqual([]);
  });

  it('has orbital-class performance at Terra', () => {
    const stats = craftStats(config, 9.81);
    expect(stats.twr).toBeGreaterThan(1.3);
    expect(stats.totalDeltaV).toBeGreaterThan(4_500);
    expect(stats.launchMass).toBeCloseTo(25_450, 0);
  });

  it('validates clean', () => {
    expect(validateCraft(KARMAN_I_DESIGN, PART_CATALOG)).toEqual([]);
  });
});

describe('validateCraft', () => {
  it('rejects empty and capsule-less crafts', () => {
    expect(validateCraft({ format: 2, name: 'x', parts: [] }, PART_CATALOG)[0]!.severity).toBe('error');
    const noCapsule: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [{ iid: 1, part: 'tank-s', x: 0, y: 0 }],
    };
    expect(
      validateCraft(noCapsule, PART_CATALOG).some((i) => i.message.includes('capsule')),
    ).toBe(true);
  });

  it('rejects unknown parts, duplicate iids, and bad side attachments', () => {
    const bad: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [
        { iid: 1, part: 'capsule-mk1', x: 0, y: 0 },
        { iid: 1, part: 'no-such-part', x: 0, y: 1.3 },
        { iid: 3, part: 'tank-s', x: 1, y: 0, host: 99 }, // tanks can't side-attach; host missing
      ],
    };
    const issues = validateCraft(bad, PART_CATALOG);
    expect(issues.some((i) => i.message.includes('duplicate'))).toBe(true);
    expect(issues.some((i) => i.message.includes('unknown part'))).toBe(true);
    expect(issues.some((i) => i.message.includes('side-attach'))).toBe(true);
    expect(issues.some((i) => i.message.includes('missing stack part'))).toBe(true);
  });

  it('rejects fins placed as stack parts', () => {
    const finFloating: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [
        { iid: 1, part: 'capsule-mk1', x: 0, y: 0 },
        { iid: 2, part: 'fin-a', x: 3, y: 0 }, // no host
      ],
    };
    expect(
      validateCraft(finFloating, PART_CATALOG).some(
        (i) => i.severity === 'error' && i.message.includes('side of a stack part'),
      ),
    ).toBe(true);
  });

  it('rejects disconnected stacks (floating parts)', () => {
    const floating: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [
        { iid: 1, part: 'engine-hawk', x: 0, y: 0 },
        { iid: 2, part: 'capsule-mk1', x: 0, y: 4 }, // gap above the engine (h=1.1)
      ],
    };
    expect(
      validateCraft(floating, PART_CATALOG).some(
        (i) => i.severity === 'error' && i.message.includes('connected'),
      ),
    ).toBe(true);

    const offColumn: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [
        { iid: 1, part: 'engine-hawk', x: 0, y: 0 },
        { iid: 2, part: 'capsule-mk1', x: 2, y: 1.1 }, // right height, wrong column
      ],
    };
    expect(
      validateCraft(offColumn, PART_CATALOG).some(
        (i) => i.severity === 'error' && i.message.includes('connected'),
      ),
    ).toBe(true);
  });

  it('warns (not errors) about engineless crafts', () => {
    const glider: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [{ iid: 1, part: 'capsule-mk1', x: 0, y: 0 }],
    };
    const issues = validateCraft(glider, PART_CATALOG);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('engine'))).toBe(true);
  });

  it('a craft with no decoupler compiles to a single stage', () => {
    const single: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [
        { iid: 1, part: 'engine-hawk', x: 0, y: 0 },
        { iid: 2, part: 'tank-m', x: 0, y: 1.1 },
        { iid: 3, part: 'capsule-mk1', x: 0, y: 4.1 },
      ],
    };
    const config = compileCraft(single, PART_CATALOG);
    expect(config.stages.length).toBe(1);
    expect(config.stages[0]!.thrust).toBe(400_000);
  });

  it('accepts a connected stack built off-center on the grid', () => {
    const offCenter: CraftDesign = {
      format: 2,
      name: 'x',
      parts: [
        { iid: 1, part: 'engine-hawk', x: 2.5, y: 0 },
        { iid: 2, part: 'tank-m', x: 2.5, y: 1.1 },
        { iid: 3, part: 'capsule-mk1', x: 2.5, y: 4.1 },
      ],
    };
    expect(validateCraft(offCenter, PART_CATALOG).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('migrateCraft', () => {
  it('converts legacy ordinal stacks to free positions', () => {
    const legacy: LegacyCraftDesign = {
      format: 1,
      name: 'old',
      parts: [
        { iid: 1, part: 'engine-hawk', x: 0, y: 0 },
        { iid: 2, part: 'tank-m', x: 0, y: 1 },
        { iid: 3, part: 'capsule-mk1', x: 0, y: 2 },
        { iid: 4, part: 'fin-a', x: 1, y: 2 }, // fins hosted on tank iid 2
        { iid: 5, part: 'fin-a', x: -1, y: 2 },
      ],
    };
    const migrated = migrateCraft(legacy, PART_CATALOG);
    expect(migrated.format).toBe(2);
    const byIid = new Map(migrated.parts.map((p) => [p.iid, p]));
    expect(byIid.get(2)!.y).toBeCloseTo(1.1); // sits on the 1.1 m engine
    expect(byIid.get(3)!.y).toBeCloseTo(4.1); // engine + tank
    expect(byIid.get(4)!.host).toBe(2);
    expect(byIid.get(4)!.x).toBeCloseTo(0.7); // tank-m flank radius
    expect(byIid.get(5)!.x).toBeCloseTo(-0.7);
    expect(validateCraft(migrated, PART_CATALOG).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('passes format-2 designs through unchanged', () => {
    expect(migrateCraft(KARMAN_I_DESIGN, PART_CATALOG)).toBe(KARMAN_I_DESIGN);
  });
});
