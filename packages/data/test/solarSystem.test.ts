import { describe, expect, it } from 'vitest';
import { SystemTree, period } from '@sfs/sim';
import { SOLAR_SYSTEM } from '../src/index.js';

describe('SystemTree with the Helios system', () => {
  const tree = new SystemTree(SOLAR_SYSTEM);

  it('finds the root and children', () => {
    expect(tree.root.id).toBe('helios');
    expect(tree.children('helios').map((b) => b.id)).toContain('terra');
    expect(tree.children('terra').map((b) => b.id)).toContain('luna');
  });

  it('Terra stays at its orbital radius around Helios', () => {
    for (const t of [0, 3600, 86_400, 1e6]) {
      const { r } = tree.localState('terra', t);
      expect(r.length()).toBeCloseTo(13_599_840_256, 0);
    }
  });

  it('Luna global position = Terra global + Luna local', () => {
    const t = 50_000;
    const terra = tree.globalState('terra', t);
    const lunaLocal = tree.localState('luna', t);
    const lunaGlobal = tree.globalState('luna', t);
    expect(lunaGlobal.r.sub(terra.r.add(lunaLocal.r)).length()).toBeLessThan(1e-6);
  });

  it("Luna's tidally-locked rotation period matches its orbital period", () => {
    const luna = tree.get('luna');
    const T = period(luna.orbit!, tree.get('terra').mu);
    expect(luna.rotationPeriod).toBeCloseTo(T, -3); // within ~500 s
  });

  it('rejects malformed systems', () => {
    expect(() => new SystemTree([])).toThrow(/no root/);
    const helios = SOLAR_SYSTEM.find((b) => b.id === 'helios')!;
    const luna = SOLAR_SYSTEM.find((b) => b.id === 'luna')!;
    expect(() => new SystemTree([helios, luna])).toThrow(/unknown parent/);
  });
});
