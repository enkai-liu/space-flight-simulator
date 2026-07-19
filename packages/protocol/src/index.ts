import type { CraftDesign, Orbit } from '@sfs/sim';

/**
 * Client ↔ server message contract (plan §6.3). JSON over WebSocket,
 * discriminated unions on `type`. The server is authoritative; clients send
 * commands and predict their own vessel with the identical sim core.
 */

// ------------------------------------------------------------ shared shapes

export interface PlayerInfo {
  id: string;
  name: string;
  vesselId: string | null;
}

/** Wire form of a vessel's motion (mirrors @sfs/sim VesselMotion). */
export type WireMotion =
  | { kind: 'rails'; orbit: Orbit }
  | { kind: 'physics'; bodyId: string; r: [number, number, number]; v: [number, number, number]; landed: boolean };

export interface VesselSnapshot {
  vesselId: string;
  ownerId: string;
  name: string;
  craft: CraftDesign;
  motion: WireMotion;
  heading: number;
  throttle: number;
  /** fuel per remaining stage, bottom-first */
  stageFuel: number[];
  /** part iids of engines currently switched on */
  enginesOn: number[];
  stagesLeft: number;
  destroyed: boolean;
  chuteDeployed: boolean;
  heat: number;
}

// --------------------------------------------------------- client → server

export type ClientMessage =
  | { type: 'hello'; token: string; name: string }
  | { type: 'createLobby' }
  | { type: 'joinLobby'; code: string }
  | { type: 'leaveLobby' }
  | { type: 'launchVessel'; craft: CraftDesign }
  | { type: 'command'; cmd: VesselCommand }
  | { type: 'requestWarp'; factor: number }
  | { type: 'ping'; t: number };

export type VesselCommand =
  | { kind: 'throttle'; value: number }
  | { kind: 'turnInput'; value: number }
  | { kind: 'heading'; value: number }
  | { kind: 'engine'; iid: number; on: boolean }
  | { kind: 'stage' };

// --------------------------------------------------------- server → client

export type ServerMessage =
  | { type: 'welcome'; playerId: string }
  | { type: 'error'; message: string }
  | {
      type: 'lobbyJoined';
      code: string;
      simTime: number;
      warp: number;
      players: PlayerInfo[];
      vessels: VesselSnapshot[];
    }
  | { type: 'playerJoined'; player: PlayerInfo }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'vesselSpawned'; snapshot: VesselSnapshot }
  | { type: 'vesselRemoved'; vesselId: string }
  /** authoritative periodic state (5 Hz for physics vessels, on-change for rails) */
  | { type: 'vesselState'; simTime: number; snapshot: VesselSnapshot }
  | { type: 'warpChanged'; factor: number; simTime: number }
  | { type: 'simEvent'; vesselId: string; event: string }
  | { type: 'pong'; t: number };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    return typeof msg === 'object' && msg !== null && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

export function decodeServer(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as ServerMessage;
    return typeof msg === 'object' && msg !== null && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}
