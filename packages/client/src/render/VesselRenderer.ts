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
  heatshield: 0xc9a45c,
};

/** Dark nozzle metal matching the builder's engine detail art. */
const NOZZLE_COLOR = 0x3a3d42;

/**
 * Procedural 3D rocket built from the craft design's part shapes (truncated
 * cones + fin wedges), organized one group per staging section so jettisoned
 * stages disappear with their section. Local +Y is the long axis.
 */
export class VesselRenderer {
  readonly object = new THREE.Group();
  private readonly sectionGroups: THREE.Group[] = [];
  private readonly sectionBottoms: number[] = [];
  private readonly plume: THREE.Group;
  private readonly plumeOuter: THREE.Mesh;
  private readonly plumeInner: THREE.Mesh;
  private readonly engineLight: THREE.PointLight;
  private readonly envMap: THREE.Texture | null;

  private totalSections: number;

  constructor(design: CraftDesign, catalog: Map<string, PartDef>, envMap?: THREE.Texture) {
    this.envMap = envMap ?? null;
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
    const sectionIndexOf = new Map<number, number>();
    for (const [index, section] of sections.entries()) {
      const group = new THREE.Group();
      let bottom = Infinity;
      for (const part of section) {
        sectionIndexOf.set(part.iid, index);
        const mesh = this.partMesh(part, catalog.get(part.part)!, heights);
        if (mesh) group.add(mesh);
        if (isStackPart(part)) bottom = Math.min(bottom, heights.get(part.iid)!.y0);
      }
      this.sectionBottoms.push(bottom === Infinity ? 0 : bottom);
      this.sectionGroups.push(group);
      this.object.add(group);
    }

    // interstage shrouds: an engine sitting directly on a decoupler gets a
    // translucent fairing that belongs to the section *below*, so it
    // jettisons with the decoupler like a real interstage
    const stack = stackOf(design);
    for (let i = 1; i < stack.length; i++) {
      const engine = stack[i]!;
      const below = stack[i - 1]!;
      const engineDef = catalog.get(engine.part)!;
      const belowDef = catalog.get(below.part)!;
      if (engineDef.category !== 'engine' || belowDef.category !== 'decoupler') continue;
      const radius = Math.max(engineDef.shape.rBottom, belowDef.shape.rTop) + 0.06;
      const shroud = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, engineDef.shape.height, 24, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0xf2f4f7,
          transparent: true,
          opacity: 0.45,
          roughness: 0.35,
          metalness: 0.3,
          side: THREE.DoubleSide,
          depthWrite: false,
          envMap: this.envMap ?? undefined,
          envMapIntensity: 0.6,
        }),
      );
      shroud.position.y = heights.get(engine.iid)!.y0 + engineDef.shape.height / 2;
      this.sectionGroups[sectionIndexOf.get(below.iid)!]!.add(shroud);
    }

    // layered exhaust: white-hot core inside an orange sheath, both HDR so
    // they bloom; per-frame flicker happens in update()
    const outerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    outerMaterial.color.setRGB(2.0, 1.3, 0.5);
    this.plumeOuter = new THREE.Mesh(new THREE.ConeGeometry(0.55, 5, 16), outerMaterial);

    const innerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    innerMaterial.color.setRGB(2.8, 2.5, 1.9);
    this.plumeInner = new THREE.Mesh(new THREE.ConeGeometry(0.26, 3.4, 12), innerMaterial);
    this.plumeInner.position.y = 0.8;

    this.plume = new THREE.Group();
    this.plume.add(this.plumeOuter);
    this.plume.add(this.plumeInner);
    this.plume.visible = false;
    this.object.add(this.plume);

    // warm light cast on the pad and the hull while thrusting
    this.engineLight = new THREE.PointLight(0xffa040, 0, 80, 1.8);
    this.engineLight.visible = false;
    this.object.add(this.engineLight);

    this.topY = y;

    // re-entry plasma shroud (opacity driven by skin heat)
    const plasmaMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // HDR so the re-entry shroud blooms once heat builds
    plasmaMaterial.color.setRGB(2.2, 1.0, 0.45);
    this.plasma = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), plasmaMaterial);
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
  ): THREE.Object3D | null {
    const color = CATEGORY_COLORS[def.category] ?? 0x999999;
    // polished metal hull for the big bodywork, duller finish elsewhere
    const shiny = def.category === 'tank' || def.category === 'capsule' || def.category === 'nose';
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: shiny ? 0.32 : 0.5,
      metalness: shiny ? 0.8 : 0.45,
      envMap: this.envMap ?? undefined,
      envMapIntensity: 0.9,
    });
    const { rTop, rBottom, height } = def.shape;

    if (isStackPart(part)) {
      if (def.category === 'engine') {
        const group = this.engineMesh(def, material);
        group.position.y = heights.get(part.iid)!.y0;
        return group;
      }
      if (def.category === 'heatshield') {
        const mesh = this.heatshieldMesh(def, material);
        mesh.position.y = heights.get(part.iid)!.y0;
        return mesh;
      }
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

  /**
   * Engine as a proper bell: dark ribbed nozzle lathe flaring to rBottom,
   * with the category-gray mount and a turbopump housing above the throat.
   * Local y=0 is the bell lip (part bottom).
   */
  private engineMesh(def: PartDef, mountMaterial: THREE.MeshStandardMaterial): THREE.Group {
    const { rTop, rBottom, height: h } = def.shape;
    const group = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({
      color: NOZZLE_COLOR,
      roughness: 0.42,
      metalness: 0.75,
      envMap: this.envMap ?? undefined,
      envMapIntensity: 0.9,
      side: THREE.DoubleSide,
    });

    const throat = Math.max(0.06, rBottom * 0.3);
    const profile = [
      new THREE.Vector2(rBottom, 0),
      new THREE.Vector2(rBottom * 0.86, h * 0.14),
      new THREE.Vector2(rBottom * 0.62, h * 0.3),
      new THREE.Vector2(rBottom * 0.42, h * 0.42),
      new THREE.Vector2(throat, h * 0.52),
      new THREE.Vector2(throat * 1.2, h * 0.6),
    ];
    group.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 24), dark));

    // cooling ribs along the bell
    for (const p of [profile[1]!, profile[2]!]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(p.x, 0.018, 6, 24), dark);
      rib.rotation.x = Math.PI / 2;
      rib.position.y = p.y;
      group.add(rib);
    }

    // mount block mating with the part above
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rTop * 0.8, h * 0.45, 24), mountMaterial);
    mount.position.y = h * 0.775;
    group.add(mount);

    // turbopump machinery tucked beside the throat
    const pump = new THREE.Mesh(new THREE.CylinderGeometry(rBottom * 0.16, rBottom * 0.16, h * 0.3, 12), dark);
    pump.position.set(rBottom * 0.42, h * 0.6, 0);
    group.add(pump);

    return group;
  }

  /**
   * Heat shield: shallow gold dome, ablative face down, closed on top where
   * it mates with the capsule. Local y=0 is the dome's lowest point.
   */
  private heatshieldMesh(def: PartDef, material: THREE.MeshStandardMaterial): THREE.Mesh {
    const { rTop, rBottom, height: h } = def.shape;
    const profile = [
      new THREE.Vector2(0.02, 0),
      new THREE.Vector2(rBottom * 0.45, h * 0.12),
      new THREE.Vector2(rBottom * 0.78, h * 0.4),
      new THREE.Vector2(rBottom, h * 0.85),
      new THREE.Vector2(rTop, h),
      new THREE.Vector2(0.01, h),
    ];
    material.roughness = 0.38;
    material.metalness = 0.7;
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), material);
    mesh.material.side = THREE.DoubleSide;
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
    this.engineLight.visible = thrusting;
    if (thrusting) {
      const bottom = this.sectionBottoms[gone] ?? 0;
      const flicker = 0.92 + Math.random() * 0.16;
      this.plume.position.y = bottom - 2.2;
      this.plume.scale.set(1, (0.5 + vessel.throttle) * flicker, 1);
      (this.plumeOuter.material as THREE.MeshBasicMaterial).opacity = 0.72 + Math.random() * 0.18;
      this.engineLight.position.y = bottom - 1.2;
      this.engineLight.intensity = (26 + 60 * vessel.throttle) * flicker;
    } else {
      this.engineLight.intensity = 0;
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
