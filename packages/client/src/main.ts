import type { CraftDesign } from '@sfs/sim';
import { Builder } from './builder/Builder.js';
import { startFlight, type FlightScreen, type NetContext } from './screens/flight.js';
import { NetClient, deviceToken, defaultServerUrl } from './net/NetClient.js';

/**
 * Screen router: the builder is the home screen; LAUNCH switches to flight
 * (solo or online), VAB/restart comes back. Each screen owns its DOM.
 */
const app = document.getElementById('app')!;

let current: { dispose(): void } | null = null;
let activeNet: NetClient | null = null;

function showBuilder(): void {
  current?.dispose();
  activeNet?.close();
  activeNet = null;

  current = new Builder(app, {
    onLaunch(design: CraftDesign) {
      showFlight(design);
    },
    onHostLobby(design, pilotName) {
      void connectAndFly(design, pilotName, { type: 'createLobby' });
    },
    onJoinLobby(design, pilotName, code) {
      void connectAndFly(design, pilotName, { type: 'joinLobby', code });
    },
    async onShareCraft(design) {
      const res = await fetch(`${defaultServerUrl().http}/crafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(design),
      });
      if (!res.ok) throw new Error('share failed');
      const { code } = (await res.json()) as { code: string };
      return code;
    },
    async onLoadSharedCraft(code) {
      const res = await fetch(`${defaultServerUrl().http}/crafts/${code}`);
      if (!res.ok) throw new Error('not found');
      return (await res.json()) as CraftDesign;
    },
  });
}

async function connectAndFly(
  design: CraftDesign,
  pilotName: string,
  join: NetContext['join'],
): Promise<void> {
  const status = document.querySelector<HTMLElement>('.online-status');
  if (status) status.textContent = 'connecting…';
  try {
    const client = new NetClient(defaultServerUrl().ws, deviceToken(), pilotName);
    await client.connect();
    activeNet = client;
    showFlight(design, { client, join });
  } catch {
    if (status) status.textContent = 'could not reach the server';
  }
}

function showFlight(design: CraftDesign, net?: NetContext): void {
  current?.dispose();
  const flight: FlightScreen = startFlight(app, design, { onExit: () => showBuilder() }, net);
  current = flight;
}

showBuilder();
