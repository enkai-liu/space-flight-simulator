import * as THREE from 'three';
import {
  Simulation,
  SystemTree,
  Vec3,
  RAILS_WARP_TIERS,
  compileCraft,
  type CraftDesign,
  type Vessel,
} from '@sfs/sim';
import type { ServerMessage, VesselSnapshot, WireMotion } from '@sfs/protocol';
import { BODY_APPEARANCE, PART_CATALOG, SOLAR_SYSTEM } from '@sfs/data';
import { FloatingOrigin, simToRender } from '../render/FloatingOrigin.js';
import { createBodyObject } from '../render/PlanetRenderer.js';
import { createSky } from '../render/Skybox.js';
import { OrbitCamera } from '../render/OrbitCamera.js';
import { VesselRenderer } from '../render/VesselRenderer.js';
import { LaunchSite } from '../render/LaunchSite.js';
import { MapView } from '../render/MapView.js';
import { PostFX } from '../render/PostFX.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Hud } from '../ui/hud.js';
import type { NetClient } from '../net/NetClient.js';

const VESSEL_ID = 'player';
const PAD_LONGITUDE = 0;
/** own-vessel prediction error beyond which we snap to the server state, m */
const RECONCILE_SNAP_DISTANCE = 50;

export interface FlightCallbacks {
  onExit(): void;
}

export interface NetContext {
  client: NetClient;
  join: { type: 'createLobby' } | { type: 'joinLobby'; code: string };
}

export interface FlightScreen {
  dispose(): void;
}

function motionFromWire(wire: WireMotion): Vessel['motion'] {
  if (wire.kind === 'rails') return { kind: 'rails', orbit: wire.orbit };
  return {
    kind: 'physics',
    bodyId: wire.bodyId,
    r: new Vec3(...wire.r),
    v: new Vec3(...wire.v),
    landed: wire.landed,
  };
}

/** Launch a craft design and run the flight scene until disposed. */
export function startFlight(
  container: HTMLElement,
  design: CraftDesign,
  callbacks: FlightCallbacks,
  netContext?: NetContext,
): FlightScreen {
  const net = netContext?.client;
  const debug = new URLSearchParams(location.search).has('debug');
  const nofx = new URLSearchParams(location.search).has('nofx');
  const config = compileCraft(design, PART_CATALOG);

  // --- renderer ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  container.appendChild(renderer.domElement);

  // --- flight scene ---
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 1e13);
  scene.add(createSky());
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x445566, 0.5));
  scene.add(new THREE.HemisphereLight(0x8fb4e8, 0x3a4a33, 0.55));
  const postFx = nofx ? null : new PostFX(renderer, scene, camera);

  // shared env map for vessel metal; applied per-material, NOT scene.environment
  // (that would wash out every planet's MeshStandardMaterial)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const vesselEnvMap = pmrem.fromScene(new RoomEnvironment()).texture;
  pmrem.dispose();

  // --- simulation ---
  const tree = new SystemTree(SOLAR_SYSTEM);
  const sim = new Simulation(tree);
  sim.debrisEnabled = true; // jettisoned stages fall as local physics vessels
  const floatingOrigin = new FloatingOrigin();

  // In single-player the vessel exists immediately; in multiplayer we wait for
  // the server's authoritative spawn (which also tells us our pad slot).
  let vessel: Vessel | null = null;
  const vesselRenderers = new Map<string, VesselRenderer>();
  /** craft design per vessel id — debris renderers are built from the parent's */
  const designByVessel = new Map<string, CraftDesign>();

  function addVesselRenderer(id: string, craft: CraftDesign, onlySection?: number): VesselRenderer {
    const vr = new VesselRenderer(craft, PART_CATALOG, vesselEnvMap, onlySection);
    vesselRenderers.set(id, vr);
    if (onlySection === undefined) designByVessel.set(id, craft);
    scene.add(vr.object);
    floatingOrigin.register(vr.object, () => {
      if (!sim.hasVessel(id)) return Vec3.ZERO;
      const { bodyId, r } = sim.vesselState(id);
      return tree.globalState(bodyId, sim.simTime).r.add(r);
    });
    return vr;
  }

  function removeVesselRenderer(id: string): void {
    const vr = vesselRenderers.get(id);
    if (!vr) return;
    scene.remove(vr.object);
    floatingOrigin.unregister(vr.object);
    vesselRenderers.delete(id);
    designByVessel.delete(id);
  }

  if (!net) {
    vessel = sim.spawnLanded(VESSEL_ID, config, 'terra', PAD_LONGITUDE);
    addVesselRenderer(VESSEL_ID, design);
  }

  const bodyObjects = new Map<string, THREE.Group>();
  for (const body of tree.all()) {
    const appearance = BODY_APPEARANCE[body.id];
    if (!appearance) throw new Error(`no appearance defined for body ${body.id}`);
    const object = createBodyObject(body, appearance);
    bodyObjects.set(body.id, object);
    scene.add(object);
    floatingOrigin.register(object, () => tree.globalState(body.id, sim.simTime).r);
  }

  const launchSite = new LaunchSite(tree, 'terra', PAD_LONGITUDE, BODY_APPEARANCE['terra']!, vesselEnvMap);
  scene.add(launchSite.object);
  floatingOrigin.register(launchSite.object, () => launchSite.globalPosition(sim.simTime));

  // The home body's opaque surface sphere can't share a depth buffer with
  // the local scene while the camera sits on it: camera-relative transforms
  // of a 6,400 km translation lose meters of f32 precision at grazing
  // incidence, so the sphere's depth wobbles above ground level and stomps
  // depth-tested transparents like the exhaust plume. Near the pad the
  // launch-site terrain cap covers the ground completely, so the sphere can
  // stay hidden until the camera is high enough to see past the cap.
  const homeSurface = bodyObjects.get('terra')?.getObjectByName('terra-surface') ?? null;
  const HOME_SURFACE_MIN_ALT = 25_000;

  // The vessel's physics point is the bottom of the *original* stack; after
  // staging it sits inside the jettisoned booster, so the camera aims at the
  // center of the remaining stack instead, offset along the long axis. Eased
  // so each staging recenters with a glide instead of a snap.
  let focusOffset: number | null = null;
  const focusOffsetTarget = (): number => {
    const vr = vesselRenderers.get(VESSEL_ID);
    if (!vr || !sim.hasVessel(VESSEL_ID)) return 0;
    return vr.stackCenterOffset(sim.getVessel(VESSEL_ID));
  };
  const easeFocusOffset = (dt: number): void => {
    const target = focusOffsetTarget();
    focusOffset =
      focusOffset === null ? target : focusOffset + (target - focusOffset) * Math.min(1, dt * 6);
  };

  const ownGlobalPos = (): Vec3 => {
    if (!sim.hasVessel(VESSEL_ID)) return launchSite.globalPosition(sim.simTime);
    const { bodyId, r } = sim.vesselState(VESSEL_ID);
    const global = tree.globalState(bodyId, sim.simTime).r.add(r);
    const axis = sim.getVessel(VESSEL_ID).thrustDirection();
    return global.add(axis.scale(focusOffset ?? focusOffsetTarget()));
  };

  // --- cameras & map ---
  const orbitCamera = new OrbitCamera(camera, renderer.domElement, 55);
  const focusBodyId = (): string =>
    sim.hasVessel(VESSEL_ID) ? sim.vesselState(VESSEL_ID).bodyId : 'terra';
  orbitCamera.setFocus(
    ownGlobalPos,
    12,
    () => tree.globalState(focusBodyId(), sim.simTime).r,
    () => tree.get(focusBodyId()).radius + 2.5,
  );
  const mapView = new MapView(innerWidth / innerHeight, renderer.domElement);
  let mapActive = false;

  const WARP_LADDER = [1, 2, 3, 4, ...RAILS_WARP_TIERS.filter((w) => w > 4)];

  // --- input routing: local sim always, plus the server when online ---
  const inputs = {
    throttle(v: number): void {
      if (sim.hasVessel(VESSEL_ID)) sim.setThrottle(VESSEL_ID, v);
      net?.send({ type: 'command', cmd: { kind: 'throttle', value: v } });
    },
    turn(v: number): void {
      if (sim.hasVessel(VESSEL_ID)) sim.setTurnInput(VESSEL_ID, v);
      net?.send({ type: 'command', cmd: { kind: 'turnInput', value: v } });
    },
    stage(): void {
      if (sim.hasVessel(VESSEL_ID)) sim.stage(VESSEL_ID);
      net?.send({ type: 'command', cmd: { kind: 'stage' } });
    },
    engine(iid: number, on: boolean): void {
      if (sim.hasVessel(VESSEL_ID)) sim.setEngine(VESSEL_ID, iid, on);
      net?.send({ type: 'command', cmd: { kind: 'engine', iid, on } });
    },
    warp(factor: number): void {
      if (net) net.send({ type: 'requestWarp', factor });
      else sim.setWarp(factor);
    },
  };

  // --- HUD ---
  const hud = new Hud({
    onThrottle: (v) => inputs.throttle(v),
    onTurnInput: (v) => inputs.turn(v),
    onStage: () => inputs.stage(),
    onEngineToggle: (iid, on) => inputs.engine(iid, on),
    onToggleMap: () => {
      mapActive = !mapActive;
      hud.setMapActive(mapActive);
      if (mapActive && sim.hasVessel(VESSEL_ID)) {
        mapView.focusBodyId = sim.vesselState(VESSEL_ID).bodyId;
        mapView.frameFocus(sim);
      }
    },
    onRestart: () => callbacks.onExit(),
    onExitToBuilder: () => callbacks.onExit(),
    onWarpStep: (direction) => {
      const idx = WARP_LADDER.findIndex((w) => w >= sim.warp);
      const next = WARP_LADDER[Math.min(WARP_LADDER.length - 1, Math.max(0, idx + direction))];
      if (next !== undefined) inputs.warp(next);
    },
  });

  sim.onEvent((event) => {
    // debris renderers track any vessel's staging, own or remote
    if (event.type === 'debrisSpawned') {
      const parentDesign = designByVessel.get(event.fromVesselId);
      if (parentDesign) addVesselRenderer(event.vesselId, parentDesign, event.sectionIndex);
      return;
    }
    if (event.type === 'debrisRemoved') {
      removeVesselRenderer(event.vesselId);
      return;
    }
    if (!('vesselId' in event) || event.vesselId !== VESSEL_ID) return; // own-vessel toasts only
    switch (event.type) {
      case 'liftoff':
        hud.showToast('LIFTOFF');
        break;
      case 'stage':
        hud.showToast(`STAGE ${event.stagesLeft} REMAINING`);
        break;
      case 'stageEmpty':
        hud.showToast('STAGE EMPTY');
        break;
      case 'onRails':
        hud.showToast('STABLE ORBIT');
        break;
      case 'crashed':
        hud.showToast('CRASHED');
        break;
      case 'landed':
        hud.showToast('TOUCHDOWN');
        hud.showRecovered();
        break;
      case 'chuteDeployed':
        hud.showToast('CHUTES DEPLOYED');
        break;
      case 'overheated':
        hud.showToast('BURNED UP ON RE-ENTRY');
        break;
      case 'soiChange':
        hud.showToast(`ENTERING ${tree.get(event.toBodyId).name.toUpperCase()} SPACE`);
        break;
    }
  });

  // --- multiplayer sync ---
  let unsubscribeNet: (() => void) | null = null;
  let lobbyCode: string | null = null;
  if (net) {
    const applySnapshot = (snapshot: VesselSnapshot, simTime: number): void => {
      const isOwn = snapshot.ownerId === net.playerId;
      const localId = isOwn ? VESSEL_ID : snapshot.vesselId;

      if (Math.abs(simTime - sim.simTime) > 0.5) sim.simTime = simTime;

      if (!sim.hasVessel(localId)) {
        const cfg = compileCraft(snapshot.craft, PART_CATALOG);
        const v = sim.spawnVessel(localId, cfg, motionFromWire(snapshot.motion));
        // seed attitude from the server even for the own vessel — after this,
        // local input owns the heading and we stop overwriting it
        v.heading = snapshot.heading;
        if (isOwn) vessel = v;
        addVesselRenderer(localId, snapshot.craft);
      }
      const v = sim.getVessel(localId);

      // stage/fuel/flag sync (authoritative) — staging through the sim so the
      // jettisoned sections detach as debris here too
      while (!v.destroyed && v.stages.length > snapshot.stagesLeft && v.stages.length > 1) {
        sim.stage(localId);
      }
      snapshot.stageFuel.forEach((fuel, i) => {
        if (v.stages[i]) v.stages[i]!.fuel = fuel;
      });
      v.destroyed = snapshot.destroyed;
      v.chuteDeployed = snapshot.chuteDeployed;
      v.heat = snapshot.heat;

      if (isOwn) {
        // prediction reconciliation: correct only when meaningfully divergent
        const serverMotion = motionFromWire(snapshot.motion);
        if (serverMotion.kind === 'rails' || v.motion.kind !== 'physics') {
          v.motion = serverMotion;
        } else if (serverMotion.kind === 'physics') {
          const drift = v.motion.r.sub(serverMotion.r).length();
          if (drift > RECONCILE_SNAP_DISTANCE) v.motion = serverMotion;
        }
      } else {
        // remotes are fully authoritative; local sim dead-reckons between updates
        v.motion = motionFromWire(snapshot.motion);
        v.heading = snapshot.heading;
        v.throttle = snapshot.throttle;
        for (const iid of v.engineOn.keys()) v.setEngine(iid, snapshot.enginesOn.includes(iid));
      }
    };

    unsubscribeNet = net.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'lobbyJoined':
          sim.simTime = msg.simTime;
          sim.setWarp(msg.warp);
          for (const snapshot of msg.vessels) applySnapshot(snapshot, msg.simTime);
          net.send({ type: 'launchVessel', craft: design });
          lobbyCode = msg.code;
          hud.showToast(`LOBBY CODE: ${msg.code}`);
          break;
        case 'vesselSpawned':
          applySnapshot(msg.snapshot, sim.simTime);
          if (msg.snapshot.ownerId !== net.playerId) hud.showToast(`${msg.snapshot.name} ON THE PAD`);
          break;
        case 'vesselState':
          applySnapshot(msg.snapshot, msg.simTime);
          break;
        case 'vesselRemoved': {
          removeVesselRenderer(msg.vesselId);
          if (sim.hasVessel(msg.vesselId)) sim.removeVessel(msg.vesselId);
          break;
        }
        case 'warpChanged':
          sim.setWarp(msg.factor);
          if (Math.abs(msg.simTime - sim.simTime) > 0.5) sim.simTime = msg.simTime;
          break;
        case 'playerJoined':
          hud.showToast(`${msg.player.name.toUpperCase()} JOINED`);
          break;
        case 'playerLeft':
          hud.showToast('A PILOT DISCONNECTED');
          break;
        case 'error':
          hud.showToast(msg.message.toUpperCase());
          break;
      }
    });

    // subscribe first, then ask for the lobby — no message can be missed
    net.send(netContext!.join);
  }

  // --- debug overlay ---
  let debugEl: HTMLElement | null = null;
  if (debug) {
    debugEl = document.createElement('div');
    debugEl.id = 'debug';
    document.body.appendChild(debugEl);
  }
  let frames = 0;
  let fps = 0;
  let lastFpsAt = performance.now();

  // --- frame loop ---
  let lastFrameAt = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - lastFrameAt) / 1000, 0.1);
    lastFrameAt = now;

    sim.advance(dt);
    easeFocusOffset(dt);

    const hasOwn = sim.hasVessel(VESSEL_ID);
    const readout = hasOwn ? sim.vesselReadout(VESSEL_ID) : null;
    if (readout) {
      hud.update(readout);
      hud.updateTime(sim.warp, sim.simTime);
    }

    if (mapActive && hasOwn) {
      mapView.update(sim, VESSEL_ID);
      renderer.render(mapView.scene, mapView.camera);
    } else {
      const cameraGlobal = orbitCamera.globalPosition();
      floatingOrigin.update(cameraGlobal);
      orbitCamera.updateOrientation();

      for (const [id, object] of bodyObjects) {
        // sim rotZ(a) maps to render rotY(+a) under simToRender — a negated
        // angle here would counter-rotate the surface texture relative to the
        // launch site, drifting the launch continent away from the pad
        object.rotation.y = tree.rotationAngle(id, sim.simTime);
      }
      launchSite.updateOrientation(sim.simTime);
      if (homeSurface) {
        const camAlt =
          cameraGlobal.sub(tree.globalState('terra', sim.simTime).r).length() -
          tree.get('terra').radius;
        homeSurface.visible = camAlt > HOME_SURFACE_MIN_ALT;
      }
      for (const [id, vr] of vesselRenderers) {
        if (sim.hasVessel(id)) {
          const { bodyId, r } = sim.vesselState(id);
          const clearance = r.length() - tree.get(bodyId).radius;
          vr.update(sim.getVessel(id), clearance);
          vr.object.visible = !sim.getVessel(id).destroyed;
        }
      }

      const sunRel = simToRender(tree.globalState('helios', sim.simTime).r.sub(cameraGlobal));
      sunLight.position.copy(sunRel);
      sunLight.target.position.set(0, 0, 0);

      if (postFx) postFx.render();
      else renderer.render(scene, camera);
    }

    frames++;
    if (now - lastFpsAt > 1000) {
      fps = Math.round((frames * 1000) / (now - lastFpsAt));
      frames = 0;
      lastFpsAt = now;
      if (debugEl && readout) {
        debugEl.innerHTML =
          `<span data-testid="fps">${fps}</span> fps  draws ${renderer.info.render.calls}\n` +
          `sim t <span data-testid="simtime">${sim.simTime.toFixed(1)}</span> s  warp ×${sim.warp}` +
          `${net ? '  online' : ''}\n` +
          `alt <span data-testid="dbg-alt">${readout.altitude.toFixed(0)}</span> m  ` +
          `apo <span data-testid="dbg-apo">${readout.apoapsis.toFixed(0)}</span>  ` +
          `per <span data-testid="dbg-per">${readout.periapsis.toFixed(0)}</span>\n` +
          `${readout.onRails ? 'RAILS' : readout.landed ? 'LANDED' : 'PHYSICS'}`;
      }
    }
  });

  const onResize = (): void => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    mapView.resize(innerWidth / innerHeight);
    renderer.setSize(innerWidth, innerHeight);
    postFx?.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);

  // dev-only handle for scripted verification (plan §8)
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__sfs = {
      sim,
      scene,
      vesselId: VESSEL_ID,
      getFps: () => fps,
      setThrottle: (v: number) => inputs.throttle(v),
      setHeading: (rad: number) => {
        if (vessel) {
          vessel.heading = rad;
          net?.send({ type: 'command', cmd: { kind: 'heading', value: rad } });
        }
      },
      stage: () => inputs.stage(),
      setEngine: (iid: number, on: boolean) => inputs.engine(iid, on),
      readout: () => sim.vesselReadout(VESSEL_ID),
      vesselIds: () => [...sim.vessels()].map((v) => v.id),
      lobbyCode: () => lobbyCode,
    };
    w.__sfsMap = mapView;
  }

  return {
    dispose(): void {
      renderer.setAnimationLoop(null);
      removeEventListener('resize', onResize);
      unsubscribeNet?.();
      net?.send({ type: 'leaveLobby' });
      hud.dispose();
      debugEl?.remove();
      postFx?.dispose();
      vesselEnvMap.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__sfs;
        delete (window as unknown as Record<string, unknown>).__sfsMap;
      }
    },
  };
}
