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
    // stack heights by iid — the flight model re-packs the (validated,
    // connected) stack into a column at local x=0 regardless of where the
    // builder grid placed it; x is kept so fins know which flank they're on
    const heights = new Map<number, { y0: number; x: number; def: PartDef }>();
    let y = 0;
    for (const part of stackOf(design)) {
      const def = catalog.get(part.part)!;
      heights.set(part.iid, { y0: y, x: part.x, def });
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

    // interstage shrouds: an engine or heat shield sitting directly on a
    // decoupler gets a solid fairing that belongs to the section *below*, so
    // it jettisons with the decoupler like a real interstage; heat-shield
    // covers are gold to match the builder art
    const stack = stackOf(design);
    for (let i = 1; i < stack.length; i++) {
      const covered = stack[i]!;
      const below = stack[i - 1]!;
      const coveredDef = catalog.get(covered.part)!;
      const belowDef = catalog.get(below.part)!;
      if (coveredDef.category !== 'engine' && coveredDef.category !== 'heatshield') continue;
      if (belowDef.category !== 'decoupler') continue;
      const radius = Math.max(coveredDef.shape.rBottom, belowDef.shape.rTop) + 0.06;
      const shroud = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, coveredDef.shape.height, 24, 1, true),
        new THREE.MeshStandardMaterial({
          color: coveredDef.category === 'heatshield' ? 0xe2c286 : 0xf2f4f7,
          roughness: 0.45,
          metalness: 0.25,
          side: THREE.DoubleSide,
          envMap: this.envMap ?? undefined,
          envMapIntensity: 0.35,
        }),
      );
      shroud.position.y = heights.get(covered.iid)!.y0 + coveredDef.shape.height / 2;
      this.sectionGroups[sectionIndexOf.get(below.iid)!]!.add(shroud);
    }

    // layered exhaust: white-hot core inside an orange sheath, both HDR so
    // they bloom; per-frame flicker happens in update(). Both cones are
    // translated so the apex sits at local y=0 — throttle scaling then
    // stretches the flame downward from the nozzle instead of detaching it.
    // renderOrder above the ground layers (1-3) and clouds (5): those are
    // transparent too and would otherwise paint over the non-depth-writing
    // plume whenever it's seen against them (i.e. viewed from above).
    const outerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    outerMaterial.color.setRGB(2.0, 1.3, 0.5);
    const outerGeometry = new THREE.ConeGeometry(0.55, 5, 16);
    outerGeometry.translate(0, -2.5, 0);
    this.plumeOuter = new THREE.Mesh(outerGeometry, outerMaterial);
    this.plumeOuter.renderOrder = 10;

    const innerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    innerMaterial.color.setRGB(2.8, 2.5, 1.9);
    const innerGeometry = new THREE.ConeGeometry(0.26, 3.4, 12);
    innerGeometry.translate(0, -1.7, 0);
    this.plumeInner = new THREE.Mesh(innerGeometry, innerMaterial);
    this.plumeInner.renderOrder = 10;

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
    // same as the plume: draw after the transparent ground/cloud layers
    this.plasma.renderOrder = 10;
    this.plasma.scale.set(2.2, Math.max(3, y * 0.8), 2.2);
    this.plasma.position.y = y / 2;
    this.plasma.visible = false;
    this.object.add(this.plasma);

    // parachute: white canopy with gore seams (matching the silver-white
    // builder art) plus suspension lines down to the stack top
    const canopyMaterial = new THREE.MeshStandardMaterial({
      map: makeCanopyTexture(),
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(4.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      canopyMaterial,
    );
    canopy.position.y = y + 9;
    const linePoints: THREE.Vector3[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      linePoints.push(new THREE.Vector3(Math.cos(a) * 4.4, y + 9, Math.sin(a) * 4.4));
      linePoints.push(new THREE.Vector3(0, y + 0.2, 0));
    }
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(linePoints),
      new THREE.LineBasicMaterial({ color: 0xcdd2d8, transparent: true, opacity: 0.85 }),
    );
    this.chute = new THREE.Group();
    this.chute.add(canopy);
    this.chute.add(lines);
    this.chute.visible = false;
    this.object.add(this.chute);
  }

  private readonly plasma: THREE.Mesh;
  private readonly chute: THREE.Group;
  private readonly topY: number;

  private partMesh(
    part: CraftPart,
    def: PartDef,
    heights: Map<number, { y0: number; x: number; def: PartDef }>,
  ): THREE.Object3D | null {
    const color = CATEGORY_COLORS[def.category] ?? 0x999999;
    // brushed-metal hull: a hint of sheen on the big bodywork, matte elsewhere
    const shiny = def.category === 'tank' || def.category === 'capsule' || def.category === 'nose';
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: shiny ? 0.48 : 0.6,
      metalness: shiny ? 0.55 : 0.35,
      envMap: this.envMap ?? undefined,
      envMapIntensity: 0.45,
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
    const host = heights.get(part.host ?? -1);
    if (!host) return null;
    const side = part.x >= host.x ? 1 : -1;
    const shape = new THREE.Shape();
    shape.moveTo(0, height);
    shape.lineTo(0, 0);
    shape.lineTo(rBottom, 0);
    shape.lineTo(rTop, height);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(side * host.def.shape.rBottom, host.y0, -0.03);
    if (side < 0) mesh.scale.x = -1;
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
      roughness: 0.52,
      metalness: 0.6,
      envMap: this.envMap ?? undefined,
      envMapIntensity: 0.5,
      side: THREE.DoubleSide,
    });

    // straight-sided cone from the exit up to the throat, matching the
    // builder's tall-triangle bell profile
    const throat = Math.max(0.06, rBottom * 0.3);
    const bellTop = h * 0.78;
    const profile = [
      new THREE.Vector2(rBottom * 0.85, 0),
      new THREE.Vector2(throat, bellTop),
      new THREE.Vector2(throat * 1.15, bellTop + h * 0.04),
    ];
    group.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 24), dark));

    // cooling ribs along the bell
    for (const f of [0.25, 0.5]) {
      const r = rBottom * 0.85 + (throat - rBottom * 0.85) * f;
      const rib = new THREE.Mesh(new THREE.TorusGeometry(r, 0.018, 6, 24), dark);
      rib.rotation.x = Math.PI / 2;
      rib.position.y = bellTop * f;
      group.add(rib);
    }

    // mount block mating with the part above
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rTop * 0.8, h * 0.22, 24), mountMaterial);
    mount.position.y = h * 0.89;
    group.add(mount);

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
    material.roughness = 0.5;
    material.metalness = 0.5;
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
      // apex tucked just inside the engine bell (throat sits ~0.7 up)
      this.plume.position.y = bottom + 0.45;
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

    this.chute.visible = vessel.chuteDeployed;
  }
}

/** White canopy with subtle alternating gore panels and an orange rim band. */
function makeCanopyTexture(): THREE.Texture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const gores = 12;
  for (let i = 0; i < gores; i++) {
    ctx.fillStyle = i % 2 ? '#f6f8fa' : '#e2e6eb';
    ctx.fillRect((i * w) / gores, 0, w / gores + 1, h);
  }
  // seam lines between gores
  ctx.strokeStyle = 'rgba(90, 98, 110, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= gores; i++) {
    ctx.beginPath();
    ctx.moveTo((i * w) / gores, 0);
    ctx.lineTo((i * w) / gores, h);
    ctx.stroke();
  }
  // orange marker band near the skirt (nod to the builder art stripe)
  ctx.fillStyle = 'rgba(212, 85, 47, 0.9)';
  ctx.fillRect(0, h * 0.8, w, h * 0.12);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}
