import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@sfs/protocol';
import { KARMAN_I_DESIGN } from '@sfs/data';
import { Lobby, type LobbyPlayer } from '../src/Lobby.js';

function makePlayer(id: string): { player: LobbyPlayer; inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  const player: LobbyPlayer = {
    id,
    name: id,
    vesselId: null,
    requestedWarp: 1,
    connected: true,
    disconnectedAt: 0,
    send: (msg) => inbox.push(msg),
  };
  return { player, inbox };
}

describe('Lobby', () => {
  it('two players launch and see each other’s vessels', () => {
    const lobby = new Lobby('TEST');
    const a = makePlayer('pa');
    const b = makePlayer('pb');
    lobby.addPlayer(a.player);
    lobby.addPlayer(b.player);

    const resultA = lobby.launchVessel('pa', structuredClone(KARMAN_I_DESIGN));
    expect('error' in resultA).toBe(false);
    const resultB = lobby.launchVessel('pb', structuredClone(KARMAN_I_DESIGN));
    expect('error' in resultB).toBe(false);

    // both got vesselSpawned for both vessels
    expect(a.inbox.filter((m) => m.type === 'vesselSpawned').length).toBe(2);
    expect(b.inbox.filter((m) => m.type === 'vesselSpawned').length).toBe(2);
    expect(lobby.snapshots().length).toBe(2);
    // pad slots differ so the rockets don't overlap
    const [s1, s2] = lobby.snapshots();
    expect(s1!.motion.kind).toBe('physics');
    if (s1!.motion.kind === 'physics' && s2!.motion.kind === 'physics') {
      const [x1, y1] = s1!.motion.r;
      const [x2, y2] = s2!.motion.r;
      expect(Math.hypot(x1 - x2, y1 - y2)).toBeGreaterThan(50);
    }
  });

  it('rejects invalid crafts', () => {
    const lobby = new Lobby('TEST');
    const a = makePlayer('pa');
    lobby.addPlayer(a.player);
    const result = lobby.launchVessel('pa', { format: 1, name: 'junk', parts: [] });
    expect('error' in result).toBe(true);
  });

  it('routes commands to the owning vessel only', () => {
    const lobby = new Lobby('TEST');
    const a = makePlayer('pa');
    const b = makePlayer('pb');
    lobby.addPlayer(a.player);
    lobby.addPlayer(b.player);
    lobby.launchVessel('pa', structuredClone(KARMAN_I_DESIGN));
    lobby.launchVessel('pb', structuredClone(KARMAN_I_DESIGN));

    lobby.applyCommand('pa', { kind: 'throttle', value: 1 });
    const va = lobby.sim.getVessel(lobby.getPlayer('pa')!.vesselId!);
    const vb = lobby.sim.getVessel(lobby.getPlayer('pb')!.vesselId!);
    expect(va.throttle).toBe(1);
    expect(vb.throttle).toBe(0);
  });

  it('applies the min-rule for coordinated warp', () => {
    const lobby = new Lobby('TEST');
    const a = makePlayer('pa');
    const b = makePlayer('pb');
    lobby.addPlayer(a.player);
    lobby.addPlayer(b.player);
    lobby.launchVessel('pa', structuredClone(KARMAN_I_DESIGN));
    lobby.launchVessel('pb', structuredClone(KARMAN_I_DESIGN));

    // both landed (physics) → warp clamps to 4 regardless of requests
    lobby.requestWarp('pa', 1_000);
    expect(lobby.sim.warp).toBe(1); // min(1000, pb's default 1) = 1
    lobby.requestWarp('pb', 100_000);
    expect(lobby.sim.warp).toBe(4); // min-rule 1000, clamped by physics vessels

    // put both on rails → the full request goes through
    for (const p of ['pa', 'pb']) {
      const vessel = lobby.sim.getVessel(lobby.getPlayer(p)!.vesselId!);
      vessel.motion = {
        kind: 'rails',
        orbit: { bodyId: 'terra', a: 700_000, e: 0, i: 0, raan: 0, argPe: 0, m0: 0, epoch: 0 },
      };
    }
    lobby.requestWarp('pa', 1_000);
    expect(lobby.sim.warp).toBe(1_000);

    // a disconnecting player stops constraining warp
    lobby.requestWarp('pb', 15);
    expect(lobby.sim.warp).toBe(15);
    lobby.markDisconnected('pb');
    lobby.requestWarp('pa', 1_000);
    expect(lobby.sim.warp).toBe(1_000);
  });

  it('physics vessels get periodic state broadcasts', () => {
    const lobby = new Lobby('TEST');
    const a = makePlayer('pa');
    const b = makePlayer('pb');
    lobby.addPlayer(a.player);
    lobby.addPlayer(b.player);
    lobby.launchVessel('pa', structuredClone(KARMAN_I_DESIGN));
    b.inbox.length = 0;

    for (let i = 0; i < 20; i++) lobby.tick(0.02);
    const states = b.inbox.filter((m) => m.type === 'vesselState');
    expect(states.length).toBeGreaterThanOrEqual(2); // 5 Hz over 20 loops
  });
});
