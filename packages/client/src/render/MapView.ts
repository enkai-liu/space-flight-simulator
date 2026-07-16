import * as THREE from 'three';
import {
  Simulation,
  stateVectorsToElements,
  elementsToStateVectors,
  orbitPositionAtTrueAnomaly,
  type Orbit,
} from '@sfs/sim';
import { BODY_APPEARANCE } from '@sfs/data';
import { simToRender } from './FloatingOrigin.js';

/** 1 map unit = 10 km — the whole system fits comfortably in f32. */
const MAP_SCALE = 1e-4;

function sampleOrbitLine(orbit: Orbit, attribute: THREE.BufferAttribute, n: number): void {
  const nuMax = orbit.e >= 1 ? Math.acos(-1 / orbit.e) * 0.98 : Math.PI;
  for (let i = 0; i <= n; i++) {
    const nu = -nuMax + (2 * nuMax * i) / n;
    const p = simToRender(orbitPositionAtTrueAnomaly(orbit, nu)).multiplyScalar(MAP_SCALE);
    attribute.setXYZ(i, p.x, p.y, p.z);
  }
  attribute.needsUpdate = true;
}

function makeLine(color: number, points: number, dashed = false): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((points + 1) * 3), 3));
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.9 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  return line;
}

/**
 * The orbital map: its own scaled scene, focusable on any body. Shows every
 * body, their orbits, the player's current conic, and — when a patched-conic
 * transition is scheduled — the predicted next conic (dashed).
 */
export class MapView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  focusBodyId = 'terra';

  private readonly vesselOrbitLine: THREE.Line;
  private readonly nextConicLine: THREE.Line;
  private readonly vesselMarker: THREE.Mesh;
  private readonly bodyMeshes = new Map<string, THREE.Mesh>();
  private readonly bodyOrbitLines = new Map<string, THREE.Line>();
  private zoom = 250; // map units from focus
  private readonly raycaster = new THREE.Raycaster();

  constructor(aspect: number, element: HTMLElement, private readonly onFocusBody?: (id: string) => void) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1e7);

    this.vesselOrbitLine = makeLine(0x69d2ff, 256);
    this.scene.add(this.vesselOrbitLine);
    this.nextConicLine = makeLine(0xffb347, 256, true);
    this.scene.add(this.nextConicLine);

    this.vesselMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.scene.add(this.vesselMarker);

    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2));

    element.addEventListener(
      'wheel',
      (e) => {
        this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(e.deltaY * 0.001), 4, 5e6);
      },
      { passive: true },
    );

    // pinch zoom
    const pointers = new Map<number, { x: number; y: number }>();
    let lastPinch = 0;
    element.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        lastPinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    });
    element.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (lastPinch > 0) this.zoom = THREE.MathUtils.clamp((this.zoom * lastPinch) / d, 4, 5e6);
        lastPinch = d;
      }
    });
    const clear = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      lastPinch = 0;
    };
    element.addEventListener('pointerup', clear);
    element.addEventListener('pointercancel', clear);

    // tap a body to focus it
    element.addEventListener('click', (e) => {
      const ndc = new THREE.Vector2(
        (e.clientX / element.clientWidth) * 2 - 1,
        -(e.clientY / element.clientHeight) * 2 + 1,
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      // generous touch threshold: scale sphere hit area via a second pass
      const hits = this.raycaster.intersectObjects([...this.bodyMeshes.values()]);
      const hit = hits[0]?.object.name;
      if (hit) {
        this.focusBodyId = hit;
        this.onFocusBody?.(hit);
      }
    });
  }

  private bodyMesh(sim: Simulation, id: string): THREE.Mesh {
    let mesh = this.bodyMeshes.get(id);
    if (!mesh) {
      const body = sim.tree.get(id);
      const appearance = BODY_APPEARANCE[id];
      // floor the visual size so small moons stay tappable when zoomed out
      const geomRadius = Math.max(body.radius * MAP_SCALE, 1.5);
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(geomRadius, 32, 24),
        new THREE.MeshStandardMaterial({
          color: appearance?.color ?? '#888',
          emissive: appearance?.emissive ? appearance.color : '#000',
          roughness: 1,
        }),
      );
      mesh.name = id;
      mesh.userData.geomRadius = geomRadius;
      this.bodyMeshes.set(id, mesh);
      this.scene.add(mesh);

      if (body.orbit) {
        const line = makeLine(0x3d5878, 200);
        sampleOrbitLine(body.orbit, line.geometry.getAttribute('position') as THREE.BufferAttribute, 200);
        line.computeLineDistances();
        this.bodyOrbitLines.set(id, line);
        this.scene.add(line);
      }
    }
    return mesh;
  }

  /** Sensible zoom when focus changes: frame the body's SOI / children. */
  frameFocus(sim: Simulation): void {
    const body = sim.tree.get(this.focusBodyId);
    const soi = body.soiRadius === Infinity ? body.radius * 3000 : body.soiRadius;
    this.zoom = THREE.MathUtils.clamp(soi * MAP_SCALE * 1.6, 4, 5e6);
  }

  update(sim: Simulation, vesselId: string): void {
    const t = sim.simTime;
    const focusGlobal = sim.tree.globalState(this.focusBodyId, t).r;

    // every body positioned relative to the focus body; bodies too small to
    // see at the current zoom get scaled up into tappable markers
    const minVisual = this.zoom * 0.008;
    for (const body of sim.tree.all()) {
      const mesh = this.bodyMesh(sim, body.id);
      const rel = sim.tree.globalState(body.id, t).r.sub(focusGlobal);
      mesh.position.copy(simToRender(rel).multiplyScalar(MAP_SCALE));
      mesh.scale.setScalar(Math.max(1, minVisual / (mesh.userData.geomRadius as number)));
      // each body's orbit line is centered on its parent
      const line = this.bodyOrbitLines.get(body.id);
      if (line && body.parentId !== undefined) {
        const parentRel = sim.tree.globalState(body.parentId, t).r.sub(focusGlobal);
        line.position.copy(simToRender(parentRel).multiplyScalar(MAP_SCALE));
      }
    }

    // vessel + current conic (drawn around the vessel's SOI body)
    const { bodyId, r, v } = sim.vesselState(vesselId);
    const body = sim.tree.get(bodyId);
    const bodyRel = simToRender(sim.tree.globalState(bodyId, t).r.sub(focusGlobal)).multiplyScalar(MAP_SCALE);
    this.vesselMarker.position.copy(bodyRel).add(simToRender(r).multiplyScalar(MAP_SCALE));

    const vessel = sim.getVessel(vesselId);
    let orbit: Orbit | null = null;
    if (vessel.motion.kind === 'rails') {
      orbit = vessel.motion.orbit;
    } else {
      try {
        orbit = stateVectorsToElements(r, v, body.mu, bodyId, t);
      } catch {
        orbit = null; // degenerate (on the pad)
      }
    }
    this.vesselOrbitLine.visible = orbit !== null;
    if (orbit) {
      this.vesselOrbitLine.position.copy(bodyRel);
      sampleOrbitLine(orbit, this.vesselOrbitLine.geometry.getAttribute('position') as THREE.BufferAttribute, 256);
    }

    // predicted conic after the next SOI transition (dashed)
    this.nextConicLine.visible = false;
    const transition = sim.nextTransition(vesselId);
    if (orbit && transition && transition.kind !== 'dropToPhysics') {
      const local = elementsToStateVectors(orbit, body.mu, transition.time);
      let nextBodyId: string | null = null;
      let nr = local.r;
      let nv = local.v;
      if (transition.kind === 'soiExit' && body.parentId !== undefined) {
        nextBodyId = body.parentId;
        const bs = sim.tree.localState(body.id, transition.time);
        nr = nr.add(bs.r);
        nv = nv.add(bs.v);
      } else if (transition.kind === 'soiEntry') {
        nextBodyId = transition.targetBodyId;
        const cs = sim.tree.localState(transition.targetBodyId, transition.time);
        nr = nr.sub(cs.r);
        nv = nv.sub(cs.v);
      }
      if (nextBodyId) {
        try {
          const nextOrbit = stateVectorsToElements(nr, nv, sim.tree.get(nextBodyId).mu, nextBodyId, transition.time);
          const nextBodyRel = simToRender(sim.tree.globalState(nextBodyId, t).r.sub(focusGlobal)).multiplyScalar(MAP_SCALE);
          this.nextConicLine.position.copy(nextBodyRel);
          sampleOrbitLine(
            nextOrbit,
            this.nextConicLine.geometry.getAttribute('position') as THREE.BufferAttribute,
            256,
          );
          this.nextConicLine.computeLineDistances();
          this.nextConicLine.visible = true;
        } catch {
          // degenerate prediction — just skip drawing it
        }
      }
    }

    // top-down view of the ecliptic with a slight tilt
    this.camera.position.set(0, this.zoom, this.zoom * 0.25);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(this.zoom / 1e4, 0.01);
    this.camera.far = this.zoom * 1e4;
    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
