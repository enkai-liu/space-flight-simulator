import * as THREE from 'three';
import {
  craftSections,
  stackOf,
  isStackPart,
  type CraftDesign,
  type CraftPart,
  type PartDef,
  type Vessel,
} from '@sfs/sim';

/** Category colors matching the builder silhouettes. */
const CATEGORY_COLORS: Record<string, number> = {
  capsule: 0xaab4c4,
  tank: 0xc8ccd4,
  engine: 0x8a8f98,
  decoupler: 0xa8853f,
  fin: 0x7d8aa0,
  nose: 0x9aa4b4,
  parachute: 0xb0563c,
};

/**
 * Procedural 3D rocket built from the craft design's part shapes (truncated
 * cones + fin wedges), organized one group per staging section so jettisoned
 * stages disappear with their section. Local +Y is the long axis.
 */
export class VesselRenderer {
  readonly object = new THREE.Group();
  private readonly sectionGroups: THREE.Group[] = [];
  private readonly sectionBottoms: number[] = [];
  private readonly plume: THREE.Mesh;
  private totalSections: number;

  constructor(design: CraftDesign, catalog: Map<string, PartDef>) {
    // stack heights by iid
    const heights = new Map<number, { y0: number; def: PartDef }>();
    let y = 0;
    for (const part of stackOf(design)) {
      const def = catalog.get(part.part)!;
      heights.set(part.iid, { y0: y, def });
      y += def.shape.height;
    }

    const sections = craftSections(design, catalog);
    this.totalSections = sections.length;
    for (const section of sections) {
      const group = new THREE.Group();
      let bottom = Infinity;
      for (const part of section) {
        const mesh = this.partMesh(part, catalog.get(part.part)!, heights);
        if (mesh) group.add(mesh);
        if (isStackPart(part)) bottom = Math.min(bottom, heights.get(part.iid)!.y0);
      }
      this.sectionBottoms.push(bottom === Infinity ? 0 : bottom);
      this.sectionGroups.push(group);
      this.object.add(group);
    }

    const plumeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffa53d,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.plume = new THREE.Mesh(new THREE.ConeGeometry(0.55, 5, 16), plumeMaterial);
    this.plume.visible = false;
    this.object.add(this.plume);

    this.topY = y;

    // re-entry plasma shroud (opacity driven by skin heat)
    this.plasma = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0xff7838,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.plasma.scale.set(2.2, Math.max(3, y * 0.8), 2.2);
    this.plasma.position.y = y / 2;
    this.plasma.visible = false;
    this.object.add(this.plasma);

    // parachute canopy
    const canopyMaterial = new THREE.MeshStandardMaterial({
      color: 0xd4552f,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    this.canopy = new THREE.Mesh(
      new THREE.SphereGeometry(4.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      canopyMaterial,
    );
    this.canopy.visible = false;
    this.object.add(this.canopy);
  }

  private readonly plasma: THREE.Mesh;
  private readonly canopy: THREE.Mesh;
  private readonly topY: number;

  private partMesh(
    part: CraftPart,
    def: PartDef,
    heights: Map<number, { y0: number; def: PartDef }>,
  ): THREE.Mesh | null {
    const color = CATEGORY_COLORS[def.category] ?? 0x999999;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 });
    const { rTop, rBottom, height } = def.shape;

    if (isStackPart(part)) {
      const geometry = new THREE.CylinderGeometry(Math.max(rTop, 0.02), rBottom, height, 24);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = heights.get(part.iid)!.y0 + height / 2;
      return mesh;
    }

    // fin: thin wedge on the host's flank
    const host = heights.get(part.y);
    if (!host) return null;
    const shape = new THREE.Shape();
    shape.moveTo(0, height);
    shape.lineTo(0, 0);
    shape.lineTo(rBottom, 0);
    shape.lineTo(rTop, height);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(part.x * host.def.shape.rBottom, host.y0, -0.03);
    if (part.x < 0) mesh.scale.x = -1;
    return mesh;
  }

  /** Sync with sim state: hide jettisoned sections, aim the plume. */
  update(vessel: Vessel): void {
    const gone = this.totalSections - vessel.stages.length;
    for (let i = 0; i < this.totalSections; i++) {
      this.sectionGroups[i]!.visible = i >= gone;
    }

    const dir = new THREE.Vector3(Math.cos(vessel.heading), 0, -Math.sin(vessel.heading));
    this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    const thrusting = vessel.currentThrust() > 0;
    this.plume.visible = thrusting;
    if (thrusting) {
      const bottom = this.sectionBottoms[gone] ?? 0;
      this.plume.position.y = bottom - 2.2;
      this.plume.scale.set(1, 0.5 + vessel.throttle, 1);
    }

    // plasma fades in as the skin heats past ~15% of tolerance
    const heatFrac = vessel.heat / vessel.maxHeat();
    const plasmaStrength = Math.min(1, Math.max(0, (heatFrac - 0.15) / 0.6));
    this.plasma.visible = plasmaStrength > 0;
    (this.plasma.material as THREE.MeshBasicMaterial).opacity = plasmaStrength * 0.65;

    this.canopy.visible = vessel.chuteDeployed;
    if (vessel.chuteDeployed) this.canopy.position.y = this.topY + 9;
  }
}
