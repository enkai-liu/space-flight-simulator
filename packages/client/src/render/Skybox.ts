import * as THREE from 'three';

/**
 * Sky backdrop: a procedural nebula dome plus layered star fields, all on
 * fixed spheres around the camera. Since the camera always sits at the scene
 * origin (floating origin), none of it ever moves — no FloatingOrigin
 * registration needed. Everything is deterministic: same sky every load.
 */

/** Galactic-band plane normal (arbitrary fixed tilt, shared by stars + nebula). */
const BAND_NORMAL = new THREE.Vector3(0.32, 0.87, 0.38).normalize();

const STAR_RADIUS = 5e12; // far beyond everything; log depth buffer copes
const NEBULA_RADIUS = 8e12; // behind the stars, inside the 1e13 far plane

function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One layer of stars; a fraction sits pulled toward the galactic band. */
function makeStarLayer(opts: {
  count: number;
  size: number;
  seed: number;
  bandFraction: number;
  hdrFraction: number;
  brightness: [number, number];
}): THREE.Points {
  const { count, size, seed, bandFraction, hdrFraction, brightness } = opts;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const rand = makeLcg(seed);
  const dir = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    // uniform direction on the sphere
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const xy = Math.sqrt(1 - z * z);
    dir.set(xy * Math.cos(phi), xy * Math.sin(phi), z);

    if (rand() < bandFraction) {
      // squash toward the band plane for milky-way structure
      const d = dir.dot(BAND_NORMAL);
      dir.addScaledVector(BAND_NORMAL, -d * (0.75 + rand() * 0.2)).normalize();
    }

    positions[i * 3] = STAR_RADIUS * dir.x;
    positions[i * 3 + 1] = STAR_RADIUS * dir.y;
    positions[i * 3 + 2] = STAR_RADIUS * dir.z;

    let b = brightness[0] + rand() * (brightness[1] - brightness[0]);
    // a handful of HDR-bright stars cross the bloom threshold and twinkle-glow
    if (rand() < hdrFraction) b *= 2.4;
    const warmth = rand();
    colors[i * 3] = b;
    colors[i * 3 + 1] = b * (0.85 + 0.15 * warmth);
    colors[i * 3 + 2] = b * (0.8 + 0.2 * (1 - warmth));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size,
      sizeAttenuation: false,
      vertexColors: true,
      depthWrite: false,
    }),
  );
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}

/** 3D value noise + fbm, sampled on the sphere so the poles don't pinch. */
function makeNoise3(seed: number): (x: number, y: number, z: number) => number {
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
          const w =
            (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
          v += w * hash(xi + dx, yi + dy, zi + dz);
        }
      }
    }
    return v;
  };
}

function fbm(noise: (x: number, y: number, z: number) => number, x: number, y: number, z: number, octaves: number): number {
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

/** Very dark color-cloud dome; brightest along the galactic band. */
function makeNebulaDome(): THREE.Mesh {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(w, h);
  const noise = makeNoise3(1337);
  const rand = makeLcg(7);
  const dir = new THREE.Vector3();

  for (let py = 0; py < h; py++) {
    const v = py / h;
    const theta = v * Math.PI; // 0..π from north pole
    for (let px = 0; px < w; px++) {
      const u = px / w;
      const phi = u * Math.PI * 2;
      dir.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));

      const n1 = fbm(noise, dir.x * 3 + 11, dir.y * 3, dir.z * 3, 5);
      const n2 = fbm(noise, dir.x * 5 + 47, dir.y * 5 + 13, dir.z * 5, 4);
      const band = Math.exp(-((dir.dot(BAND_NORMAL) / 0.28) ** 2));

      // cloud density: mostly nothing, wisps where fbm peaks, denser in-band
      const density = Math.max(0, n1 - 0.52) * (0.55 + band);
      const glow = band * 0.35 + density * 1.6;

      // deep blue base, teal wisps, a magenta touch where n2 peaks
      const magenta = Math.max(0, n2 - 0.58) * 2;
      let r = 6 + glow * (22 + magenta * 26);
      let g = 9 + glow * (30 - magenta * 6);
      let b = 16 + glow * 46;
      // ±1 dither hides banding on the smooth gradients
      const dith = rand() * 2 - 1;
      r += dith;
      g += dith;
      b += dith;

      const idx = (py * w + px) * 4;
      image.data[idx] = Math.max(0, Math.min(255, r));
      image.data[idx + 1] = Math.max(0, Math.min(255, g));
      image.data[idx + 2] = Math.max(0, Math.min(255, b));
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(NEBULA_RADIUS, 48, 32),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, depthWrite: false }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

/** Full sky backdrop: nebula dome + faint background stars + main stars. */
export function createSky(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'sky';
  group.add(makeNebulaDome());
  group.add(
    makeStarLayer({
      count: 6000,
      size: 1.2,
      seed: 42,
      bandFraction: 0.5,
      hdrFraction: 0,
      brightness: [0.15, 0.45],
    }),
  );
  group.add(
    makeStarLayer({
      count: 3500,
      size: 2.2,
      seed: 4242,
      bandFraction: 0.4,
      hdrFraction: 0.02,
      brightness: [0.4, 1.0],
    }),
  );
  return group;
}
