import * as THREE from 'three';
import { Vec3, type SystemTree } from '@sfs/sim';
import { simToRender } from './FloatingOrigin.js';
import { fbm, makeNoise3 } from './noise.js';

/** Grass/dirt ground disc texture with a concrete apron + scorch ring at center. */
function makeGroundTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const noise = makeNoise3(6011);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // radial coordinate: 0 at pad center, 1 at the disc rim
      const dx = (px - size / 2) / (size / 2);
      const dy = (py - size / 2) / (size / 2);
      const r = Math.sqrt(dx * dx + dy * dy);

      const n = fbm(noise, px / 38, py / 38, 0.5, 4);
      const patch = fbm(noise, px / 90 + 40, py / 90, 0.5, 3);

      // grass with dry patches
      let rr = 66 + n * 26 + Math.max(0, patch - 0.55) * 70;
      let gg = 96 + n * 30 + Math.max(0, patch - 0.55) * 40;
      let bb = 56 + n * 18;

      // concrete apron around the pad (~4% of the disc = ~120 m)
      if (r < 0.045) {
        const c = 118 + n * 26;
        rr = c;
        gg = c + 2;
        bb = c + 6;
      }
      // scorched blast ring just outside the apron
      const scorch = Math.max(0, 1 - Math.abs(r - 0.055) / 0.025) * (0.5 + n * 0.5);
      rr = rr * (1 - scorch * 0.75);
      gg = gg * (1 - scorch * 0.8);
      bb = bb * (1 - scorch * 0.8);

      const idx = (py * size + px) * 4;
      image.data[idx] = rr;
      image.data[idx + 1] = gg;
      image.data[idx + 2] = bb;
      // feather the rim so the disc blends into the planet texture
      image.data[idx + 3] = r > 0.88 ? Math.max(0, 1 - (r - 0.88) / 0.12) * 255 : 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Local ground detail at the launch site. The planet sphere's polygon surface
 * deviates from the true radius by hundreds of meters at 600 km scale, so a
 * flat tangent disc at the exact surface radius hides the gap up close
 * (terrain LOD is deferred post-M6, plan §4.3).
 */
export class LaunchSite {
  readonly object = new THREE.Group();

  constructor(
    private readonly tree: SystemTree,
    private readonly bodyId: string,
    private readonly longitude: number,
  ) {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(3_000, 48),
      new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1, transparent: true }),
    );
    // CircleGeometry faces +Z; group's +Z is oriented radially outward
    this.object.add(ground);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 16, 2, 24),
      new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.9, metalness: 0.1 }),
    );
    pad.rotation.x = Math.PI / 2; // cylinder axis onto the group's radial +Z
    pad.position.z = 0.05; // pad deck sits ~1 m proud of the disc
    this.object.add(pad);

    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(3, 3, 28),
      new THREE.MeshStandardMaterial({ color: 0x8a2f2a, roughness: 0.8 }),
    );
    tower.position.set(-8, 24, 14); // tangent offset, clear of the default camera axis
    this.object.add(tower);

    // support buildings scattered on the apron edge
    const buildingMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.85 });
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x5f6670, roughness: 0.9 });
    for (const [bx, by, bw, bd, bh] of [
      [70, -40, 22, 14, 9],
      [95, 10, 14, 12, 6],
      [60, 55, 10, 18, 7],
    ] as const) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bd, bh), buildingMaterial);
      box.position.set(bx, by, bh / 2);
      this.object.add(box);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(bw + 1.5, bd + 1.5, 0.7), roofMaterial);
      roof.position.set(bx, by, bh + 0.35);
      this.object.add(roof);
    }
  }

  /** Pad surface point in sim-global f64 coordinates (rotates with the planet). */
  globalPosition(simTime: number): Vec3 {
    const body = this.tree.get(this.bodyId);
    const angle = this.tree.rotationAngle(this.bodyId, simTime) + this.longitude;
    const local = new Vec3(Math.cos(angle), Math.sin(angle), 0).scale(body.radius);
    return this.tree.globalState(this.bodyId, simTime).r.add(local);
  }

  /** Orient the disc tangent to the (rotating) surface each frame. */
  updateOrientation(simTime: number): void {
    const body = this.tree.get(this.bodyId);
    const angle = this.tree.rotationAngle(this.bodyId, simTime) + this.longitude;
    const radialSim = new Vec3(Math.cos(angle), Math.sin(angle), 0);
    const radial = simToRender(radialSim);
    this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), radial);
  }
}
