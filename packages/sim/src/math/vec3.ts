/**
 * Immutable-style f64 3-vector. All operations return new instances; the sim
 * allocates freely and relies on generational GC — profile before optimizing.
 * This type must stay free of Three.js so it can run on the server.
 */
export class Vec3 {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
  ) {}

  static readonly ZERO = new Vec3(0, 0, 0);
  static readonly UNIT_X = new Vec3(1, 0, 0);
  static readonly UNIT_Y = new Vec3(0, 1, 0);
  static readonly UNIT_Z = new Vec3(0, 0, 1);

  add(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  lengthSq(): number {
    return this.dot(this);
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalized(): Vec3 {
    const len = this.length();
    if (len === 0) return Vec3.ZERO;
    return this.scale(1 / len);
  }

  distanceTo(v: Vec3): number {
    return this.sub(v).length();
  }
}
