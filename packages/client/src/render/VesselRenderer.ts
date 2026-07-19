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
  private readonly plumeMaterial: THREE.ShaderMaterial;
  private readonly fireball: THREE.Mesh;
  private readonly fireballMaterial: THREE.ShaderMaterial;
  private readonly sectionPlumeR: number[] = [];
  private plumeThrottle = 0;
  private lastPlumeAt = performance.now() / 1000;
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
      let bottomDef: PartDef | null = null;
      for (const part of section) {
        sectionIndexOf.set(part.iid, index);
        const def = catalog.get(part.part)!;
        const mesh = this.partMesh(part, def, heights);
        if (mesh) group.add(mesh);
        if (isStackPart(part) && heights.get(part.iid)!.y0 < bottom) {
          bottom = heights.get(part.iid)!.y0;
          bottomDef = def;
        }
      }
      this.sectionBottoms.push(bottom === Infinity ? 0 : bottom);
      // plume width follows the bell exit of whatever engine fires this stage
      this.sectionPlumeR.push(
        bottomDef?.category === 'engine' ? bottomDef.shape.rBottom * 0.72 : 0.42,
      );
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

    // shader-driven exhaust plume: one lathe mesh whose profile bulges just
    // past the nozzle (underexpanded jet) then tapers to a wispy tail. The
    // shader fades the silhouette edges by view angle so it reads as a soft
    // volume, whitens the core, adds shock diamonds near the throat, scrolls
    // turbulence noise downstream, and animates all flicker with smooth
    // sums of sines on uTime — no per-frame Math.random(), so no jitter.
    // Colors are HDR so the plume blooms. The nozzle sits at local y=0 and
    // the flame extends -y; uLen stretches it downward, keeping it attached.
    // renderOrder above the ground layers (1-3) and clouds (5): those are
    // transparent too and would otherwise paint over the non-depth-writing
    // plume whenever it's seen against them (i.e. viewed from above).
    this.plumeMaterial = makePlumeMaterial();
    const plumeMesh = new THREE.Mesh(makePlumeGeometry(), this.plumeMaterial);
    plumeMesh.renderOrder = 10;
    plumeMesh.frustumCulled = false;

    this.plume = new THREE.Group();
    this.plume.add(plumeMesh);
    this.plume.visible = false;
    this.object.add(this.plume);

    // ignition fireball: a dedicated glowing dome at the ground plane,
    // sized by how much of the jet the ground clips away. The clipped-cone
    // splash alone can't do this job: it is a zero-thickness sheet with the
    // cone's stale normals and washed-out core colors, and any attempt to
    // curl it upward parks it inside the hull where the depth test culls it.
    this.fireballMaterial = makeFireballMaterial();
    this.fireball = new THREE.Mesh(makeFireballGeometry(), this.fireballMaterial);
    this.fireball.renderOrder = 10;
    this.fireball.frustumCulled = false;
    this.fireball.visible = false;
    this.object.add(this.fireball);

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

  /**
   * Sync with sim state: hide jettisoned sections, aim the plume.
   * `groundClearance` is the vessel origin's height above the local surface;
   * it drives the pad-splash deflection and keeps the engine light above
   * ground. Callers that don't know it (map view, tests) get no splash.
   */
  update(vessel: Vessel, groundClearance = Infinity): void {
    const gone = this.totalSections - vessel.stages.length;
    for (let i = 0; i < this.totalSections; i++) {
      this.sectionGroups[i]!.visible = i >= gone;
    }

    const dir = new THREE.Vector3(Math.cos(vessel.heading), 0, -Math.sin(vessel.heading));
    this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    const thrusting = vessel.currentThrust() > 0;
    this.plume.visible = thrusting;
    this.engineLight.visible = thrusting;
    const now = performance.now() / 1000;
    const dt = Math.min(Math.max(now - this.lastPlumeAt, 0), 0.1);
    this.lastPlumeAt = now;
    if (thrusting) {
      const bottom = this.sectionBottoms[gone] ?? 0;
      // ease the plume toward the commanded throttle so length changes
      // ramp instead of snapping; flicker lives in the shader on uTime
      this.plumeThrottle += (vessel.throttle - this.plumeThrottle) * Math.min(1, dt * 8);
      const r = this.sectionPlumeR[gone] ?? 0.42;
      // exhaust emerges from just inside the engine bell
      this.plume.position.y = bottom + 0.45;
      this.plume.scale.set(r, 1, r);
      const u = this.plumeMaterial.uniforms;
      u.uTime!.value = now;
      u.uThrottle!.value = this.plumeThrottle;
      u.uLen!.value = 0.45 + 0.75 * this.plumeThrottle;
      // distance from the plume origin down to the ground along the flame:
      // past this the jet is clipped and splashed sideways by the shader.
      // The small bias lifts the splash sheet off the pad so it isn't
      // depth-rejected against the coplanar slab.
      const clearance = Number.isFinite(groundClearance)
        ? Math.max(groundClearance + bottom + 0.45 - 0.08, 0.05)
        : 1e6;
      u.uClear!.value = clearance;
      // ignition fireball at the ground plane, sized by the clipped flame
      const flameLen = 6 * (0.45 + 0.75 * this.plumeThrottle);
      const over = Math.min(Math.max(flameLen - clearance, 0), 2.5);
      this.fireball.visible = over > 0.05;
      if (this.fireball.visible) {
        const worldR = (0.5 + over * (0.28 + 0.16 * over)) * r * 2.2;
        this.fireball.position.y = bottom + 0.45 - clearance + 0.06;
        this.fireball.scale.set(worldR, worldR, worldR);
        const fu = this.fireballMaterial.uniforms;
        fu.uTime!.value = now;
        fu.uStrength!.value = Math.min(1, over / 1.0) * (0.5 + 0.5 * this.plumeThrottle);
      }
      // engine vibration: a subtle whole-body buzz scaled by power. Pure
      // translation — a rotational wobble would pivot at the object origin
      // (the stack bottom) and whip the nose around while the bell stays
      // planted. Safe to add here every frame: FloatingOrigin re-copies the
      // position before this runs, so nothing accumulates.
      const shake = this.plumeThrottle;
      this.object.position.x +=
        0.022 * shake * (Math.sin(now * 61.0) + 0.5 * Math.sin(now * 43.7 + 1.3));
      this.object.position.y += 0.016 * shake * Math.sin(now * 73.3 + 0.7);
      this.object.position.z +=
        0.022 * shake * (Math.cos(now * 57.1 + 1.9) + 0.5 * Math.sin(now * 49.3 + 0.4));
      // engine light crackles smoothly in sync with the flame; clamp it above
      // the ground so an igniting engine lights the pad instead of the dirt
      // underneath it
      const flicker =
        1 +
        0.09 * Math.sin(now * 37.0) +
        0.06 * Math.sin(now * 23.7 + 1.2) +
        0.05 * Math.sin(now * 61.3 + 0.6);
      const lightDrop = Number.isFinite(groundClearance)
        ? Math.min(1.2, Math.max(bottom + groundClearance - 0.15, 0.05))
        : 1.2;
      this.engineLight.position.y = bottom - lightDrop;
      this.engineLight.intensity = (26 + 60 * this.plumeThrottle) * flicker;
    } else {
      this.plumeThrottle = 0;
      this.engineLight.intensity = 0;
      this.fireball.visible = false;
    }

    // plasma fades in as the skin heats past ~15% of tolerance
    const heatFrac = vessel.heat / vessel.maxHeat();
    const plasmaStrength = Math.min(1, Math.max(0, (heatFrac - 0.15) / 0.6));
    this.plasma.visible = plasmaStrength > 0;
    (this.plasma.material as THREE.MeshBasicMaterial).opacity = plasmaStrength * 0.65;

    this.chute.visible = vessel.chuteDeployed;
  }
}

/**
 * Plume surface of revolution in normalized units: nozzle-exit radius 1 at
 * y=0, bulging ~12% shortly downstream, tapering concavely to a point at
 * y=-6. uv.y runs 0 (nozzle) → 1 (tail) for the shader's axial coordinate.
 */
function makePlumeGeometry(): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const segments = 48;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // narrow neck over the first ~0.45 units: that stretch sits up inside
    // the engine bell (whose interior tapers to the throat), so the jet must
    // stay skinnier than the bell walls until it clears the lip, then flare
    // into the underexpanded bulge
    const s = Math.min(t / 0.1, 1);
    const neck = 0.32 + 0.68 * s * s * (3 - 2 * s);
    const r = (0.98 + 2.2 * t) * Math.pow(1 - t, 1.1) * neck;
    // keep the tip ring non-degenerate: a zero-radius ring interpolates
    // zero-length normals, and normalize(0) NaNs poison the bloom pass
    points.push(new THREE.Vector2(Math.max(r, 0.02), -t * 6));
  }
  return new THREE.LatheGeometry(points, 32);
}

/**
 * Additive HDR plume shader. Vertex: stretches the flame by uLen with a
 * smooth "breathing" modulation and wafts the tail sideways, both driven by
 * sine sums on uTime (continuous, unlike per-frame randomness). Fragment:
 * silhouette edges fade by view angle so the single mesh reads as a soft
 * gas volume, the core whitens where the surface faces the camera, shock
 * diamonds pulse near the throat, and value noise scrolls downstream.
 */
function makePlumeMaterial(): THREE.ShaderMaterial {
  // normal (not additive) blending: an additive flame washes out against
  // bright backgrounds like the daylit pad; alpha blending keeps contrast
  // everywhere and the HDR colors still trigger bloom.
  // The renderer uses a logarithmic depth buffer (far plane 1e13), which
  // three.js only wires into built-in materials — a raw ShaderMaterial must
  // include the logdepthbuf chunks itself or its fragments carry z/w depth
  // (~1.0 at any distance) and lose the depth test against everything,
  // leaving the flame visible only against empty sky. <common> is required
  // for isPerspectiveMatrix() used by logdepthbuf_vertex.
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 1 },
      uLen: { value: 1 },
      uClear: { value: 1e6 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uTime;
      uniform float uLen;
      uniform float uClear;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vAxis;
      varying float vSplash;

      void main() {
        vUv = uv;
        float t = uv.y;
        vec3 p = position;
        // the first NECK units sit inside the engine bell and stay rigid;
        // only the free jet past the lip stretches with throttle and
        // breathes, so no throttle setting pulls the wide bulge up into
        // (and through) the nozzle walls
        float NECK = 0.45;
        float breathe = 1.0
          + 0.09 * sin(uTime * 37.0)
          + 0.055 * sin(uTime * 23.7 + 1.7)
          + 0.04 * sin(uTime * 61.3 + 0.9);
        float d = -p.y;
        float stretch = (6.0 * uLen * breathe - NECK) / (6.0 - NECK);
        d = d <= NECK ? d : NECK + (d - NECK) * stretch;
        // pad deflection: anything past the ground plane is clipped there
        // and splashed sideways into a thin ground sheet (the volumetric
        // look comes from the separate ignition-fireball dome). No upward
        // curl: lifting the rim parks it inside the engine bell and hull,
        // where the opaque rocket geometry depth-culls it.
        float over = min(max(d - uClear, 0.0), 2.5);
        d = min(d, uClear);
        p.y = -d;
        // absolute outward push, NOT a multiple of the local cone radius:
        // at ignition the clip lands in the skinny neck, where any
        // multiplicative spread stays clamp-sized and invisible behind the
        // hold-down clamps — additive spread guarantees a full-size
        // fireball no matter where the cone gets cut. The quadratic term
        // makes deep clips (engine at the pad) flare disproportionately
        // wider than shallow ones (already climbing). x/z are in bell-radius
        // units (world scale ~0.45), so full clip lands a ~1.7-unit world
        // rim radius.
        vec2 radial = p.xz;
        float rlen = length(radial);
        vec2 rdir = rlen > 1e-5 ? radial / rlen : vec2(1.0, 0.0);
        p.xz = rdir * (rlen + over * (0.5 + 0.35 * over));
        vSplash = over;
        // ragged silhouette: fast radial ripples racing downstream, gated
        // off the neck so the in-bell stretch keeps its clearance
        float ripple = sin(uTime * 31.0 + t * 26.0) * 0.6
          + sin(uTime * 47.3 + t * 15.0 + 2.1) * 0.4;
        float rippleGate = 0.10 * smoothstep(0.08, 0.35, t);
        p.x *= 1.0 + ripple * rippleGate;
        p.z *= 1.0 + ripple * rippleGate;
        float sway = t * t;
        p.x += (sin(uTime * 11.0 + t * 9.0) * 0.6 + sin(uTime * 19.6 + t * 5.0) * 0.4) * 0.55 * sway;
        p.z += (cos(uTime * 12.7 + t * 7.0) * 0.6 + cos(uTime * 17.1 + t * 4.0) * 0.4) * 0.55 * sway;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNormal = normalMatrix * normal;
        vViewDir = -mv.xyz;
        vAxis = (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime;
      uniform float uThrottle;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vAxis;
      varying float vSplash;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      void main() {
        #include <logdepthbuf_fragment>
        float t = vUv.y;
        // guard the normalizations: interpolated normals can cancel to zero
        // near the tail tip, and a single NaN fragment turns the whole
        // bloom mip chain into a black rectangle
        float nLen = length(vNormal);
        float vLen = length(vViewDir);
        float facing = (nLen > 1e-6 && vLen > 1e-6)
          ? abs(dot(vNormal / nLen, vViewDir / vLen))
          : 0.0;

        // end-on rescue: looking down the thrust axis every visible normal
        // is ~perpendicular to the view, so the silhouette fade alone would
        // erase the whole plume from above; blend facing back up as the
        // view aligns with the axis so the flame reads as a hot disc
        float aLen = length(vAxis);
        float axisAlign = (aLen > 1e-6 && vLen > 1e-6)
          ? abs(dot(vAxis / aLen, vViewDir / vLen))
          : 0.0;
        facing = max(facing, 0.85 * smoothstep(0.4, 0.9, axisAlign));

        // two octaves of turbulence racing away from the nozzle; wraps in x
        // (seam-free would need periodic noise, but the seam hides in the
        // streaks)
        float n1 = vnoise(vec2(vUv.x * 6.0, t * 4.0 - uTime * 6.5));
        float n2 = vnoise(vec2(vUv.x * 13.0 + 7.3, t * 9.0 - uTime * 11.0));
        float turb = 0.6 * n1 + 0.4 * n2;

        float axial = pow(1.0 - t, 0.7);
        float edge = pow(facing, 0.8);

        float diamonds = (0.55 + 0.45 * cos(t * 30.0 - uTime * 2.0))
          * exp(-t * 3.5) * pow(facing, 3.0);

        vec3 core = vec3(3.2, 2.9, 2.4);
        vec3 sheath = vec3(2.6, 1.15, 0.3);
        vec3 col = mix(sheath, core, pow(facing, 2.5) * (1.0 - t * 0.7));
        // hottest right at the nozzle so bloom carries the flame even
        // against bright backgrounds like the daylit pad
        col *= 0.5 + 1.1 * axial;
        // combustion crackle: brightness rides the turbulence downstream
        col *= 0.85 + 0.4 * turb;
        col += core * diamonds * 0.6;

        // the first third of the jet is a steady, near-opaque column — this
        // is the part seen against the bright pad at launch, where a
        // half-transparent flame washes out completely; downstream the
        // turbulence increasingly gates alpha so the tail shreds into
        // flickering streaks instead of a smooth candle taper
        float downstream = smoothstep(0.3, 0.65, t);
        float density = mix(0.95 + 0.05 * turb, 0.35 + 0.65 * turb, downstream);
        float breakup = mix(1.0,
          smoothstep(0.18, 0.6, (1.0 - t) + (turb - 0.5) * 1.1),
          downstream);

        float alpha = min(axial * edge * density * breakup * (0.78 + 0.22 * uThrottle), 1.0);
        // splashed fragments sit at large t where the axial fade has nearly
        // killed them, their stretched normals wash the core mix toward
        // white, and the facing fade can't be trusted — override both with
        // solid fire-orange so the ground sheet reads as flame, not film
        float splash = clamp(vSplash * 0.8, 0.0, 1.0);
        col = mix(col, vec3(3.4, 1.7, 0.45) * (0.8 + 0.4 * turb), splash);
        alpha = clamp(alpha + splash * (0.35 + 0.35 * turb), 0.0, 1.0);
        if (!(alpha > 0.001)) discard; // also drops NaN alpha
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

/**
 * Ignition-fireball dome: a shallow squashed hemisphere, unit rim radius,
 * height 0.35, with uv.y running 0 (apex/center) → 1 (rim) so the shader can
 * fade radially. Sits at the ground plane under an igniting engine.
 */
function makeFireballGeometry(): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const segments = 24;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const radius = Math.max(Math.sin((t * Math.PI) / 2), 0.02);
    points.push(new THREE.Vector2(radius, 0.35 * Math.cos((t * Math.PI) / 2)));
  }
  return new THREE.LatheGeometry(points, 28);
}

/**
 * HDR fireball shader: white-hot center falling off to deep orange at the
 * rim, noise-flickered, rim eroded by the same noise so the edge licks and
 * dances instead of ending in a clean ellipse. uStrength drives overall
 * opacity so the fireball fades out as the rocket climbs away.
 */
function makeFireballMaterial(): THREE.ShaderMaterial {
  // includes the logdepthbuf chunks for the same reason as the plume — see
  // makePlumeMaterial()
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        // rim wobble: the outer edge surges in and out
        float wob = 1.0
          + 0.10 * sin(uTime * 21.0 + p.x * 5.0) * uv.y
          + 0.07 * sin(uTime * 33.7 + p.z * 7.0 + 1.4) * uv.y;
        p.x *= wob;
        p.z *= wob;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime;
      uniform float uStrength;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      void main() {
        #include <logdepthbuf_fragment>
        float rad = vUv.y;
        float n = vnoise(vec2(vUv.x * 9.0 + uTime * 1.2, rad * 4.0 - uTime * 2.3));
        vec3 core = vec3(4.2, 3.6, 2.6);
        vec3 rim = vec3(3.0, 1.25, 0.3);
        vec3 col = mix(core, rim, smoothstep(0.1, 0.8, rad));
        col *= 0.8 + 0.4 * n;
        float alpha = uStrength * 0.92
          * (1.0 - smoothstep(0.5, 1.0, rad + (n - 0.5) * 0.3));
        if (!(alpha > 0.003)) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
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
