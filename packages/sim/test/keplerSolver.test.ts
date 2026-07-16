import { describe, expect, it } from 'vitest';
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  trueAnomalyFromEccentric,
  eccentricFromTrueAnomaly,
} from '../src/orbit/keplerSolver.js';

describe('solveKeplerElliptic', () => {
  it('round-trips M = E - e·sin(E) to < 1e-10 across the e × M grid', () => {
    const eccs = [0, 0.05, 0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.99];
    for (const e of eccs) {
      for (let k = -20; k <= 20; k++) {
        const M = (k / 20) * Math.PI;
        const E = solveKeplerElliptic(M, e);
        const MBack = E - e * Math.sin(E);
        expect(Math.abs(MBack - M), `e=${e} M=${M}`).toBeLessThan(1e-10);
      }
    }
  });

  it('returns M exactly for circular orbits', () => {
    expect(solveKeplerElliptic(1.234, 0)).toBe(1.234);
  });

  it('handles extreme near-parabolic eccentricity via fallback', () => {
    const e = 0.9999999;
    for (const M of [-3, -0.5, -1e-8, 1e-8, 0.5, 3]) {
      const E = solveKeplerElliptic(M, e);
      expect(Math.abs(E - e * Math.sin(E) - M)).toBeLessThan(1e-9);
    }
  });

  it('rejects out-of-range eccentricity', () => {
    expect(() => solveKeplerElliptic(1, 1)).toThrow(RangeError);
    expect(() => solveKeplerElliptic(1, -0.1)).toThrow(RangeError);
  });
});

describe('solveKeplerHyperbolic', () => {
  it('round-trips M = e·sinh(H) - H to < 1e-10', () => {
    const eccs = [1.0001, 1.1, 1.5, 2, 5, 10];
    for (const e of eccs) {
      for (const M of [-100, -10, -1, -0.01, 0, 0.01, 1, 10, 100]) {
        const H = solveKeplerHyperbolic(M, e);
        const MBack = e * Math.sinh(H) - H;
        // scale tolerance for large |M| where sinh is steep
        const tol = 1e-10 * Math.max(1, Math.abs(M));
        expect(Math.abs(MBack - M), `e=${e} M=${M}`).toBeLessThan(tol);
      }
    }
  });

  it('rejects elliptic eccentricity', () => {
    expect(() => solveKeplerHyperbolic(1, 0.5)).toThrow(RangeError);
  });
});

describe('anomaly conversions', () => {
  it('E → ν → E round-trips across eccentricities', () => {
    for (const e of [0, 0.2, 0.6, 0.95]) {
      for (let k = -10; k <= 10; k++) {
        const E = (k / 10) * Math.PI;
        const nu = trueAnomalyFromEccentric(E, e);
        const EBack = eccentricFromTrueAnomaly(nu, e);
        expect(Math.abs(EBack - E)).toBeLessThan(1e-12);
      }
    }
  });
});
