import type { AtmosphereDef } from '../bodies/CelestialBody.js';

/** Air density at a given altitude, kg/m³. Exponential profile, hard 0 above `height`. */
export function airDensity(atmo: AtmosphereDef | undefined, altitude: number): number {
  if (!atmo || altitude >= atmo.height) return 0;
  return atmo.seaLevelDensity * Math.exp(-Math.max(altitude, 0) / atmo.scaleHeight);
}

/**
 * Fraction used to blend engine Isp between sea-level and vacuum values:
 * 1 at (this body's) sea-level density, 0 in vacuum.
 */
export function atmosphereFraction(atmo: AtmosphereDef | undefined, altitude: number): number {
  if (!atmo) return 0;
  const rho = airDensity(atmo, altitude);
  return Math.min(1, rho / atmo.seaLevelDensity);
}
