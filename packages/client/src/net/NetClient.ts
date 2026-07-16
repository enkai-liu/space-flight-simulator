import { encode, decodeServer, type ClientMessage, type ServerMessage } from '@sfs/protocol';

/**
 * Thin WebSocket wrapper: connect + hello handshake, message dispatch, and
 * exponential-backoff auto-reconnect (plan §6.3). The same device token is
 * reused across reconnects so the server resumes our seat.
 */
export class NetClient {
  private socket: WebSocket | null = null;
  private listeners: Array<(msg: ServerMessage) => void> = [];
  private closed = false;
  private backoff = 500;
  playerId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly name: string,
    private readonly onReconnect?: () => void,
  ) {}

  /** Resolves once the server has acknowledged hello. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const failTimer = setTimeout(() => {
        socket.close();
        reject(new Error('connection timeout'));
      }, 5000);

      socket.onopen = () => {
        socket.send(encode({ type: 'hello', token: this.token, name: this.name }));
      };
      socket.onmessage = (e) => {
        const msg = decodeServer(String(e.data));
        if (!msg) return;
        if (msg.type === 'welcome') {
          clearTimeout(failTimer);
          this.playerId = msg.playerId;
          this.backoff = 500;
          resolve();
        }
        for (const listener of this.listeners) listener(msg);
      };
      socket.onclose = () => {
        clearTimeout(failTimer);
        if (this.closed) return;
        setTimeout(() => {
          if (this.closed) return;
          this.connect()
            .then(() => this.onReconnect?.())
            .catch(() => undefined); // next onclose schedules another attempt
        }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      };
      socket.onerror = () => socket.close();
    });
  }

  onMessage(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode(msg));
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}

/** Stable anonymous device token (plan §6.4). */
export function deviceToken(): string {
  const KEY = 'sfs.device-token';
  let token = localStorage.getItem(KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(KEY, token);
  }
  return token;
}

export function defaultServerUrl(): { ws: string; http: string } {
  const override = new URLSearchParams(location.search).get('server');
  const host = override ?? `${location.hostname}:8081`;
  return { ws: `ws://${host}`, http: `http://${host}` };
}
