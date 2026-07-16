import * as THREE from 'three';
import { Vec3 } from '@sfs/sim';

/**
 * Camera-relative rendering: sim positions are f64 in root-frame meters, far
 * beyond f32 precision. Each frame every registered object is positioned at
 * (globalPos - cameraGlobalPos), subtracted in f64 *before* narrowing to f32,
 * and the camera itself stays at the Three.js origin.
 *
 * Also owns the sim→render frame mapping: sim is right-handed Z-up (orbital
 * convention), Three.js is right-handed Y-up.
 */
export function simToRender(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

interface Registration {
  object: THREE.Object3D;
  getGlobalPos: () => Vec3;
}

export class FloatingOrigin {
  private readonly entries: Registration[] = [];

  register(object: THREE.Object3D, getGlobalPos: () => Vec3): void {
    this.entries.push({ object, getGlobalPos });
  }

  /** Reposition all registered objects relative to the camera's global position. */
  update(cameraGlobalPos: Vec3): void {
    for (const { object, getGlobalPos } of this.entries) {
      const rel = getGlobalPos().sub(cameraGlobalPos); // f64 subtraction
      object.position.copy(simToRender(rel)); // narrows to f32 here
    }
  }
}
