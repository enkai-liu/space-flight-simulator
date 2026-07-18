import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Vec3, type SystemTree } from '@sfs/sim';
import type { BodyAppearance } from '@sfs/data';
import { simToRender } from './FloatingOrigin.js';
import { fbm, makeLcg, makeNoise3 } from './noise.js';
import { makeOceanSampler, bodyNoiseSeed, type OceanSampler } from './PlanetRenderer.js';

/**
 * Launch-site local frame: X = east, Y = north, Z = up (radial). The frame is
 * fixed to the rotating body (see updateOrientation), so ground textures stay
 * aligned with the planet texture underneath.
 */

/** Arc radius of the big terrain patch, m (~90 km ≈ the launch continent core). */
const CAP_ARC = 90_000;
/** Arc radius of the fine grass detail disc, m. */
const DETAIL_ARC = 2_500;
/** Concrete apron radius, m. */
const APRON_R = 45;

/** Height drop of the spherical surface at arc distance s from the pad. */
function capDrop(s: number, R: number): number {
  return R * (Math.cos(s / R) - 1);
}

/**
 * Spherical-cap geometry around the pad: concentric rings of vertices pulled
 * down onto the true sphere so the ground curves away like the planet does,
 * instead of ending in a visible flat plane during early ascent. UVs are
 * planar in arc-length coordinates over [-arc, arc]².
 */
function makeCapGeometry(R: number, arc: number, ringRadii: number[], segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const [ri, s] of ringRadii.entries()) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const flat = s === 0 ? 0 : R * Math.sin(s / R);
      positions.push(Math.cos(a) * flat, Math.sin(a) * flat, capDrop(s, R));
      uvs.push(0.5 + (s * Math.cos(a)) / (2 * arc), 0.5 + (s * Math.sin(a)) / (2 * arc));
      if (ri > 0) {
        const jn = (j + 1) % segments;
        const inner = (ri - 1) * segments;
        const outer = ri * segments;
        indices.push(inner + j, outer + j, outer + jn, inner + j, outer + jn, inner + jn);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

interface GroundTextures {
  cap: THREE.Texture;
  capRough: THREE.Texture;
  detail: THREE.Texture;
}
const groundTextureCache = new Map<string, GroundTextures>();

/**
 * Continent-scale ground texture: samples the exact same ocean/land noise
 * field as the planet texture, in body-fixed directions around the pad, so
 * coastlines and colors continue seamlessly from ground level to orbit.
 */
function makeGroundTextures(
  bodyId: string,
  longitude: number,
  R: number,
  sampler: OceanSampler,
): GroundTextures {
  const cacheKey = `${bodyId}:${longitude.toFixed(4)}`;
  const cached = groundTextureCache.get(cacheKey);
  if (cached) return cached;

  // body-fixed basis of the site at `longitude` (sim frame, Z-up)
  const upSim = new Vec3(Math.cos(longitude), Math.sin(longitude), 0);
  const eastSim = new Vec3(-Math.sin(longitude), Math.cos(longitude), 0);
  const northSim = new Vec3(0, 0, 1);
  const dir = new THREE.Vector3();
  /** Render-frame body-fixed direction at local arc coordinates (ax, ay). */
  const dirAt = (ax: number, ay: number): THREE.Vector3 => {
    const s = Math.hypot(ax, ay);
    const c = Math.cos(s / R);
    const k = s === 0 ? 0 : Math.sin(s / R) / s;
    const bf = upSim.scale(c).add(eastSim.scale(ax * k)).add(northSim.scale(ay * k));
    return dir.set(bf.x, bf.z, -bf.y); // simToRender without allocating
  };

  // --- continent cap: land/sea + roughness, coarse (117 m/px) ---
  const capSize = 768;
  const capCanvas = document.createElement('canvas');
  capCanvas.width = capSize;
  capCanvas.height = capSize;
  const capCtx = capCanvas.getContext('2d')!;
  const capImage = capCtx.createImageData(capSize, capSize);
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = capSize;
  roughCanvas.height = capSize;
  const roughCtx = roughCanvas.getContext('2d')!;
  const roughImage = roughCtx.createImageData(capSize, capSize);

  for (let py = 0; py < capSize; py++) {
    const ay = (0.5 - py / (capSize - 1)) * 2 * CAP_ARC;
    for (let px = 0; px < capSize; px++) {
      const ax = (px / (capSize - 1) - 0.5) * 2 * CAP_ARC;
      const s = Math.hypot(ax, ay);
      const d = dirAt(ax, ay);
      const height = sampler.height(d);
      const grain = sampler.grain(d);
      const rgb = sampler.color(height, grain);
      // feather the rim so the cap dissolves into the planet sphere
      const alpha = s < CAP_ARC * 0.82 ? 1 : Math.max(0, 1 - (s - CAP_ARC * 0.82) / (CAP_ARC * 0.18));
      const idx = (py * capSize + px) * 4;
      capImage.data[idx] = rgb[0];
      capImage.data[idx + 1] = rgb[1];
      capImage.data[idx + 2] = rgb[2];
      capImage.data[idx + 3] = alpha * 255;
      const rough = sampler.rough(height);
      roughImage.data[idx] = rough;
      roughImage.data[idx + 1] = rough;
      roughImage.data[idx + 2] = rough;
      roughImage.data[idx + 3] = 255;
    }
  }
  capCtx.putImageData(capImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);

  const cap = new THREE.CanvasTexture(capCanvas);
  cap.colorSpace = THREE.SRGBColorSpace;
  const capRough = new THREE.CanvasTexture(roughCanvas);
  capRough.colorSpace = THREE.NoColorSpace;

  // --- detail disc: meter-scale grass over the (guaranteed-land) pad area ---
  const detSize = 640;
  const detCanvas = document.createElement('canvas');
  detCanvas.width = detSize;
  detCanvas.height = detSize;
  const detCtx = detCanvas.getContext('2d')!;
  const detImage = detCtx.createImageData(detSize, detSize);
  const grass = makeNoise3(bodyNoiseSeed(bodyId) ^ 0x1ead);

  // the pad sits well inside the launch continent, so the base color is the
  // sampler's land ramp at the local height — matching the cap underneath
  for (let py = 0; py < detSize; py++) {
    const ay = (0.5 - py / (detSize - 1)) * 2 * DETAIL_ARC;
    for (let px = 0; px < detSize; px++) {
      const ax = (px / (detSize - 1) - 0.5) * 2 * DETAIL_ARC;
      const s = Math.hypot(ax, ay);
      const d = dirAt(ax, ay);
      const base = sampler.color(sampler.height(d), sampler.grain(d));

      // meter-scale grass mottling + dry patches
      const n = fbm(grass, ax / 42, ay / 42, 0.5, 4);
      const patch = fbm(grass, ax / 260 + 40, ay / 260, 0.5, 3);
      const dry = Math.max(0, patch - 0.58) * 1.6;
      let rr = base[0] * (0.86 + n * 0.3) + dry * 46;
      let gg = base[1] * (0.86 + n * 0.3) + dry * 24;
      let bb = base[2] * (0.86 + n * 0.3);

      // grounds-keeping ring: slightly worn grass around the apron
      const worn = Math.max(0, 1 - Math.abs(s - APRON_R - 12) / 14) * 0.35;
      rr = rr * (1 - worn) + 128 * worn;
      gg = gg * (1 - worn) + 116 * worn;
      bb = bb * (1 - worn) + 96 * worn;

      // cut a hole for the concrete apron (which sits just below this layer)
      let alpha = s < DETAIL_ARC * 0.78 ? 1 : Math.max(0, 1 - (s - DETAIL_ARC * 0.78) / (DETAIL_ARC * 0.22));
      if (s < APRON_R - 2) alpha = 0;
      else if (s < APRON_R) alpha *= (s - (APRON_R - 2)) / 2;
      const idx = (py * detSize + px) * 4;
      detImage.data[idx] = Math.min(255, rr);
      detImage.data[idx + 1] = Math.min(255, gg);
      detImage.data[idx + 2] = Math.min(255, bb);
      detImage.data[idx + 3] = alpha * 255;
    }
  }
  detCtx.putImageData(detImage, 0, 0);
  const detail = new THREE.CanvasTexture(detCanvas);
  detail.colorSpace = THREE.SRGBColorSpace;

  const result = { cap, capRough, detail };
  groundTextureCache.set(cacheKey, result);
  return result;
}

/** Apron surface markings: joints, hazard ring, blast scorch. */
function makeApronTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const px = size / (APRON_R * 2); // pixels per meter

  // concrete base with mottling
  ctx.fillStyle = '#9a9da3';
  ctx.fillRect(0, 0, size, size);
  const noise = makeNoise3(0xc0ffee);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    const n = (fbm(noise, x / 60, y / 60, 0.5, 3) - 0.5) * 26;
    for (let ch = 0; ch < 3; ch++) {
      image.data[i * 4 + ch] = image.data[i * 4 + ch]! + n;
    }
  }
  ctx.putImageData(image, 0, 0);

  const c = size / 2;
  // expansion joints
  ctx.strokeStyle = 'rgba(40, 44, 50, 0.5)';
  ctx.lineWidth = 1.5;
  for (let m = -40; m <= 40; m += 10) {
    ctx.beginPath();
    ctx.moveTo(c + m * px, 0);
    ctx.lineTo(c + m * px, size);
    ctx.moveTo(0, c + m * px);
    ctx.lineTo(size, c + m * px);
    ctx.stroke();
  }
  // hazard ring around the mount
  ctx.strokeStyle = '#c9a72c';
  ctx.lineWidth = 1.2 * px;
  ctx.beginPath();
  ctx.arc(c, c, 9 * px, 0, Math.PI * 2);
  ctx.stroke();
  // perimeter line
  ctx.strokeStyle = 'rgba(240, 243, 247, 0.55)';
  ctx.lineWidth = 0.6 * px;
  ctx.beginPath();
  ctx.arc(c, c, 42 * px, 0, Math.PI * 2);
  ctx.stroke();
  // blast scorch
  const scorch = ctx.createRadialGradient(c, c, 0, c, c, 12 * px);
  scorch.addColorStop(0, 'rgba(22, 20, 18, 0.85)');
  scorch.addColorStop(0.5, 'rgba(30, 27, 24, 0.45)');
  scorch.addColorStop(1, 'rgba(30, 27, 24, 0)');
  ctx.fillStyle = scorch;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Box beam between two points (for lattice structures), baked into place. */
function beam(from: THREE.Vector3, to: THREE.Vector3, thickness: number): THREE.BoxGeometry {
  const dir = to.clone().sub(from);
  const geometry = new THREE.BoxGeometry(dir.length(), thickness, thickness);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.normalize());
  const m = new THREE.Matrix4().compose(
    from.clone().add(to).multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1),
  );
  geometry.applyMatrix4(m);
  return geometry;
}

function box(w: number, d: number, h: number, x: number, y: number, z: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(w, d, h);
  geometry.translate(x, y, z);
  return geometry;
}

// facility materials get no env map, so keep metalness low — with only the
// sun + ambient to reflect, metallic surfaces here would render nearly black
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb9bfc7, roughness: 0.55, metalness: 0.15 });
const RED_STEEL = new THREE.MeshStandardMaterial({ color: 0xc24638, roughness: 0.55, metalness: 0.1 });
const CONCRETE = new THREE.MeshStandardMaterial({ color: 0x8d9096, roughness: 0.95, metalness: 0.02 });
const ASPHALT = new THREE.MeshStandardMaterial({ color: 0x54585e, roughness: 0.98, metalness: 0 });
const WALL = new THREE.MeshStandardMaterial({ color: 0xc3c7cc, roughness: 0.85, metalness: 0.02 });
const WALL_DARK = new THREE.MeshStandardMaterial({ color: 0x707781, roughness: 0.85, metalness: 0.02 });
const ROOF = new THREE.MeshStandardMaterial({ color: 0x5d646d, roughness: 0.9, metalness: 0.05 });
const TANK_WHITE = new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.5, metalness: 0.08 });
const WINDOW_DARK = new THREE.MeshStandardMaterial({ color: 0x1c2833, roughness: 0.3, metalness: 0.2 });

/** Small HDR beacon that the bloom pass picks up. */
function beacon(x: number, y: number, z: number): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial();
  material.color.setRGB(2.6, 0.45, 0.3);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), material);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Lattice umbilical tower with service arms, crane head and lightning mast. */
function makeTower(padDir: THREE.Vector3, armReach: number): THREE.Group {
  const group = new THREE.Group();
  const grey: THREE.BufferGeometry[] = [];
  const red: THREE.BufferGeometry[] = [];
  const H = 26;
  const W = 1.35;
  const LEVELS = 8;
  const corners = [
    [W, W],
    [W, -W],
    [-W, -W],
    [-W, W],
  ] as const;

  for (const [cx, cy] of corners) {
    grey.push(beam(new THREE.Vector3(cx, cy, 0), new THREE.Vector3(cx, cy, H), 0.32));
  }
  for (let level = 1; level <= LEVELS; level++) {
    const z = (level / LEVELS) * H;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i]!;
      const [bx, by] = corners[(i + 1) % 4]!;
      grey.push(beam(new THREE.Vector3(ax, ay, z), new THREE.Vector3(bx, by, z), 0.2));
      // alternating diagonals give the truss look
      const zPrev = ((level - 1) / LEVELS) * H;
      const flip = (level + i) % 2 === 0;
      grey.push(
        beam(
          new THREE.Vector3(flip ? ax : bx, flip ? ay : by, zPrev),
          new THREE.Vector3(flip ? bx : ax, flip ? by : ay, z),
          0.13,
        ),
      );
    }
    // work platform every other level
    if (level % 2 === 0 && level < LEVELS) grey.push(box(3.3, 3.3, 0.12, 0, 0, z + 0.06));
  }

  // umbilical service arms reaching toward the vehicle
  for (const z of [7, 14]) {
    const start = padDir.clone().multiplyScalar(W).setZ(z);
    const end = padDir.clone().multiplyScalar(armReach).setZ(z);
    grey.push(beam(start, end, 0.3));
    grey.push(box(1.1, 1.1, 0.7, end.x, end.y, z)); // swing-arm plate
    grey.push(
      beam(padDir.clone().multiplyScalar(W).setZ(z + 2.6), end.clone().setZ(z + 0.35), 0.12),
    ); // tie-back stay
  }

  // red crane head: short extension, boom over the pad, counter-jib, cable
  const boomTip = padDir.clone().multiplyScalar(7).setZ(H + 3);
  for (const [cx, cy] of corners) {
    red.push(beam(new THREE.Vector3(cx * 0.55, cy * 0.55, H), new THREE.Vector3(cx * 0.4, cy * 0.4, H + 3), 0.22));
  }
  red.push(beam(new THREE.Vector3(0, 0, H + 3), boomTip, 0.3));
  red.push(beam(new THREE.Vector3(0, 0, H + 3), padDir.clone().multiplyScalar(-2.6).setZ(H + 3), 0.3));
  red.push(beam(boomTip, boomTip.clone().setZ(H - 1.5), 0.07));

  group.add(new THREE.Mesh(mergeGeometries(grey), STEEL));
  group.add(new THREE.Mesh(mergeGeometries(red), RED_STEEL));

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 6, 8), STEEL);
  mast.rotation.x = Math.PI / 2;
  mast.position.z = H + 3 + 3;
  group.add(mast);
  group.add(beacon(0, 0, H + 6.4));
  return group;
}

/** Tapered lightning-protection mast. */
function makeLightningMast(): THREE.Group {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.75, 21, 10), STEEL);
  pole.rotation.x = Math.PI / 2;
  pole.position.z = 10.5;
  group.add(pole);
  const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.09, 4.5, 6), STEEL);
  spike.rotation.x = Math.PI / 2;
  spike.position.z = 21 + 2.25;
  group.add(spike);
  group.add(beacon(0, 0, 21.4));
  return group;
}

/** Support campus east of the pad: assembly building, hangar, control, tanks. */
function makeCampus(): THREE.Group {
  const group = new THREE.Group();
  const add = (mesh: THREE.Mesh): THREE.Mesh => {
    group.add(mesh);
    return mesh;
  };
  const solid = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh =>
    add(new THREE.Mesh(geometry, material));

  // vehicle assembly building
  solid(box(34, 26, 28, 185, 35, 14), WALL);
  solid(box(35.2, 27.2, 1.2, 185, 35, 28.6), ROOF);
  solid(box(0.5, 15, 23, 185 - 17.2, 35, 11.5), WALL_DARK); // tall door
  solid(box(0.6, 26.4, 2.2, 185, 35, 24), WALL_DARK); // trim band
  group.add(beacon(185, 35, 29.6));

  // hangar: low box + barrel roof + end caps
  solid(box(26, 16, 5.5, 150, -45, 2.75), WALL);
  // barrel roof: half-cylinder lying along X, flattened a little, arc up
  const barrelGeo = new THREE.CylinderGeometry(8, 8, 26, 24, 1, true, 0, Math.PI);
  barrelGeo.rotateZ(Math.PI / 2); // axis onto X; arc now spans the ±Y half
  barrelGeo.rotateX(Math.PI / 2); // arc up (+Z), open side down
  barrelGeo.scale(1, 1, 0.72);
  const barrel = new THREE.Mesh(barrelGeo, ROOF);
  barrel.position.set(150, -45, 5.5);
  group.add(barrel);
  const endWall = WALL.clone();
  endWall.side = THREE.DoubleSide;
  for (const ex of [-13, 13]) {
    // vertical semicircular end walls under the barrel arc
    const capGeo = new THREE.CircleGeometry(8, 24, 0, Math.PI);
    capGeo.scale(1, 0.72, 1);
    const endCap = new THREE.Mesh(capGeo, endWall);
    endCap.rotation.y = Math.PI / 2;
    endCap.position.set(150 + ex, -45, 5.5);
    group.add(endCap);
  }
  solid(box(0.4, 10, 4.4, 150 - 13.1, -45, 2.2), WALL_DARK); // hangar door

  // control center with dish
  solid(box(16, 12, 7, 215, -25, 3.5), WALL);
  solid(box(17.4, 13.4, 0.8, 215, -25, 7.4), ROOF);
  solid(box(14, 0.25, 1.7, 215, -25 - 6.05, 4.6), WINDOW_DARK);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 3.2, 8), STEEL);
  pole.rotation.x = Math.PI / 2;
  pole.position.set(210, -22, 9.4);
  group.add(pole);
  const dishProfile = [
    new THREE.Vector2(0.05, 0),
    new THREE.Vector2(1.2, 0.22),
    new THREE.Vector2(2.4, 0.85),
  ];
  const dish = new THREE.Mesh(new THREE.LatheGeometry(dishProfile, 20), new THREE.MeshStandardMaterial({
    color: 0xdfe3e8,
    roughness: 0.5,
    metalness: 0.3,
    side: THREE.DoubleSide,
  }));
  dish.position.set(210, -22, 11);
  dish.rotation.set(Math.PI / 2 + 0.85, 0, 0.4);
  group.add(dish);

  // fuel tank farm
  for (const [tx, ty] of [
    [134, 56],
    [142, 56],
    [134, 66],
    [142, 66],
  ] as const) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 9, 18), TANK_WHITE);
    body.rotation.x = Math.PI / 2;
    body.position.set(tx, ty, 4.5);
    group.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(3, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), TANK_WHITE);
    dome.position.set(tx, ty, 9);
    group.add(dome);
  }
  const horizontal = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 12, 16), TANK_WHITE);
  horizontal.rotation.z = Math.PI / 2;
  horizontal.position.set(158, 61, 2.7);
  group.add(horizontal);
  solid(box(1.2, 4.4, 1.6, 154, 61, 0.8), CONCRETE);
  solid(box(1.2, 4.4, 1.6, 162, 61, 0.8), CONCRETE);

  // ground slabs under each cluster
  solid(box(44, 36, 0.24, 185, 35, 0.12), CONCRETE);
  solid(box(32, 24, 0.24, 150, -45, 0.12), CONCRETE);
  solid(box(22, 18, 0.24, 215, -25, 0.12), CONCRETE);
  solid(box(38, 20, 0.24, 145, 61, 0.12), CONCRETE);
  return group;
}

/** Flat asphalt road segment between two points, slightly above the terrain. */
function road(fromX: number, fromY: number, toX: number, toY: number, width: number): THREE.Mesh {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, width, 0.14), ASPHALT);
  mesh.position.set((fromX + toX) / 2, (fromY + toY) / 2, 0.07);
  mesh.rotation.z = Math.atan2(dy, dx);
  return mesh;
}

/** Instanced conifers scattered over the countryside (never on the facility). */
function makeTrees(R: number, seed: number): THREE.Group {
  const group = new THREE.Group();
  const COUNT = 420;
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 1.6, 6);
  trunkGeo.rotateX(Math.PI / 2);
  trunkGeo.translate(0, 0, 0.8);
  const canopyGeo = new THREE.ConeGeometry(1.7, 4.4, 8);
  canopyGeo.rotateX(Math.PI / 2);
  canopyGeo.translate(0, 0, 1.4 + 2.2);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x3a6b3a, roughness: 0.95 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, COUNT);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, COUNT);

  const rand = makeLcg(seed ^ 0x7ee5);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  let placed = 0;
  let guard = 0;
  while (placed < COUNT && guard++ < COUNT * 20) {
    const a = rand() * Math.PI * 2;
    // bias toward the near field so the countryside doesn't look empty
    const s = 110 + Math.pow(rand(), 1.35) * (DETAIL_ARC * 0.9 - 110);
    const x = Math.cos(a) * s;
    const y = Math.sin(a) * s;
    // keep the facility footprint (apron + campus + roads) clear
    if (x > 30 && x < 245 && y > -95 && y < 95) continue;
    if (s < APRON_R + 25) continue;
    const scale = 0.7 + rand() * 0.8;
    m.compose(new THREE.Vector3(x, y, capDrop(s, R)), q, new THREE.Vector3(scale, scale, scale));
    trunks.setMatrixAt(placed, m);
    canopies.setMatrixAt(placed, m);
    canopies.setColorAt(placed, color.setHSL(0.32 + rand() * 0.05, 0.4 + rand() * 0.2, 0.24 + rand() * 0.1));
    placed++;
  }
  trunks.count = placed;
  canopies.count = placed;
  group.add(trunks);
  group.add(canopies);
  return group;
}

/**
 * Local ground and facilities at the launch site. The terrain is a spherical
 * cap textured with the same continent noise field as the planet itself, so
 * the launch region reads as part of a continent from the pad all the way up
 * to orbit (full terrain LOD stays deferred post-M6, plan §4.3).
 */
export class LaunchSite {
  readonly object = new THREE.Group();

  constructor(
    private readonly tree: SystemTree,
    private readonly bodyId: string,
    private readonly longitude: number,
    appearance: BodyAppearance,
    envMap?: THREE.Texture,
  ) {
    this.object.name = 'launch-site';
    // the metal/painted structures share the vessel's env map so they read
    // with the same studio sheen instead of going dark against the sky
    if (envMap) {
      for (const material of [STEEL, RED_STEEL, WALL, WALL_DARK, ROOF, TANK_WHITE, WINDOW_DARK]) {
        material.envMap = envMap;
        material.envMapIntensity = 0.4;
        material.needsUpdate = true;
      }
    }
    const R = tree.get(bodyId).radius;
    const sampler = makeOceanSampler(bodyId, appearance);
    const { cap, capRough, detail } = makeGroundTextures(bodyId, longitude, R, sampler);

    // continent-scale curved terrain cap
    const capRings = [0, 400, 1000, 2000, 3500, 5500, 8000, 11000, 15000, 20000, 26000, 33000, 41000, 50000, 60000, 71000, 82000, 90000];
    const capMesh = new THREE.Mesh(
      makeCapGeometry(R, CAP_ARC, capRings, 96),
      new THREE.MeshStandardMaterial({
        map: cap,
        roughnessMap: capRough,
        roughness: 1,
        metalness: 0,
        transparent: true,
      }),
    );
    capMesh.renderOrder = 1; // explicit ground stacking: cap < detail < markings
    this.object.add(capMesh);

    // fine grass detail near the pad, floated just above the cap
    const detailRings = [0, 60, 140, 260, 420, 640, 920, 1260, 1660, 2080, 2500];
    const detailMesh = new THREE.Mesh(
      makeCapGeometry(R, DETAIL_ARC, detailRings, 64),
      new THREE.MeshStandardMaterial({ map: detail, roughness: 1, metalness: 0, transparent: true }),
    );
    detailMesh.position.z = 0.04;
    detailMesh.renderOrder = 2;
    this.object.add(detailMesh);

    // concrete apron: raised slab whose deck is exactly flush with the
    // vessel's spawn altitude (z = 0) so engine bells sit visibly on top of
    // it instead of being buried (the old pad deck stood ~1 m proud)
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(APRON_R + 1, APRON_R + 3.5, 0.9, 48), CONCRETE);
    slab.rotation.x = Math.PI / 2;
    slab.position.z = -0.45;
    this.object.add(slab);
    const markings = new THREE.Mesh(
      new THREE.CircleGeometry(APRON_R - 0.8, 48),
      new THREE.MeshStandardMaterial({ map: makeApronTexture(), roughness: 0.95, metalness: 0.02, transparent: true }),
    );
    markings.position.z = 0.05;
    markings.renderOrder = 3;
    this.object.add(markings);

    // hold-down clamps around the vehicle base
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.5, 1.15), STEEL);
      clamp.position.set(Math.cos(a) * 1.9, Math.sin(a) * 1.9, 0.55);
      clamp.rotation.z = a;
      this.object.add(clamp);
    }

    // umbilical tower on the apron, arms reaching toward the pad center
    const towerPos = new THREE.Vector3(-8, 22, 0);
    const padDir = towerPos.clone().multiplyScalar(-1).setZ(0).normalize();
    const tower = makeTower(padDir, towerPos.length() - 2.1);
    tower.position.copy(towerPos);
    this.object.add(tower);

    // lightning masts ring the pad
    for (const deg of [100, 220, 340]) {
      const a = (deg / 180) * Math.PI;
      const mast = makeLightningMast();
      mast.position.set(Math.cos(a) * 39, Math.sin(a) * 39, 0);
      this.object.add(mast);
    }

    this.object.add(makeCampus());

    // roads tie the campus to the pad
    this.object.add(road(44, 0, 135, 0, 7));
    const junction = new THREE.Mesh(new THREE.CircleGeometry(7, 24), ASPHALT);
    junction.position.set(135, 0, 0.155);
    this.object.add(junction);
    this.object.add(road(135, 0, 166, 35, 6));
    this.object.add(road(135, 0, 150, -37, 6));
    this.object.add(road(135, 0, 206, -25, 6));
    this.object.add(road(135, 0, 138, 50, 5));

    this.object.add(makeTrees(R, bodyNoiseSeed(bodyId)));
  }

  /** Pad surface point in sim-global f64 coordinates (rotates with the planet). */
  globalPosition(simTime: number): Vec3 {
    const body = this.tree.get(this.bodyId);
    const angle = this.tree.rotationAngle(this.bodyId, simTime) + this.longitude;
    const local = new Vec3(Math.cos(angle), Math.sin(angle), 0).scale(body.radius);
    return this.tree.globalState(this.bodyId, simTime).r.add(local);
  }

  /**
   * Full body-fixed orientation each frame: local X = east, Y = north,
   * Z = up. Unlike a bare radial alignment, this keeps the ground texture
   * from twisting relative to the planet as the body rotates — required for
   * the continent pattern to stay glued to the planet texture underneath.
   */
  updateOrientation(simTime: number): void {
    const angle = this.tree.rotationAngle(this.bodyId, simTime) + this.longitude;
    const up = simToRender(new Vec3(Math.cos(angle), Math.sin(angle), 0));
    const east = simToRender(new Vec3(-Math.sin(angle), Math.cos(angle), 0));
    const north = new THREE.Vector3().crossVectors(up, east);
    this.object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, north, up));
  }
}
