import * as THREE from 'three';
import type { Vec3 } from '@sfs/sim';
import { simToRender } from './FloatingOrigin.js';

const MAX_POINTS = 256;
/** sim seconds between samples */
const SAMPLE_INTERVAL = 0.5;
/** a gap this large means a warp jump — restart the trail */
const RESET_GAP = 30;

/**
 * Glowing breadcrumb line behind the own vessel. Positions are kept in f64
 * global coordinates and re-projected relative to the camera every frame —
 * do NOT register with FloatingOrigin (its per-object offset can't bend a
 * line's vertices).
 */
export class Trail {
  readonly object: THREE.Line;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly points: Vec3[] = [];
  private lastSampleAt = -Infinity;

  constructor() {
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3),
    );
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3),
    );
    this.object = new THREE.Line(
      this.geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.object.frustumCulled = false;
  }

  update(globalPos: Vec3, cameraGlobal: Vec3, simTime: number): void {
    if (simTime - this.lastSampleAt >= SAMPLE_INTERVAL) {
      if (this.points.length > 0 && simTime - this.lastSampleAt > RESET_GAP) {
        this.points.length = 0;
      }
      this.points.push(globalPos);
      if (this.points.length > MAX_POINTS) this.points.shift();
      this.lastSampleAt = simTime;
    }

    const position = this.geometry.attributes.position as THREE.BufferAttribute;
    const color = this.geometry.attributes.color as THREE.BufferAttribute;
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const rel = simToRender(this.points[i]!.sub(cameraGlobal));
      position.setXYZ(i, rel.x, rel.y, rel.z);
      // additive fade-to-black reads as fade-out; newest points glow cyan
      const age = n > 1 ? i / (n - 1) : 1;
      const f = age * age * 0.85;
      color.setXYZ(i, 0.35 * f, 0.75 * f, 1.0 * f);
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }
}
