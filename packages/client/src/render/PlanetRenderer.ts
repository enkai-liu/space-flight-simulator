import * as THREE from 'three';
import type { CelestialBodyDef } from '@sfs/sim';
import type { BodyAppearance } from '@sfs/data';
import { fbm, makeLcg, makeNoise3 } from './noise.js';

/**
 * Procedural body surfaces: 3D fbm noise sampled on the sphere (no pole
 * pinch), colored per appearance hints — land/ocean split, polar caps,
 * gas-giant bands. Deterministic per body id, cached for the session.
 */

const textureCache = new Map<string, { map: THREE.Texture; roughnessMap: THREE.Texture | null }>();

/** Deterministic per-body noise seed (id hash), shared with the launch site. */
export function bodyNoiseSeed(bodyId: string): number {
  let seed = 0;
  for (const ch of bodyId) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  return seed;
}

/** Sea level in fbm height units for ocean worlds. */
export const SEA_LEVEL = 0.53;

/**
 * Body-fixed render-frame direction of the launch pad (equator, longitude 0;
 * sim (1,0,0) maps to render (1,0,0)).
 */
const PAD_DIR = new THREE.Vector3(1, 0, 0);

export interface OceanSampler {
  /** Terrain height in fbm units at a body-fixed render-frame unit direction. */
  height(dir: THREE.Vector3): number;
  /** High-frequency variation used for dust/vegetation mottling. */
  grain(dir: THREE.Vector3): number;
  /** Surface color for a height/grain pair (land ramp above SEA_LEVEL, ocean below). */
  color(height: number, grain: number): [number, number, number];
  /** Material roughness byte (ocean is glossy for sun glint). */
  rough(height: number): number;
}

/**
 * Shared terrain field for ocean worlds, used by both the planet texture and
 * the launch-site ground so the two agree exactly where they meet. Around
 * PAD_DIR the height blends toward steady grassland so the launch site is
 * guaranteed to sit on a continent rather than mid-ocean.
 */
export function makeOceanSampler(bodyId: string, appearance: BodyAppearance): OceanSampler {
  const seed = bodyNoiseSeed(bodyId);
  const noise = makeNoise3(seed);
  const detail = makeNoise3(seed ^ 0x5f3759df);
  const base = hexToRgb(appearance.color);
  const accent = hexToRgb(appearance.accentColor);
  return {
    height(dir) {
      const h = fbm(noise, dir.x * 2.4, dir.y * 2.4, dir.z * 2.4, 5);
      // launch continent: within ~0.18 rad (~108 km) of the pad, pull the
      // height smoothly up to solid land (0.62 > SEA_LEVEL)
      const site = Math.max(0, 1 - dir.angleTo(PAD_DIR) / 0.18);
      const t = site * site * (3 - 2 * site);
      return h + (0.62 - h) * t;
    },
    grain(dir) {
      return fbm(detail, dir.x * 9, dir.y * 9, dir.z * 9, 3);
    },
    color(height, grain) {
      if (height < SEA_LEVEL) {
        const depth = (SEA_LEVEL - height) / SEA_LEVEL;
        return mix(scale(base, 1.05), scale(base, 0.55), depth * 1.6);
      }
      const landT = (height - SEA_LEVEL) / (1 - SEA_LEVEL);
      const rgb = mix(scale(accent, 1.12), scale(accent, 0.6), landT * 1.4);
      // dusty variation so continents aren't flat green
      return mix(rgb, scale(accent, 1.35), Math.max(0, grain - 0.55) * 1.2);
    },
    rough(height) {
      return height < SEA_LEVEL ? 45 : 235;
    },
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function scale(c: [number, number, number], f: number): [number, number, number] {
  return [c[0] * f, c[1] * f, c[2] * f];
}

function makeSurfaceTextures(
  bodyId: string,
  appearance: BodyAppearance,
  seed: number,
): { map: THREE.Texture; roughnessMap: THREE.Texture | null } {
  const cached = textureCache.get(bodyId);
  if (cached) return cached;

  // hero bodies get more pixels; texture gen is CPU-side, keep it bounded
  const hero = appearance.ocean || appearance.gasBands;
  const w = hero ? 1024 : 512;
  const h = w / 2;
  const octaves = hero ? 5 : 4;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(w, h);

  const roughCanvas = appearance.ocean ? document.createElement('canvas') : null;
  let roughData: ImageData | null = null;
  let roughCtx: CanvasRenderingContext2D | null = null;
  if (roughCanvas) {
    roughCanvas.width = w;
    roughCanvas.height = h;
    roughCtx = roughCanvas.getContext('2d')!;
    roughData = roughCtx.createImageData(w, h);
  }

  const noise = makeNoise3(seed);
  const detail = makeNoise3(seed ^ 0x5f3759df);
  const rand = makeLcg(seed >>> 1);
  const ocean = appearance.ocean ? makeOceanSampler(bodyId, appearance) : null;

  const base = hexToRgb(appearance.color);
  const accent = hexToRgb(appearance.accentColor);
  const ice: [number, number, number] = [235, 240, 245];

  const dir = new THREE.Vector3();
  for (let py = 0; py < h; py++) {
    const theta = (py / h) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let px = 0; px < w; px++) {
      const phi = (px / w) * Math.PI * 2;
      // matches SphereGeometry's UV mapping, whose x is NEGATED
      // (x = -cos(phi)·sin(theta)) — sample the same mesh-local direction the
      // texel lands on, so ground-level terrain can line up with this texture
      dir.set(-sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));

      const height = fbm(noise, dir.x * 2.4, dir.y * 2.4, dir.z * 2.4, octaves);
      const grain = fbm(detail, dir.x * 9, dir.y * 9, dir.z * 9, 3);
      let rgb: [number, number, number];
      let rough = 230;

      if (appearance.gasBands) {
        // latitude bands warped by turbulence, plus pale storm ovals
        const turb = (height - 0.5) * 2.2;
        const bands = 0.5 + 0.5 * Math.sin(cosT * 11 + turb);
        rgb = mix(scale(base, 1.08), accent, bands * 0.85);
        const storm = Math.max(0, grain - 0.62) * 3;
        rgb = mix(rgb, [225, 228, 210], storm * 0.5);
      } else if (appearance.emissive) {
        // granulated photosphere
        const g = 0.88 + 0.24 * height;
        rgb = scale(base, g);
      } else if (ocean) {
        // shared sampler (includes the guaranteed launch continent) so the
        // launch-site ground patch matches this texture exactly
        const oh = ocean.height(dir);
        rgb = ocean.color(oh, grain);
        rough = ocean.rough(oh);
      } else {
        // rocky default: two-tone ramp + cratered grain
        const t = Math.max(0, Math.min(1, (height - 0.38) * 3.2));
        rgb = mix(base, accent, t);
        rgb = scale(rgb, 0.85 + grain * 0.35);
      }

      if (appearance.polarCaps && !appearance.emissive) {
        const capEdge = 0.78 + (height - 0.5) * 0.1;
        const capT = (Math.abs(cosT) - capEdge) / 0.05;
        if (capT > 0) {
          rgb = mix(rgb, ice, Math.min(1, capT));
          rough = 120;
        }
      }

      const dith = rand() * 2 - 1;
      const idx = (py * w + px) * 4;
      image.data[idx] = Math.max(0, Math.min(255, rgb[0] + dith));
      image.data[idx + 1] = Math.max(0, Math.min(255, rgb[1] + dith));
      image.data[idx + 2] = Math.max(0, Math.min(255, rgb[2] + dith));
      image.data[idx + 3] = 255;
      if (roughData) {
        roughData.data[idx] = rough;
        roughData.data[idx + 1] = rough;
        roughData.data[idx + 2] = rough;
        roughData.data[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(image, 0, 0);
  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;

  let roughnessMap: THREE.Texture | null = null;
  if (roughCtx && roughData && roughCanvas) {
    roughCtx.putImageData(roughData, 0, 0);
    roughnessMap = new THREE.CanvasTexture(roughCanvas);
    roughnessMap.wrapS = THREE.RepeatWrapping;
    // data texture, not color — keep it linear
    roughnessMap.colorSpace = THREE.NoColorSpace;
  }

  const result = { map, roughnessMap };
  textureCache.set(bodyId, result);
  return result;
}

/** Slow-drifting cloud shell for ocean worlds with an atmosphere. */
function makeCloudLayer(radius: number, seed: number): THREE.Mesh {
  // planet-wide texture: keep the resolution up and the alpha ramp soft, or
  // individual cloud blobs read as hard bilinear quads from mid-ascent
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(w, h);
  const noise = makeNoise3(seed + 977);
  const dir = new THREE.Vector3();

  for (let py = 0; py < h; py++) {
    const theta = (py / h) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let px = 0; px < w; px++) {
      const phi = (px / w) * Math.PI * 2;
      dir.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
      // stretched horizontally for a streaky weather-system look; smoothstep
      // edge so cloud borders feather out instead of stepping
      const n = fbm(noise, dir.x * 3, dir.y * 6, dir.z * 3, 6);
      const t = Math.min(1, Math.max(0, (n - 0.57) / 0.18));
      const a = t * t * (3 - 2 * t);
      const idx = (py * w + px) * 4;
      image.data[idx] = 255;
      image.data[idx + 1] = 255;
      image.data[idx + 2] = 255;
      image.data[idx + 3] = Math.min(210, a * 230);
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.012, 48, 32),
    new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
    }),
  );
  mesh.name = 'clouds';
  // draw after the launch-site ground layers (renderOrder 1-3) — depth-based
  // transparent sorting puts this planet-centered shell "farther" than the
  // terrain cap and would paint the ground over the clouds from above
  mesh.renderOrder = 5;
  // slow drift relative to the surface; pure decoration, wall-clock driven
  mesh.onBeforeRender = () => {
    mesh.rotation.y = (performance.now() / 1000) * 0.004;
  };
  return mesh;
}

/** Banded ring with a radial gap, in the body's equatorial plane. */
function makeRing(radius: number, appearance: BodyAppearance, seed: number): THREE.Mesh {
  const inner = radius * 1.5;
  const outer = radius * 2.4;
  const geometry = new THREE.RingGeometry(inner, outer, 160, 1);

  // RingGeometry UVs are planar — remap u to the radial coordinate so a
  // 1D band strip stretches around the ring
  const pos = geometry.attributes.position!;
  const uv = geometry.attributes.uv!;
  const v3 = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v3.fromBufferAttribute(pos as THREE.BufferAttribute, i);
    const r = Math.sqrt(v3.x * v3.x + v3.y * v3.y);
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }

  const w = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 4;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(w, 4);
  const noise = makeNoise3(seed + 4111);
  const base = hexToRgb(appearance.accentColor);
  for (let px = 0; px < w; px++) {
    const t = px / w;
    const n = fbm(noise, t * 14, 0.5, 0.5, 4);
    // dusty bands; a Cassini-like gap two-thirds out
    let alpha = (0.25 + 0.65 * n) * Math.sin(t * Math.PI) ** 0.6;
    if (t > 0.62 && t < 0.7) alpha *= 0.15;
    const shade = 0.75 + n * 0.5;
    for (let py = 0; py < 4; py++) {
      const idx = (py * w + px) * 4;
      image.data[idx] = Math.min(255, base[0] * shade + 60);
      image.data[idx + 1] = Math.min(255, base[1] * shade + 58);
      image.data[idx + 2] = Math.min(255, base[2] * shade + 50);
      image.data[idx + 3] = alpha * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2; // equatorial plane
  mesh.name = 'ring';
  return mesh;
}

/**
 * Billboard glow around the star. Depth-tested (but not depth-writing) so the
 * body's own disc and any planet in front occlude it correctly; only the halo
 * past the limb survives, which is exactly the look we want.
 */
function makeGlowSprite(radius: number): THREE.Sprite {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255, 246, 220, 1)');
  g.addColorStop(0.22, 'rgba(255, 218, 140, 0.6)');
  g.addColorStop(0.55, 'rgba(255, 176, 90, 0.18)');
  g.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  sprite.scale.setScalar(radius * 8);
  return sprite;
}

/** Additive fresnel-rim shell that fakes an atmosphere from orbit. */
function makeAtmosphereShell(radius: number, color: string): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        // BackSide: rim glow strongest at the limb
        float rim = pow(1.0 - abs(dot(vNormal, vViewDir)), 2.0);
        gl_FragColor = vec4(uColor, rim * 0.9);
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius * 1.03, 48, 32), material);
}

/**
 * Builds the Object3D for one celestial body: surface sphere (+ atmosphere
 * shell, clouds, ring). The group's position is driven by FloatingOrigin;
 * rotation about the render Y axis (= sim north pole) is set per frame by
 * the caller — children like the ring inherit it.
 */
export function createBodyObject(body: CelestialBodyDef, appearance: BodyAppearance): THREE.Group {
  const group = new THREE.Group();
  group.name = body.id;

  const seed = bodyNoiseSeed(body.id);

  // ocean (landable-launch) worlds get a denser sphere: at 64 segments the
  // chord error is ~700 m at Terra scale, which reads as huge flat facets
  // during early ascent; 192 segments brings it under ~80 m
  const geometry = appearance.ocean
    ? new THREE.SphereGeometry(body.radius, 192, 128)
    : new THREE.SphereGeometry(body.radius, 64, 48);
  const { map, roughnessMap } = makeSurfaceTextures(body.id, appearance, seed);
  const material = appearance.emissive
    ? new THREE.MeshBasicMaterial({ map })
    : new THREE.MeshStandardMaterial({
        map,
        roughnessMap: roughnessMap ?? undefined,
        roughness: 1,
        metalness: 0,
      });
  // HDR: push the star's disc past the bloom threshold so it glows
  if (appearance.emissive) material.color.setRGB(2.5, 2.2, 1.6);
  const surface = new THREE.Mesh(geometry, material);
  surface.name = `${body.id}-surface`;
  // ocean worlds host the launch-site terrain cap at the exact surface
  // radius; sink the sphere ~90 m so the two never z-fight
  if (appearance.ocean) surface.scale.setScalar(1 - 1.5e-4);
  group.add(surface);

  if (body.atmosphere && appearance.atmosphereColor) {
    group.add(makeAtmosphereShell(body.radius, appearance.atmosphereColor));
  }

  if (appearance.ocean && body.atmosphere) {
    group.add(makeCloudLayer(body.radius, seed));
  }

  if (appearance.ring) {
    group.add(makeRing(body.radius, appearance, seed));
  }

  if (appearance.emissive) {
    // a faint glow shell plus a billboard halo for the star
    group.add(makeAtmosphereShell(body.radius, appearance.color));
    group.add(makeGlowSprite(body.radius));
  }

  return group;
}
