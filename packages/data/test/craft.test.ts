import { describe, expect, it } from 'vitest';
import { compileCraft, validateCraft, craftStats, type CraftDesign } from '@sfs/sim';
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
    expect(validateCraft({ format: 1, name: 'x', parts: [] }, PART_CATALOG)[0]!.severity).toBe('error');
    const noCapsule: CraftDesign = {
      format: 1,
      name: 'x',
      parts: [{ iid: 1, part: 'tank-s', x: 0, y: 0 }],
    };
    expect(
      validateCraft(noCapsule, PART_CATALOG).some((i) => i.message.includes('capsule')),
    ).toBe(true);
  });

  it('rejects unknown parts, duplicate iids, and bad side attachments', () => {
    const bad: CraftDesign = {
      format: 1,
      name: 'x',
      parts: [
        { iid: 1, part: 'capsule-mk1', x: 0, y: 0 },
        { iid: 1, part: 'no-such-part', x: 0, y: 1 },
        { iid: 3, part: 'tank-s', x: 1, y: 99 }, // tanks can't side-attach; host missing
      ],
    };
    const issues = validateCraft(bad, PART_CATALOG);
    expect(issues.some((i) => i.message.includes('duplicate'))).toBe(true);
    expect(issues.some((i) => i.message.includes('unknown part'))).toBe(true);
    expect(issues.some((i) => i.message.includes('side-attach'))).toBe(true);
    expect(issues.some((i) => i.message.includes('missing stack part'))).toBe(true);
  });

  it('warns (not errors) about engineless crafts', () => {
    const glider: CraftDesign = {
      format: 1,
      name: 'x',
      parts: [{ iid: 1, part: 'capsule-mk1', x: 0, y: 0 }],
    };
    const issues = validateCraft(glider, PART_CATALOG);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('engine'))).toBe(true);
  });

  it('a craft with no decoupler compiles to a single stage', () => {
    const single: CraftDesign = {
      format: 1,
      name: 'x',
      parts: [
        { iid: 1, part: 'engine-hawk', x: 0, y: 0 },
        { iid: 2, part: 'tank-m', x: 0, y: 1 },
        { iid: 3, part: 'capsule-mk1', x: 0, y: 2 },
      ],
    };
    const config = compileCraft(single, PART_CATALOG);
    expect(config.stages.length).toBe(1);
    expect(config.stages[0]!.thrust).toBe(400_000);
  });
});
