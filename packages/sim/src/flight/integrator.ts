import { Vec3 } from '../math/vec3.js';

export interface BodyState {
  r: Vec3;
  v: Vec3;
}

export type AccelerationFn = (r: Vec3, v: Vec3) => Vec3;

/**
 * One classical RK4 step of r'' = a(r, v) at fixed dt.
 *
 * RK4 is not symplectic, but off-rails phases last minutes (thrust/atmosphere)
 * — long-term propagation is analytic on rails, so drift never accumulates.
 */
export function rk4Step(state: BodyState, dt: number, accel: AccelerationFn): BodyState {
  const { r, v } = state;

  const a1 = accel(r, v);
  const r2 = r.add(v.scale(dt / 2));
  const v2 = v.add(a1.scale(dt / 2));

  const a2 = accel(r2, v2);
  const r3 = r.add(v2.scale(dt / 2));
  const v3 = v.add(a2.scale(dt / 2));

  const a3 = accel(r3, v3);
  const r4 = r.add(v3.scale(dt));
  const v4 = v.add(a3.scale(dt));

  const a4 = accel(r4, v4);

  return {
    r: r.add(v.add(v2.scale(2)).add(v3.scale(2)).add(v4).scale(dt / 6)),
    v: v.add(a1.add(a2.scale(2)).add(a3.scale(2)).add(a4).scale(dt / 6)),
  };
}
