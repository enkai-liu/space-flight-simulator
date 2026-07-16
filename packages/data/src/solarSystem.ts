import type { CelestialBodyDef, Orbit } from '@sfs/sim';

/**
 * The Helios system — a ~1/10-scale solar system (KSP-style) so orbital play
 * stays fast and f64 precision comfortable. Terra's mu/radius match Kerbin's
 * battle-tested values: surface gravity ≈ 9.8 m/s², LEO velocity ≈ 2,300 m/s,
 * orbit reachable after ~3,400 m/s of Δv.
 */

/** Extra per-body presentation data used only by the client renderer. */
export interface BodyAppearance {
  /** base surface color, css hex */
  color: string;
  /** secondary color for procedural surface variation */
  accentColor: string;
  /** atmosphere tint (if the body has one) */
  atmosphereColor?: string;
  /** emissive (stars) */
  emissive?: boolean;
}

/** Input format: soiRadius is derived below, not hand-maintained. */
type BodySpec = Omit<CelestialBodyDef, 'soiRadius'>;

function circularOrbit(bodyId: string, a: number, m0: number, i = 0): Orbit {
  return { bodyId, a, e: 0, i, raan: 0, argPe: 0, m0, epoch: 0 };
}

const SPECS: BodySpec[] = [
  {
    id: 'helios',
    name: 'Helios',
    mu: 1.172e18,
    radius: 26_160_000,
    rotationPeriod: 0,
  },
  {
    // Moho-like: small, hot, close in
    id: 'vulcan',
    name: 'Vulcan',
    mu: 1.6861e11,
    radius: 250_000,
    rotationPeriod: 1_210_000,
    parentId: 'helios',
    orbit: { bodyId: 'helios', a: 5_263_138_304, e: 0.2, i: 0.122, raan: 1.22, argPe: 0.26, m0: 3.14, epoch: 0 },
  },
  {
    // Eve-like: big, thick purple atmosphere
    id: 'aphros',
    name: 'Aphros',
    mu: 8.1717e12,
    radius: 700_000,
    rotationPeriod: 80_500,
    atmosphere: { seaLevelDensity: 6.0, scaleHeight: 7_000, height: 90_000 },
    parentId: 'helios',
    orbit: { bodyId: 'helios', a: 9_832_684_544, e: 0.01, i: 0.037, raan: 0.26, argPe: 0, m0: 3.14, epoch: 0 },
  },
  {
    id: 'terra',
    name: 'Terra',
    mu: 3.5316e12, // Kerbin's proven value: g₀ ≈ 9.81 m/s² at r = 600 km
    radius: 600_000,
    rotationPeriod: 21_600, // 6-hour day
    atmosphere: { seaLevelDensity: 1.225, scaleHeight: 5_600, height: 70_000 },
    parentId: 'helios',
    orbit: circularOrbit('helios', 13_599_840_256, 3.14),
  },
  {
    id: 'luna',
    name: 'Luna',
    mu: 6.5138e10,
    radius: 200_000,
    rotationPeriod: 138_984, // tidally locked to its orbital period
    parentId: 'terra',
    orbit: circularOrbit('terra', 12_000_000, 1.7),
  },
  {
    // Minmus-like: tiny outer moon, slightly inclined
    id: 'pico',
    name: 'Pico',
    mu: 1.7658e9,
    radius: 60_000,
    rotationPeriod: 40_400,
    parentId: 'terra',
    orbit: { bodyId: 'terra', a: 47_000_000, e: 0, i: 0.105, raan: 1.36, argPe: 0.66, m0: 0.9, epoch: 0 },
  },
  {
    // Duna-like: red, thin atmosphere
    id: 'ares',
    name: 'Ares',
    mu: 3.0136e11,
    radius: 320_000,
    rotationPeriod: 65_518,
    atmosphere: { seaLevelDensity: 0.2, scaleHeight: 5_700, height: 50_000 },
    parentId: 'helios',
    orbit: { bodyId: 'helios', a: 20_726_155_264, e: 0.051, i: 0.001, raan: 2.36, argPe: 0, m0: 3.14, epoch: 0 },
  },
  {
    // Ike-like companion of Ares
    id: 'deimos',
    name: 'Deimos',
    mu: 1.8568e10,
    radius: 130_000,
    rotationPeriod: 65_518,
    parentId: 'ares',
    orbit: { bodyId: 'ares', a: 3_200_000, e: 0.03, i: 0.035, raan: 0, argPe: 0, m0: 1.7, epoch: 0 },
  },
  {
    // Jool-like gas giant
    id: 'jove',
    name: 'Jove',
    mu: 2.8253e14,
    radius: 6_000_000,
    rotationPeriod: 36_000,
    atmosphere: { seaLevelDensity: 15, scaleHeight: 10_000, height: 200_000 },
    parentId: 'helios',
    orbit: { bodyId: 'helios', a: 68_773_560_320, e: 0.05, i: 0.023, raan: 0.91, argPe: 0, m0: 0.1, epoch: 0 },
  },
  {
    // Laythe-ish inner moon
    id: 'thalassa',
    name: 'Thalassa',
    mu: 1.962e12,
    radius: 500_000,
    rotationPeriod: 52_981,
    atmosphere: { seaLevelDensity: 0.8, scaleHeight: 5_000, height: 55_000 },
    parentId: 'jove',
    orbit: circularOrbit('jove', 27_184_000, 3.14),
  },
  {
    // Tylo-ish outer moon
    id: 'kallo',
    name: 'Kallo',
    mu: 2.8252e12,
    radius: 600_000,
    rotationPeriod: 211_926,
    parentId: 'jove',
    orbit: circularOrbit('jove', 68_500_000, 0),
  },
];

/**
 * SOI radius a·(m/M)^0.4 derived from the orbit data so it can never drift
 * out of sync with hand-edited mu/a values.
 */
function withSoi(specs: BodySpec[]): CelestialBodyDef[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  return specs.map((spec) => {
    if (!spec.orbit || spec.parentId === undefined) {
      return { ...spec, soiRadius: Infinity };
    }
    const parent = byId.get(spec.parentId);
    if (!parent) throw new Error(`body ${spec.id} has unknown parent ${spec.parentId}`);
    const soiRadius = spec.orbit.a * (spec.mu / parent.mu) ** 0.4;
    return { ...spec, soiRadius };
  });
}

export const SOLAR_SYSTEM: CelestialBodyDef[] = withSoi(SPECS);

export const BODY_APPEARANCE: Record<string, BodyAppearance> = {
  helios: { color: '#fff3c4', accentColor: '#ffd166', emissive: true },
  vulcan: { color: '#8a6a4f', accentColor: '#5c4433' },
  aphros: { color: '#7a5296', accentColor: '#5d3f78', atmosphereColor: '#b48ad6' },
  terra: { color: '#3a7bd5', accentColor: '#4f9e4f', atmosphereColor: '#7ec8ff' },
  luna: { color: '#9a9a9a', accentColor: '#6e6e6e' },
  pico: { color: '#b8d8cf', accentColor: '#8fb5ab' },
  ares: { color: '#c1653e', accentColor: '#8f4a2d', atmosphereColor: '#e8a583' },
  deimos: { color: '#7d7468', accentColor: '#5a534a' },
  jove: { color: '#6f9e58', accentColor: '#4d7a3c', atmosphereColor: '#a8d68f' },
  thalassa: { color: '#3f6fa8', accentColor: '#7a9e6f', atmosphereColor: '#9cc4e8' },
  kallo: { color: '#cdc3b4', accentColor: '#a89e8d' },
};
