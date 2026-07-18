import {
  Simulation,
  SystemTree,
  Vec3,
  compileCraft,
  migrateCraft,
  validateCraft,
  type CraftDesign,
  type LegacyCraftDesign,
  type Vessel,
} from '@sfs/sim';
import { PART_CATALOG, SOLAR_SYSTEM } from '@sfs/data';
import type { ServerMessage, VesselSnapshot, VesselCommand, WireMotion, PlayerInfo } from '@sfs/protocol';

export interface LobbyPlayer {
  id: string;
  name: string;
  vesselId: string | null;
  requestedWarp: number;
  connected: boolean;
  /** wall-clock ms of disconnect, for the 5-minute grace window */
  disconnectedAt: number;
  send(msg: ServerMessage): void;
}

const PHYSICS_BROADCAST_EVERY = 10; // ticks of the 20 ms server loop → 5 Hz
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

/** One shared solar system: the server-authoritative Simulation plus its players. */
export class Lobby {
  readonly sim = new Simulation(new SystemTree(SOLAR_SYSTEM));
  private readonly players = new Map<string, LobbyPlayer>();
  private readonly craftByVessel = new Map<string, CraftDesign>();
  private loopCounter = 0;

  constructor(readonly code: string) {
    this.sim.onEvent((event) => {
      // forward interesting events + a fresh authoritative snapshot
      if ('vesselId' in event) {
        this.broadcast({ type: 'simEvent', vesselId: event.vesselId, event: event.type });
        if (this.sim.hasVessel(event.vesselId)) {
          this.broadcast({
            type: 'vesselState',
            simTime: this.sim.simTime,
            snapshot: this.snapshotOf(event.vesselId),
          });
        }
      } else if (event.type === 'warpChanged') {
        this.broadcast({ type: 'warpChanged', factor: event.factor, simTime: this.sim.simTime });
      }
    });
  }

  playerInfos(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, vesselId: p.vesselId }));
  }

  snapshots(): VesselSnapshot[] {
    return [...this.craftByVessel.keys()].filter((id) => this.sim.hasVessel(id)).map((id) => this.snapshotOf(id));
  }

  snapshotOf(vesselId: string): VesselSnapshot {
    const vessel = this.sim.getVessel(vesselId);
    const owner = [...this.players.values()].find((p) => p.vesselId === vesselId);
    return {
      vesselId,
      ownerId: owner?.id ?? '',
      name: vessel.name,
      craft: this.craftByVessel.get(vesselId)!,
      motion: toWire(vessel),
      heading: vessel.heading,
      throttle: vessel.throttle,
      stageFuel: vessel.stages.map((s) => s.fuel),
      stagesLeft: vessel.stages.length,
      destroyed: vessel.destroyed,
      chuteDeployed: vessel.chuteDeployed,
      heat: vessel.heat,
    };
  }

  broadcast(msg: ServerMessage, except?: string): void {
    for (const player of this.players.values()) {
      if (player.connected && player.id !== except) player.send(msg);
    }
  }

  addPlayer(player: LobbyPlayer): void {
    const existing = this.players.get(player.id);
    if (existing) {
      // token reconnect: resume the old seat
      existing.send = player.send;
      existing.connected = true;
      existing.name = player.name;
      return;
    }
    this.players.set(player.id, player);
    this.broadcast({ type: 'playerJoined', player: { id: player.id, name: player.name, vesselId: null } }, player.id);
  }

  getPlayer(id: string): LobbyPlayer | undefined {
    return this.players.get(id);
  }

  markDisconnected(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    player.requestedWarp = 1; // a gone player must not hold warp hostage… or block it
    this.applyWarpRule();
    this.broadcast({ type: 'playerLeft', playerId });
  }

  /** Fully drop players whose grace window expired; returns true when empty. */
  reap(): boolean {
    const now = Date.now();
    for (const [id, player] of this.players) {
      if (!player.connected && now - player.disconnectedAt > DISCONNECT_GRACE_MS) {
        if (player.vesselId) {
          this.sim.removeVessel(player.vesselId);
          this.craftByVessel.delete(player.vesselId);
          this.broadcast({ type: 'vesselRemoved', vesselId: player.vesselId });
        }
        this.players.delete(id);
      }
    }
    return [...this.players.values()].every((p) => !p.connected) && this.players.size === 0;
  }

  launchVessel(playerId: string, rawCraft: CraftDesign | LegacyCraftDesign): VesselSnapshot | { error: string } {
    const player = this.players.get(playerId);
    if (!player) return { error: 'not in lobby' };
    const craft = migrateCraft(rawCraft, PART_CATALOG);
    const errors = validateCraft(craft, PART_CATALOG).filter((i) => i.severity === 'error');
    if (errors.length > 0) return { error: `invalid craft: ${errors[0]!.message}` };

    if (player.vesselId) {
      this.sim.removeVessel(player.vesselId);
      this.craftByVessel.delete(player.vesselId);
      this.broadcast({ type: 'vesselRemoved', vesselId: player.vesselId });
    }

    const vesselId = `${playerId}-v${Date.now() % 100000}`;
    const config = compileCraft(craft, PART_CATALOG);
    // spread players along the pad row so rockets don't spawn intersecting
    const padSlot = [...this.players.keys()].indexOf(playerId);
    this.sim.spawnLanded(vesselId, config, 'terra', padSlot * 0.0002);
    player.vesselId = vesselId;
    this.craftByVessel.set(vesselId, craft);
    this.applyWarpRule();

    const snapshot = this.snapshotOf(vesselId);
    this.broadcast({ type: 'vesselSpawned', snapshot });
    return snapshot;
  }

  applyCommand(playerId: string, cmd: VesselCommand): void {
    const player = this.players.get(playerId);
    if (!player?.vesselId || !this.sim.hasVessel(player.vesselId)) return;
    switch (cmd.kind) {
      case 'throttle':
        this.sim.setThrottle(player.vesselId, cmd.value);
        break;
      case 'turnInput':
        this.sim.setTurnInput(player.vesselId, cmd.value);
        break;
      case 'heading':
        this.sim.getVessel(player.vesselId).heading = cmd.value;
        break;
      case 'stage':
        this.sim.stage(player.vesselId);
        break;
    }
  }

  /** Min-rule coordinated warp (plan §6.2): slowest player wins. */
  requestWarp(playerId: string, factor: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.requestedWarp = Math.max(1, factor);
    this.applyWarpRule();
  }

  private applyWarpRule(): void {
    const connected = [...this.players.values()].filter((p) => p.connected);
    if (connected.length === 0) return;
    const requested = Math.min(...connected.map((p) => p.requestedWarp));
    this.sim.setWarp(requested); // Simulation clamps by maxAllowedWarp()
  }

  /** One 20 ms server loop step. */
  tick(dt: number): void {
    this.sim.advance(dt);
    this.loopCounter++;
    if (this.loopCounter % PHYSICS_BROADCAST_EVERY === 0) {
      for (const vesselId of this.craftByVessel.keys()) {
        if (!this.sim.hasVessel(vesselId)) continue;
        const vessel = this.sim.getVessel(vesselId);
        // rails vessels are analytic — clients propagate them; only physics
        // vessels need periodic state (plan §6.1)
        if (vessel.motion.kind === 'physics' && !vessel.destroyed) {
          this.broadcast({ type: 'vesselState', simTime: this.sim.simTime, snapshot: this.snapshotOf(vesselId) });
        }
      }
    }
  }
}

export function toWire(vessel: Vessel): WireMotion {
  if (vessel.motion.kind === 'rails') return { kind: 'rails', orbit: vessel.motion.orbit };
  const { bodyId, r, v, landed } = vessel.motion;
  return { kind: 'physics', bodyId, r: [r.x, r.y, r.z], v: [v.x, v.y, v.z], landed };
}

export function fromWire(motion: WireMotion): Vessel['motion'] {
  if (motion.kind === 'rails') return { kind: 'rails', orbit: motion.orbit };
  return {
    kind: 'physics',
    bodyId: motion.bodyId,
    r: new Vec3(...motion.r),
    v: new Vec3(...motion.v),
    landed: motion.landed,
  };
}
