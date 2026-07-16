import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeClient, encode, type ServerMessage } from '@sfs/protocol';
import { validateCraft, type CraftDesign } from '@sfs/sim';
import { PART_CATALOG } from '@sfs/data';
import { Lobby } from './Lobby.js';
import { Store } from './store.js';

const PORT = Number(process.env.PORT ?? 8081);
const STORE_FILE = process.env.SFS_STORE ?? new URL('../data/store.json', import.meta.url).pathname;

const store = new Store(STORE_FILE);
const lobbies = new Map<string, Lobby>();

const LOBBY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newLobbyCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => LOBBY_ALPHABET[Math.floor(Math.random() * LOBBY_ALPHABET.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

// ------------------------------------------------------------- HTTP (crafts)

const http = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'POST' && req.url === '/crafts') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 256_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const design = JSON.parse(body) as CraftDesign;
        const errors = validateCraft(design, PART_CATALOG).filter((i) => i.severity === 'error');
        if (errors.length > 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: errors[0]!.message }));
          return;
        }
        const code = store.saveCraft(design, 'anon');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code }));
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }

  const craftMatch = req.url?.match(/^\/crafts\/([A-Za-z0-9]{4,8})$/);
  if (req.method === 'GET' && craftMatch) {
    const design = store.getCraft(craftMatch[1]!);
    if (!design) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(design));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('sfs server up\n');
});

// --------------------------------------------------------------- WebSockets

const wss = new WebSocketServer({ server: http });

interface Session {
  playerId: string | null;
  name: string;
  lobby: Lobby | null;
}

wss.on('connection', (socket: WebSocket) => {
  const session: Session = { playerId: null, name: '', lobby: null };
  const send = (msg: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(encode(msg));
  };

  socket.on('message', (raw: Buffer) => {
    const msg = decodeClient(raw.toString());
    if (!msg) return;

    if (msg.type === 'hello') {
      const user = store.userForToken(msg.token, msg.name.slice(0, 24) || 'Pilot');
      session.playerId = user.id;
      session.name = user.name;
      send({ type: 'welcome', playerId: user.id });
      return;
    }
    if (!session.playerId) {
      send({ type: 'error', message: 'say hello first' });
      return;
    }

    switch (msg.type) {
      case 'createLobby':
      case 'joinLobby': {
        const code = msg.type === 'createLobby' ? newLobbyCode() : msg.code.toUpperCase();
        let lobby = lobbies.get(code);
        if (!lobby) {
          if (msg.type === 'joinLobby') {
            send({ type: 'error', message: `no lobby ${code}` });
            return;
          }
          lobby = new Lobby(code);
          lobbies.set(code, lobby);
        }
        session.lobby?.markDisconnected(session.playerId);
        session.lobby = lobby;
        lobby.addPlayer({
          id: session.playerId,
          name: session.name,
          vesselId: lobby.getPlayer(session.playerId)?.vesselId ?? null,
          requestedWarp: 1,
          connected: true,
          disconnectedAt: 0,
          send,
        });
        send({
          type: 'lobbyJoined',
          code,
          simTime: lobby.sim.simTime,
          warp: lobby.sim.warp,
          players: lobby.playerInfos(),
          vessels: lobby.snapshots(),
        });
        return;
      }
      case 'leaveLobby':
        session.lobby?.markDisconnected(session.playerId);
        session.lobby = null;
        return;
      case 'launchVessel': {
        if (!session.lobby) return;
        const result = session.lobby.launchVessel(session.playerId, msg.craft);
        if ('error' in result) send({ type: 'error', message: result.error });
        return;
      }
      case 'command':
        session.lobby?.applyCommand(session.playerId, msg.cmd);
        return;
      case 'requestWarp':
        session.lobby?.requestWarp(session.playerId, msg.factor);
        return;
      case 'ping':
        send({ type: 'pong', t: msg.t });
        return;
    }
  });

  socket.on('close', () => {
    if (session.playerId && session.lobby) session.lobby.markDisconnected(session.playerId);
  });
});

// ------------------------------------------------------------------ tick loop

let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - lastTick) / 1000, 0.25);
  lastTick = now;
  for (const [code, lobby] of lobbies) {
    lobby.tick(dt);
    if (lobby.reap()) lobbies.delete(code);
  }
}, 20);

http.listen(PORT, () => {
  console.log(`sfs server listening on :${PORT}`);
});
