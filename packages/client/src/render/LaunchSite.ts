import * as THREE from 'three';
import { Vec3, type SystemTree } from '@sfs/sim';
import { simToRender } from './FloatingOrigin.js';

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
      new THREE.MeshStandardMaterial({ color: 0x4a6b42, roughness: 1 }),
    );
    // CircleGeometry faces +Z; group's +Z is oriented radially outward
    this.object.add(ground);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 16, 2, 24),
      new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.9 }),
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
