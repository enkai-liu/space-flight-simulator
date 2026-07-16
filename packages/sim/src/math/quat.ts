import { Vec3 } from './vec3.js';

/** Immutable f64 quaternion (x, y, z, w). */
export class Quat {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
    public readonly w: number,
  ) {}

  static readonly IDENTITY = new Quat(0, 0, 0, 1);

  static fromAxisAngle(axis: Vec3, angle: number): Quat {
    const half = angle / 2;
    const s = Math.sin(half);
    const a = axis.normalized();
    return new Quat(a.x * s, a.y * s, a.z * s, Math.cos(half));
  }

  mul(q: Quat): Quat {
    return new Quat(
      this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y,
      this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x,
      this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w,
      this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z,
    );
  }

  conjugate(): Quat {
    return new Quat(-this.x, -this.y, -this.z, this.w);
  }

  normalized(): Quat {
    const len = Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2 + this.w ** 2);
    return new Quat(this.x / len, this.y / len, this.z / len, this.w / len);
  }

  rotate(v: Vec3): Vec3 {
    // v' = q * (v, 0) * q⁻¹, expanded to avoid constructing intermediate quats
    const qv = new Vec3(this.x, this.y, this.z);
    const uv = qv.cross(v);
    const uuv = qv.cross(uv);
    return v.add(uv.scale(2 * this.w)).add(uuv.scale(2));
  }
}
