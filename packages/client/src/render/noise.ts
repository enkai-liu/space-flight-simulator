/** Deterministic procedural-noise helpers shared by the sky and planet renderers. */

export function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export type Noise3 = (x: number, y: number, z: number) => number;

/** 3D value noise; sampled on the unit sphere it avoids equirect pole pinch. */
export function makeNoise3(seed: number): Noise3 {
  const hash = (xi: number, yi: number, zi: number): number => {
    let h = (xi * 374761393 + yi * 668265263 + zi * 2147483647 + seed * 144665) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const tz = smooth(z - zi);
    let v = 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
          v += w * hash(xi + dx, yi + dy, zi + dz);
        }
      }
    }
    return v;
  };
}

export function fbm(noise: Noise3, x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum;
}
