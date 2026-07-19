/**
 * Flight HUD: plain DOM overlay on the canvas (plan §2 — no framework).
 * Touch-first: hold-to-rotate buttons, a fat vertical throttle slider,
 * big stage/map buttons.
 */

export interface HudCallbacks {
  onThrottle(value: number): void;
  onTurnInput(value: number): void;
  onStage(): void;
  onEngineToggle(iid: number, on: boolean): void;
  onToggleMap(): void;
  onRestart(): void;
  onWarpStep(direction: 1 | -1): void;
  onExitToBuilder(): void;
}

export interface EngineReadout {
  iid: number;
  title: string;
  on: boolean;
  hasFuel: boolean;
  stageIndex: number;
}

export interface HudReadout {
  altitude: number;
  surfaceSpeed: number;
  speed: number;
  apoapsis: number;
  periapsis: number;
  fuel: number;
  fuelCapacity: number;
  engines: EngineReadout[];
  stagesLeft: number;
  landed: boolean;
  onRails: boolean;
  destroyed: boolean;
  heatFraction: number;
  chuteDeployed: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function fmtKm(m: number): string {
  if (Math.abs(m) >= 1_000_000) return `${(m / 1_000_000).toFixed(2)} Mm`;
  if (Math.abs(m) >= 1_000) return `${(m / 1_000).toFixed(1)} km`;
  return `${m.toFixed(0)} m`;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly values = new Map<string, HTMLElement>();
  private readonly throttleFill: HTMLElement;
  private readonly fuelFill: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly crashOverlay: HTMLElement;
  private recoveredOverlay!: HTMLElement;
  private heatRow!: HTMLElement;
  private heatFill!: HTMLElement;
  private readonly mapButton: HTMLElement;
  private readonly enginePanel: HTMLElement;
  private readonly callbacks: HudCallbacks;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private throttleValue = 0;
  /** last rendered engine list — rebuilt only when it actually changes */
  private engines: EngineReadout[] = [];
  private engineSig = '';

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.root = el('div', 'hud', document.body);

    // --- readouts (top left) ---
    const readouts = el('div', 'readouts', this.root);
    for (const [key, label] of [
      ['alt', 'ALT'],
      ['spd', 'SPD'],
      ['apo', 'APO'],
      ['per', 'PER'],
    ] as const) {
      const row = el('div', 'readout-row', readouts);
      el('span', 'readout-label', row, label);
      this.values.set(key, el('span', 'readout-value', row, '—'));
      this.values.get(key)!.dataset.testid = key;
    }
    this.values.set('status', el('div', 'status-line', readouts, 'LANDED'));
    this.values.get('status')!.dataset.testid = 'status';

    // --- map toggle + builder exit (top right) ---
    this.mapButton = el('button', 'hud-btn map-btn', this.root, 'MAP');
    this.mapButton.addEventListener('click', () => callbacks.onToggleMap());
    const vabButton = el('button', 'hud-btn vab-btn', this.root, 'VAB');
    vabButton.addEventListener('click', () => callbacks.onExitToBuilder());

    // --- time-warp control (top center) ---
    const warpWrap = el('div', 'warp-wrap', this.root);
    const warpDown = el('button', 'hud-btn warp-btn', warpWrap, '◄◄');
    const warpDisplay = el('div', 'warp-display', warpWrap);
    this.values.set('warp', warpDisplay);
    warpDisplay.dataset.testid = 'warp';
    const warpUp = el('button', 'hud-btn warp-btn', warpWrap, '►►');
    this.values.set('clock', el('div', 'warp-clock', warpWrap, 'T+0s'));
    warpDown.addEventListener('click', () => callbacks.onWarpStep(-1));
    warpUp.addEventListener('click', () => callbacks.onWarpStep(1));

    // --- throttle (right edge) ---
    const throttleWrap = el('div', 'throttle-wrap', this.root);
    el('div', 'throttle-title', throttleWrap, 'THR');
    const track = el('div', 'throttle-track', throttleWrap);
    this.throttleFill = el('div', 'throttle-fill', track);
    const setFromPointer = (e: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const frac = 1 - (e.clientY - rect.top) / rect.height;
      this.throttleValue = Math.min(1, Math.max(0, frac));
      callbacks.onThrottle(this.throttleValue);
    };
    track.addEventListener('pointerdown', (e) => {
      track.setPointerCapture(e.pointerId);
      setFromPointer(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (track.hasPointerCapture(e.pointerId)) setFromPointer(e);
    });
    const fuelBar = el('div', 'fuel-track', throttleWrap);
    this.fuelFill = el('div', 'fuel-fill', fuelBar);
    el('div', 'throttle-title', throttleWrap, 'FUEL');

    // --- stage button (bottom right) ---
    const stageBtn = el('button', 'hud-btn stage-btn', this.root, 'STAGE');
    stageBtn.addEventListener('click', () => callbacks.onStage());

    // --- engine switch panel (bottom center) ---
    this.enginePanel = el('div', 'engine-wrap', this.root);

    // --- rotation controls (bottom left) ---
    const rotWrap = el('div', 'rot-wrap', this.root);
    for (const [label, value] of [
      ['◀', 1],
      ['▶', -1],
    ] as const) {
      const btn = el('button', 'hud-btn rot-btn', rotWrap, label);
      btn.addEventListener('pointerdown', (e) => {
        btn.setPointerCapture(e.pointerId);
        callbacks.onTurnInput(value);
      });
      const stop = () => callbacks.onTurnInput(0);
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
    }

    // --- heat warning bar ---
    const heatRow = el('div', 'heat-row', this.root);
    el('span', 'readout-label', heatRow, 'HEAT');
    this.heatFill = el('div', 'heat-fill', el('div', 'heat-track', heatRow));
    this.heatRow = heatRow;

    // --- toast + end-state overlays ---
    this.toast = el('div', 'toast', this.root);
    this.crashOverlay = el('div', 'crash-overlay', this.root);
    el('div', 'crash-title', this.crashOverlay, 'VEHICLE DESTROYED');
    const restart = el('button', 'hud-btn restart-btn', this.crashOverlay, 'BACK TO VAB');
    restart.addEventListener('click', () => callbacks.onRestart());

    this.recoveredOverlay = el('div', 'crash-overlay recovered-overlay', this.root);
    el('div', 'crash-title recovered-title', this.recoveredOverlay, 'VESSEL RECOVERED');
    const recover = el('button', 'hud-btn restart-btn', this.recoveredOverlay, 'BACK TO VAB');
    recover.addEventListener('click', () => callbacks.onExitToBuilder());

    // --- keyboard (desktop dev convenience) ---
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === 'a' || e.key === 'ArrowLeft') callbacks.onTurnInput(1);
      if (e.key === 'd' || e.key === 'ArrowRight') callbacks.onTurnInput(-1);
      if (e.key === 'w' || e.key === 'ArrowUp') this.nudgeThrottle(callbacks, 0.1);
      if (e.key === 's' || e.key === 'ArrowDown') this.nudgeThrottle(callbacks, -0.1);
      if (e.key === 'z') this.nudgeThrottle(callbacks, 1);
      if (e.key === 'x') this.nudgeThrottle(callbacks, -1);
      if (e.key >= '1' && e.key <= '9') {
        const engine = this.engines[Number(e.key) - 1];
        if (engine) callbacks.onEngineToggle(engine.iid, !engine.on);
      }
      if (e.key === ' ') callbacks.onStage();
      if (e.key === 'm') callbacks.onToggleMap();
      if (e.key === '.') callbacks.onWarpStep(1);
      if (e.key === ',') callbacks.onWarpStep(-1);
    };
    this.onKeyUp = (e: KeyboardEvent) => {
      if (['a', 'd', 'ArrowLeft', 'ArrowRight'].includes(e.key)) callbacks.onTurnInput(0);
    };
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
  }

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;

  dispose(): void {
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.root.remove();
  }

  private nudgeThrottle(callbacks: HudCallbacks, delta: number): void {
    this.throttleValue = Math.min(1, Math.max(0, this.throttleValue + delta));
    callbacks.onThrottle(this.throttleValue);
  }

  showToast(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('visible'), 2500);
  }

  setMapActive(active: boolean): void {
    this.mapButton.textContent = active ? 'SHIP' : 'MAP';
  }

  /** Warp indicator + mission clock (called every frame from the game loop). */
  updateTime(warp: number, simTime: number): void {
    this.values.get('warp')!.textContent = `×${warp >= 1000 ? warp.toLocaleString('en-US') : warp}`;
    const t = Math.floor(simTime);
    const d = Math.floor(t / 21_600); // 6-hour Terra days
    const h = Math.floor((t % 21_600) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    this.values.get('clock')!.textContent =
      d > 0 ? `T+${d}d ${h}h ${m}m` : h > 0 ? `T+${h}h ${m}m ${s}s` : `T+${m}m ${s}s`;
  }

  update(readout: HudReadout): void {
    this.values.get('alt')!.textContent = fmtKm(readout.altitude);
    this.values.get('spd')!.textContent = `${readout.surfaceSpeed.toFixed(0)} m/s`;
    this.values.get('apo')!.textContent = fmtKm(readout.apoapsis);
    this.values.get('per')!.textContent = readout.periapsis > 0 ? fmtKm(readout.periapsis) : '—';
    this.values.get('status')!.textContent = readout.destroyed
      ? 'DESTROYED'
      : readout.landed
        ? 'LANDED'
        : readout.onRails
          ? 'ORBIT'
          : 'FLIGHT';

    this.throttleFill.style.height = `${this.throttleValue * 100}%`;
    const fuelFrac = readout.fuelCapacity > 0 ? readout.fuel / readout.fuelCapacity : 0;
    this.fuelFill.style.height = `${fuelFrac * 100}%`;
    this.updateEngines(readout.engines);

    const heat = Math.min(1, readout.heatFraction);
    this.heatRow.classList.toggle('visible', heat > 0.05);
    this.heatFill.style.width = `${heat * 100}%`;
    this.heatFill.classList.toggle('critical', heat > 0.75);

    this.crashOverlay.classList.toggle('visible', readout.destroyed);
  }

  showRecovered(): void {
    this.recoveredOverlay.classList.add('visible');
  }

  /** Rebuild the engine switch chips only when the engine set/state changes. */
  private updateEngines(engines: EngineReadout[]): void {
    const sig = engines
      .map((e) => `${e.iid}:${e.on ? 1 : 0}:${e.hasFuel ? 1 : 0}:${e.stageIndex}`)
      .join('|');
    if (sig === this.engineSig) return;
    this.engineSig = sig;
    this.engines = engines;

    this.enginePanel.replaceChildren();
    this.enginePanel.classList.toggle('visible', engines.length > 0);
    engines.forEach((engine, index) => {
      const chip = el('button', 'engine-chip', this.enginePanel);
      chip.classList.toggle('on', engine.on);
      chip.classList.toggle('no-fuel', !engine.hasFuel);
      chip.dataset.testid = `engine-${engine.iid}`;
      const head = el('div', 'engine-head', chip);
      el('span', 'engine-dot', head);
      if (index < 9) el('span', 'engine-key', head, `${index + 1}`);
      el('div', 'engine-name', chip, engine.title.toUpperCase());
      el(
        'div',
        'engine-meta',
        chip,
        !engine.hasFuel ? 'NO FUEL' : engine.on ? 'ON' : 'OFF',
      );
      chip.addEventListener('click', () => this.callbacks.onEngineToggle(engine.iid, !engine.on));
    });
  }
}
