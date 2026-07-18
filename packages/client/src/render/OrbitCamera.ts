import * as THREE from 'three';
import { Vec3 } from '@sfs/sim';
import { simToRender } from './FloatingOrigin.js';

/**
 * Touch/mouse orbit camera that tracks a focus point given in f64 sim-global
 * coordinates. It never moves the Three.js camera away from the origin —
 * instead it exposes its own global position for the FloatingOrigin pass and
 * only applies orientation to the camera.
 *
 * The orbit basis is the focus's *local* surface frame (up = away from the
 * SOI body center), so the default view is a horizon-level side view whether
 * the vessel is on the pad or in orbit.
 *
 * (Three's OrbitControls translates the camera, which would defeat
 * camera-relative rendering — hence this small custom implementation.)
 */
export class OrbitCamera {
  /** azimuth in the local horizon plane, rad */
  private theta = 0.45;
  /** elevation above the local horizon plane, rad */
  private phi = 0.12;
  /** distance from focus, m (f64) */
  private radius: number;

  private minRadius = 1;
  private readonly maxRadius = 1e11;

  private getFocusPos: () => Vec3 = () => Vec3.ZERO;
  private getBodyCenter: () => Vec3 = () => Vec3.ZERO;
  private getMinCenterDistance: () => number = () => 0;

  // pointer state (supports one-finger rotate, two-finger pinch)
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    element: HTMLElement,
    initialRadius: number,
  ) {
    this.radius = initialRadius;

    element.addEventListener('pointerdown', (e) => {
      element.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.lastPinchDist = this.pinchDistance();
    });
    element.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size === 1) {
        this.theta -= dx * 0.005;
        this.phi = clamp(this.phi + dy * 0.005, -1.45, 1.45);
      } else if (this.pointers.size === 2) {
        const dist = this.pinchDistance();
        if (this.lastPinchDist > 0) this.zoomBy(this.lastPinchDist / dist);
        this.lastPinchDist = dist;
      }
    });
    const release = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.lastPinchDist = 0;
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(Math.exp(e.deltaY * 0.001));
      },
      { passive: false },
    );
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private zoomBy(factor: number): void {
    this.radius = clamp(this.radius * factor, this.minRadius, this.maxRadius);
  }

  /**
   * Follow a moving focus; the body center defines the local "up" direction.
   * getMinCenterDistance (typically body radius + a few meters) keeps the
   * camera above the terrain so the player can't look under the world.
   */
  setFocus(
    getFocusPos: () => Vec3,
    minRadius: number,
    getBodyCenter: () => Vec3,
    getMinCenterDistance: () => number = () => 0,
  ): void {
    this.getFocusPos = getFocusPos;
    this.getBodyCenter = getBodyCenter;
    this.getMinCenterDistance = getMinCenterDistance;
    this.minRadius = minRadius;
    this.radius = clamp(this.radius, this.minRadius, this.maxRadius);
  }

  /** Local orthonormal basis at the focus: up (radial), east, north. */
  private basis(): { up: Vec3; east: Vec3; north: Vec3 } {
    const up = this.getFocusPos().sub(this.getBodyCenter()).normalized();
    const pole = Vec3.UNIT_Z;
    let east = pole.cross(up);
    if (east.lengthSq() < 1e-12) east = Vec3.UNIT_X; // focus over a pole
    east = east.normalized();
    const north = up.cross(east);
    return { up, east, north };
  }

  /** Camera position in f64 sim-global coordinates (input to FloatingOrigin). */
  globalPosition(): Vec3 {
    const { up, east, north } = this.basis();
    const cosPhi = Math.cos(this.phi);
    const offset = east
      .scale(cosPhi * Math.cos(this.theta))
      .add(north.scale(cosPhi * Math.sin(this.theta)))
      .add(up.scale(Math.sin(this.phi)))
      .scale(this.radius);
    const pos = this.getFocusPos().add(offset);

    // slide along the ground instead of sinking through it
    const minCenterDistance = this.getMinCenterDistance();
    if (minCenterDistance > 0) {
      const center = this.getBodyCenter();
      const radial = pos.sub(center);
      const distance = radial.length();
      if (distance < minCenterDistance) {
        return center.add(radial.scale(minCenterDistance / distance));
      }
    }
    return pos;
  }

  /** Orient the origin-pinned camera toward the focus. Call after FloatingOrigin.update. */
  updateOrientation(): void {
    const toFocus = this.getFocusPos().sub(this.globalPosition());
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(simToRender(this.basis().up));
    this.camera.lookAt(simToRender(toFocus));
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
