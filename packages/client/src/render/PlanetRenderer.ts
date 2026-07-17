import * as THREE from 'three';
import type { CelestialBodyDef } from '@sfs/sim';
import type { BodyAppearance } from '@sfs/data';

/** Deterministic PRNG so a body's surface looks the same every load. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural equirectangular surface texture: base color + noise blotches. */
function makeSurfaceTexture(appearance: BodyAppearance, seed: number): THREE.Texture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(seed);

  ctx.fillStyle = appearance.color;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = appearance.accentColor;
  const blobCount = 220;
  for (let i = 0; i < blobCount; i++) {
    const x = rand() * w;
    // bias blobs toward the equator so poles stay clean
    const y = h * (0.5 + (rand() - 0.5) * 0.85);
    const rBase = 8 + rand() * 46;
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    // blotchy cluster instead of a perfect circle
    for (let j = 0; j < 5; j++) {
      const dx = (rand() - 0.5) * rBase * 2;
      const dy = (rand() - 0.5) * rBase;
      ctx.beginPath();
      ctx.ellipse(x + dx, y + dy, rBase * (0.4 + rand() * 0.6), rBase * (0.3 + rand() * 0.4), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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
 * shell). The group's position is driven by FloatingOrigin; rotation about
 * the render Y axis (= sim north pole) is set per frame by the caller.
 */
export function createBodyObject(body: CelestialBodyDef, appearance: BodyAppearance): THREE.Group {
  const group = new THREE.Group();
  group.name = body.id;

  let seed = 0;
  for (const ch of body.id) seed = (seed * 31 + ch.charCodeAt(0)) | 0;

  const geometry = new THREE.SphereGeometry(body.radius, 64, 48);
  const texture = makeSurfaceTexture(appearance, seed);
  const material = appearance.emissive
    ? new THREE.MeshBasicMaterial({ map: texture })
    : new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
  // HDR: push the star's disc past the bloom threshold so it glows
  if (appearance.emissive) material.color.setRGB(2.5, 2.2, 1.6);
  const surface = new THREE.Mesh(geometry, material);
  surface.name = `${body.id}-surface`;
  group.add(surface);

  if (body.atmosphere && appearance.atmosphereColor) {
    group.add(makeAtmosphereShell(body.radius, appearance.atmosphereColor));
  }

  if (appearance.emissive) {
    // a faint glow shell plus a billboard halo for the star
    group.add(makeAtmosphereShell(body.radius, appearance.color));
    group.add(makeGlowSprite(body.radius));
  }

  return group;
}
