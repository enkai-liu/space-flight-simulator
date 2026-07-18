import {
  compileCraft,
  craftStats,
  validateCraft,
  stackOf,
  sidePartsOn,
  isStackPart,
  migrateCraft,
  partsTouch,
  type CraftDesign,
  type LegacyCraftDesign,
  type CraftPart,
  type PartDef,
} from '@sfs/sim';
import { PARTS, PART_CATALOG, KARMAN_I_DESIGN } from '@sfs/data';
import {
  partIconSvg,
  partPath,
  partArt,
  shroudMarkup,
  SHROUD_TINT_SHIELD,
  SVG_DEFS,
} from './partSilhouette.js';

const SAVE_KEY = 'sfs.craft.v1';

/** placement grid, meters */
const GRID = 0.25;
/** capture radius for auto-connecting to a free attachment node, meters */
const SNAP_DIST = 0.7;
/** pixels of pointer travel before a press becomes a move instead of a select */
const CLICK_SLOP_PX = 5;

export interface BuilderCallbacks {
  onLaunch(design: CraftDesign): void;
  onHostLobby(design: CraftDesign, pilotName: string): void;
  onJoinLobby(design: CraftDesign, pilotName: string, code: string): void;
  /** returns the share code */
  onShareCraft(design: CraftDesign): Promise<string>;
  onLoadSharedCraft(code: string): Promise<CraftDesign>;
}

interface DragState {
  def: PartDef;
  /** existing part being moved (still in the design); null = new part from the palette */
  iid: number | null;
  /** DOM ghost for palette drags (canvas drags move the real part live) */
  ghost: HTMLElement | null;
  /** true once pointer travel exceeds the click slop */
  moved: boolean;
  startClientX: number;
  startClientY: number;
  /** world-space offset from the part origin to the grab point */
  grabDX: number;
  grabDY: number;
  /** parts that ride along (side parts / mirror twin), as offsets from the dragged part */
  followers: Array<{ iid: number; dx: number; dy: number }>;
  /** pre-drag state of every affected part, for reverting an invalid fin drop */
  before: Map<number, { x: number; y: number; host?: number }>;
  /** fins only: false while hovering with no stack part in reach */
  valid: boolean;
}

/**
 * The VAB: SFS-style 2.5D vertical-stack builder (plan §5.2). Rendered as SVG
 * inside the DOM — crisp silhouettes, native pointer events, no Three.js
 * state to manage. The craft re-renders wholesale on every mutation; crafts
 * are tiny so this is simpler and plenty fast.
 */
export class Builder {
  private readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly statsEl: HTMLElement;
  private readonly stagesEl: HTMLElement;
  private readonly issuesEl: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private design: CraftDesign;
  private nextIid = 1;
  private selectedIid: number | null = null;
  private drag: DragState | null = null;
  /** view height frozen during a canvas drag so the world doesn't rescale under the pointer */
  private dragViewH: number | null = null;
  /** swallow the synthetic click that follows a part press so it doesn't clear the selection */
  private suppressCanvasClick = false;

  constructor(container: HTMLElement, private readonly callbacks: BuilderCallbacks) {
    this.design = this.loadSaved() ?? structuredClone(KARMAN_I_DESIGN);
    this.nextIid = Math.max(0, ...this.design.parts.map((p) => p.iid)) + 1;

    this.root = document.createElement('div');
    this.root.className = 'builder';
    this.root.innerHTML = `
      <div class="builder-palette"></div>
      <div class="builder-canvas-wrap">
        <svg class="builder-canvas" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="builder-hint">drag parts anywhere · nearby parts snap together · tap to select</div>
      </div>
      <div class="builder-side">
        <input class="builder-name" maxlength="24" spellcheck="false" />
        <div class="builder-stats"></div>
        <div class="builder-issues"></div>
        <div class="builder-stages"></div>
        <div class="builder-actions">
          <button class="hud-btn" data-action="delete" disabled>DELETE</button>
          <button class="hud-btn" data-action="reset">STOCK</button>
          <button class="hud-btn" data-action="share">SHARE</button>
          <button class="hud-btn" data-action="load">LOAD CODE</button>
          <button class="hud-btn" data-action="clear">CLEAR</button>
          <button class="hud-btn builder-launch" data-action="launch">LAUNCH</button>
        </div>
        <div class="builder-online">
          <div class="online-title">MULTIPLAYER</div>
          <input class="pilot-name" maxlength="24" spellcheck="false" placeholder="pilot name" />
          <div class="online-row">
            <input class="lobby-code" maxlength="4" spellcheck="false" placeholder="CODE" />
            <button class="hud-btn" data-action="join">JOIN</button>
            <button class="hud-btn" data-action="host">HOST</button>
          </div>
          <div class="online-status"></div>
        </div>
      </div>`;
    container.appendChild(this.root);

    this.svg = this.root.querySelector('.builder-canvas')!;
    this.statsEl = this.root.querySelector('.builder-stats')!;
    this.stagesEl = this.root.querySelector('.builder-stages')!;
    this.issuesEl = this.root.querySelector('.builder-issues')!;
    this.nameInput = this.root.querySelector('.builder-name')!;
    this.nameInput.value = this.design.name;
    this.nameInput.addEventListener('input', () => {
      this.design.name = this.nameInput.value || 'Untitled';
      this.save();
    });

    // palette
    const palette = this.root.querySelector('.builder-palette')!;
    for (const def of PARTS) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.innerHTML = `${partIconSvg(def, 44)}<span>${def.title}</span>`;
      item.addEventListener('pointerdown', (e) => this.startDrag(def, e));
      palette.appendChild(item);
    }

    // actions
    this.root.querySelector('[data-action=delete]')!.addEventListener('click', () => this.deleteSelected());
    this.root.querySelector('[data-action=reset]')!.addEventListener('click', () => {
      this.design = structuredClone(KARMAN_I_DESIGN);
      this.nextIid = Math.max(0, ...this.design.parts.map((p) => p.iid)) + 1;
      this.nameInput.value = this.design.name;
      this.mutated();
    });
    this.root.querySelector('[data-action=clear]')!.addEventListener('click', () => {
      this.design = { format: 2, name: this.design.name, parts: [] };
      this.mutated();
    });
    this.root.querySelector('[data-action=launch]')!.addEventListener('click', () => {
      if (this.craftIsValid()) this.callbacks.onLaunch(structuredClone(this.design));
    });

    // --- craft sharing + multiplayer ---
    const status = this.root.querySelector<HTMLElement>('.online-status')!;
    const pilotInput = this.root.querySelector<HTMLInputElement>('.pilot-name')!;
    const codeInput = this.root.querySelector<HTMLInputElement>('.lobby-code')!;
    pilotInput.value = localStorage.getItem('sfs.pilot-name') ?? '';
    pilotInput.addEventListener('input', () => localStorage.setItem('sfs.pilot-name', pilotInput.value));

    this.root.querySelector('[data-action=share]')!.addEventListener('click', () => {
      if (!this.craftIsValid()) return;
      status.textContent = 'sharing…';
      this.callbacks
        .onShareCraft(structuredClone(this.design))
        .then((code) => {
          status.textContent = `craft code: ${code}`;
        })
        .catch(() => {
          status.textContent = 'share failed — is the server running?';
        });
    });
    this.root.querySelector('[data-action=load]')!.addEventListener('click', () => {
      const code = prompt('Enter craft code');
      if (!code) return;
      status.textContent = 'loading…';
      this.callbacks
        .onLoadSharedCraft(code.trim().toUpperCase())
        .then((loaded) => {
          const design = migrateCraft(loaded, PART_CATALOG);
          this.design = design;
          this.nextIid = Math.max(0, ...design.parts.map((p) => p.iid)) + 1;
          this.nameInput.value = design.name;
          status.textContent = `loaded "${design.name}"`;
          this.mutated();
        })
        .catch(() => {
          status.textContent = 'craft not found';
        });
    });
    this.root.querySelector('[data-action=host]')!.addEventListener('click', () => {
      if (this.craftIsValid()) {
        this.callbacks.onHostLobby(structuredClone(this.design), pilotInput.value || 'Pilot');
      }
    });
    this.root.querySelector('[data-action=join]')!.addEventListener('click', () => {
      const code = codeInput.value.trim().toUpperCase();
      if (code.length !== 4) {
        status.textContent = 'enter a 4-letter lobby code';
        return;
      }
      if (this.craftIsValid()) {
        this.callbacks.onJoinLobby(structuredClone(this.design), pilotInput.value || 'Pilot', code);
      }
    });

    // drag plumbing
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);

    // background tap clears selection (bound once — render() replaces innerHTML,
    // not the svg element itself)
    this.svg.addEventListener('click', () => {
      if (this.suppressCanvasClick) return;
      this.selectedIid = null;
      this.render();
    });

    this.render();
  }

  dispose(): void {
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    this.root.remove();
  }

  private craftIsValid(): boolean {
    const errors = validateCraft(this.design, PART_CATALOG).filter((i) => i.severity === 'error');
    if (errors.length > 0) return false;
    this.save();
    return true;
  }

  // ------------------------------------------------------------ persistence

  private loadSaved(): CraftDesign | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CraftDesign | LegacyCraftDesign;
      if ((parsed.format !== 1 && parsed.format !== 2) || !Array.isArray(parsed.parts)) return null;
      return migrateCraft(parsed, PART_CATALOG);
    } catch {
      return null;
    }
  }

  private save(): void {
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.design));
  }

  private mutated(): void {
    this.selectedIid = null;
    this.save();
    this.render();
  }

  // ------------------------------------------------------------ drag & drop

  private startDrag(def: PartDef, e: PointerEvent): void {
    e.preventDefault();
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = partIconSvg(def, 52);
    document.body.appendChild(ghost);
    this.drag = {
      def,
      iid: null,
      ghost,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      grabDX: 0,
      grabDY: 0,
      followers: [],
      before: new Map(),
      valid: true,
    };
    this.moveGhost(e);
  }

  /** Grab an existing part on the canvas: a short press selects, a drag moves it. */
  private startMovePart(iid: number, e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const part = this.design.parts.find((p) => p.iid === iid);
    if (!part) return;
    const def = PART_CATALOG.get(part.part);
    if (!def) return;

    const w = this.pointerToWorld(e, this.svg.getBoundingClientRect());
    const followers: DragState['followers'] = [];
    if (isStackPart(part)) {
      // side parts ride along with their host
      for (const s of sidePartsOn(this.design, part.iid)) {
        followers.push({ iid: s.iid, dx: s.x - part.x, dy: s.y - part.y });
      }
    } else {
      const twin = this.mirrorTwinOf(part);
      if (twin) followers.push({ iid: twin.iid, dx: twin.x - part.x, dy: twin.y - part.y });
    }
    const before = new Map<number, { x: number; y: number; host?: number }>();
    for (const p of [part, ...followers.map((f) => this.design.parts.find((q) => q.iid === f.iid)!)]) {
      before.set(p.iid, { x: p.x, y: p.y, host: p.host });
    }
    this.drag = {
      def,
      iid,
      ghost: null,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      grabDX: w.x - part.x,
      grabDY: w.y - part.y,
      followers,
      before,
      valid: true,
    };
  }

  private moveGhost(e: PointerEvent): void {
    if (!this.drag?.ghost) return;
    this.drag.ghost.style.left = `${e.clientX - 26}px`;
    this.drag.ghost.style.top = `${e.clientY - 26}px`;
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (this.drag.ghost) this.moveGhost(e);
    else this.movePart(e);
  };

  private movePart(e: PointerEvent): void {
    const d = this.drag!;
    const part = this.design.parts.find((p) => p.iid === d.iid);
    if (!part) return;
    if (!d.moved) {
      const travel = Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY);
      if (travel < CLICK_SLOP_PX) return;
      d.moved = true;
      this.dragViewH = this.viewHeight();
      this.selectedIid = part.iid;
    }
    const w = this.pointerToWorld(e, this.svg.getBoundingClientRect());
    if (d.def.attach.side) this.moveFin(d, part, w.x, w.y);
    else this.moveStackPart(d, part, w.x - d.grabDX, w.y - d.grabDY);
    this.render();
  }

  private moveStackPart(d: DragState, part: CraftPart, x: number, y: number): void {
    const exclude = new Set([part.iid, ...d.followers.map((f) => f.iid)]);
    const pos = this.snapStackPosition(d.def, x, y, exclude);
    part.x = pos.x;
    part.y = pos.y;
    for (const f of d.followers) {
      const p = this.design.parts.find((q) => q.iid === f.iid);
      if (p) {
        p.x = part.x + f.dx;
        p.y = part.y + f.dy;
      }
    }
  }

  private moveFin(d: DragState, fin: CraftPart, x: number, y: number): void {
    const twin = d.followers.length > 0
      ? this.design.parts.find((p) => p.iid === d.followers[0]!.iid)
      : undefined;
    const found = this.findFinHost(x, y);
    if (!found) {
      // no stack part in reach: float freely (reverted on release if still unhosted)
      d.valid = false;
      fin.x = Math.round((x - d.grabDX) / GRID) * GRID;
      fin.y = Math.max(0, Math.round((y - d.grabDY) / GRID) * GRID);
      return;
    }
    d.valid = true;
    const { host, hostDef } = found;
    const side = x >= host.x ? 1 : -1;
    const fy = this.clampFinY(y - d.grabDY, host, hostDef, d.def);
    fin.host = host.iid;
    fin.x = host.x + side * hostDef.shape.rBottom;
    fin.y = fy;
    if (twin) {
      twin.host = host.iid;
      twin.x = host.x - side * hostDef.shape.rBottom;
      twin.y = fy;
    }
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    this.drag = null;

    if (d.ghost) {
      // palette drop
      d.ghost.remove();
      const rect = this.svg.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        return; // dropped outside the assembly area
      }
      const world = this.pointerToWorld(e, rect);
      this.dropPart(d.def, world.x, world.y);
      return;
    }

    // canvas press/drag on an existing part
    this.dragViewH = null;
    this.swallowNextCanvasClick();
    if (!d.moved) {
      this.selectedIid = d.iid;
      this.render();
      return;
    }
    if (!d.valid) {
      // fin released with no host in reach — put it (and its twin) back
      for (const [iid, prev] of d.before) {
        const p = this.design.parts.find((q) => q.iid === iid);
        if (p) {
          p.x = prev.x;
          p.y = prev.y;
          p.host = prev.host;
        }
      }
    }
    this.save();
    this.render();
  };

  /** The click that follows a part press bubbles to the svg; keep it from clearing selection. */
  private swallowNextCanvasClick(): void {
    this.suppressCanvasClick = true;
    setTimeout(() => {
      this.suppressCanvasClick = false;
    }, 0);
  }

  // ------------------------------------------------------- placement helpers

  private stackWithDefs(): Array<{ part: CraftPart; def: PartDef }> {
    return stackOf(this.design)
      .filter((part) => PART_CATALOG.has(part.part))
      .map((part) => ({ part, def: PART_CATALOG.get(part.part)! }));
  }

  private viewHeight(): number {
    if (this.dragViewH !== null) return this.dragViewH;
    let top = 0;
    for (const p of this.design.parts) {
      const def = PART_CATALOG.get(p.part);
      if (def) top = Math.max(top, p.y + def.shape.height);
    }
    return Math.max(12, top + 5);
  }

  /**
   * Where a stack part of `def` with its origin (center x, bottom y) near
   * (x, y) should land: snapped onto the nearest free, compatible attachment
   * node when one is within SNAP_DIST (auto-connect), else grid-snapped in
   * place.
   */
  private snapStackPosition(
    def: PartDef,
    x: number,
    y: number,
    exclude: Set<number>,
  ): { x: number; y: number } {
    let best: { x: number; y: number; dist: number } | null = null;
    for (const { part: other, def: odef } of this.stackWithDefs()) {
      if (exclude.has(other.iid)) continue;
      const nodes = [
        { x: other.x, y: other.y + odef.shape.height, ok: odef.attach.top && def.attach.bottom },
        { x: other.x, y: other.y - def.shape.height, ok: odef.attach.bottom && def.attach.top },
      ];
      for (const node of nodes) {
        if (!node.ok || !this.spotFree(node.x, node.y, def, exclude)) continue;
        const dist = Math.hypot(x - node.x, y - node.y);
        if (dist < SNAP_DIST && (best === null || dist < best.dist)) {
          best = { x: node.x, y: node.y, dist };
        }
      }
    }
    if (best) return { x: best.x, y: best.y };
    return { x: Math.round(x / GRID) * GRID, y: Math.max(0, Math.round(y / GRID) * GRID) };
  }

  /** True when no other stack part already occupies the span a `def`-sized part would fill. */
  private spotFree(x: number, y: number, def: PartDef, exclude: Set<number>): boolean {
    return !this.stackWithDefs().some(
      ({ part: o, def: odef }) =>
        !exclude.has(o.iid) &&
        Math.abs(o.x - x) < 0.5 &&
        o.y < y + def.shape.height - 0.01 &&
        o.y + odef.shape.height > y + 0.01,
    );
  }

  /** Nearest stack part whose flank a fin at (x, y) can grab, or null. */
  private findFinHost(x: number, y: number): { host: CraftPart; hostDef: PartDef } | null {
    let best: { host: CraftPart; hostDef: PartDef; dx: number } | null = null;
    for (const { part: o, def: odef } of this.stackWithDefs()) {
      if (y < o.y - 0.3 || y > o.y + odef.shape.height + 0.3) continue;
      const dx = Math.abs(x - o.x);
      if (dx > odef.shape.rBottom + 1.2) continue;
      if (best === null || dx < best.dx) best = { host: o, hostDef: odef, dx };
    }
    return best;
  }

  /** Grid-snap a fin's bottom y, kept within its host's flank. */
  private clampFinY(y: number, host: CraftPart, hostDef: PartDef, finDef: PartDef): number {
    const snapped = Math.round(y / GRID) * GRID;
    const maxY = host.y + Math.max(0, hostDef.shape.height - finDef.shape.height);
    return Math.min(Math.max(snapped, host.y), maxY);
  }

  /** A fin's mirror partner: same part type on the same host, opposite flank. */
  private mirrorTwinOf(fin: CraftPart): CraftPart | undefined {
    const hostX = this.design.parts.find((p) => p.iid === fin.host)?.x ?? 0;
    return this.design.parts.find(
      (p) =>
        p.iid !== fin.iid &&
        p.part === fin.part &&
        p.host === fin.host &&
        Math.abs(p.x + fin.x - 2 * hostX) < 0.05,
    );
  }

  private pointerToWorld(e: PointerEvent, rect: DOMRect): { x: number; y: number } {
    const H = this.viewHeight();
    const W = (H * rect.width) / rect.height;
    return {
      x: ((e.clientX - rect.left) / rect.width) * W - W / 2,
      y: (1 - (e.clientY - rect.top) / rect.height) * H - 1.5, // 1.5 m ground margin
    };
  }

  private dropPart(def: PartDef, x: number, y: number): void {
    if (def.attach.side) {
      // fins must land on a stack part's flank; mirror symmetry places both
      // sides at once (plan §5.2)
      const found = this.findFinHost(x, y);
      if (!found) return;
      const { host, hostDef } = found;
      const side = x >= host.x ? 1 : -1;
      const fy = this.clampFinY(y - def.shape.height / 2, host, hostDef, def);
      this.design.parts.push(
        { iid: this.nextIid++, part: def.id, x: host.x + side * hostDef.shape.rBottom, y: fy, host: host.iid },
        { iid: this.nextIid++, part: def.id, x: host.x - side * hostDef.shape.rBottom, y: fy, host: host.iid },
      );
      this.mutated();
      return;
    }

    // stack part: the ghost is grabbed at its center, so its bottom is half a
    // part below the pointer; auto-connect to a nearby free node, else grid
    const pos = this.snapStackPosition(def, x, y - def.shape.height / 2, new Set());
    this.design.parts.push({ iid: this.nextIid++, part: def.id, x: pos.x, y: pos.y });
    this.mutated();
  }

  private deleteSelected(): void {
    if (this.selectedIid === null) return;
    const target = this.design.parts.find((p) => p.iid === this.selectedIid);
    if (!target) return;
    const removed = new Set<number>([target.iid]);
    if (isStackPart(target)) {
      // removing a stack part also removes its side parts
      for (const side of sidePartsOn(this.design, target.iid)) removed.add(side.iid);
    } else {
      // removing a fin removes its mirror twin on the same host
      const twin = this.mirrorTwinOf(target);
      if (twin) removed.add(twin.iid);
    }
    // everything else stays exactly where it is
    this.design.parts = this.design.parts.filter((p) => !removed.has(p.iid));
    this.mutated();
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const H = this.viewHeight();
    const rect = this.svg.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 0.8;
    const W = H * aspect;
    this.svg.setAttribute('viewBox', `${-W / 2} ${-H + 1.5} ${W} ${H}`);

    let markup = SVG_DEFS + `<g transform="scale(1,-1)">`;
    // launch pad ground line
    markup += `<rect x="${-W / 2}" y="-1.55" width="${W}" height="0.12" fill="#3d4a3a"/>`;

    const stack = this.stackWithDefs();
    const stackX = new Map(stack.map(({ part }) => [part.iid, part.x]));
    for (const { part, def } of stack) {
      markup += this.partMarkup(part, def, part.x, part.y);
    }
    for (const side of this.design.parts) {
      if (isStackPart(side)) continue;
      const def = PART_CATALOG.get(side.part);
      if (!def) continue;
      markup += this.partMarkup(side, def, side.x, side.y, side.x < (stackX.get(side.host!) ?? 0));
    }
    // interstage fairings: an engine or heat shield sitting on a decoupler is
    // shrouded, so neither is exposed mid-stack (drawn last, over the part);
    // heat-shield covers are gold to match the shield and decoupler
    for (let i = 1; i < stack.length; i++) {
      const { part, def } = stack[i]!;
      const below = stack[i - 1]!;
      if (below.def.category !== 'decoupler') continue;
      if (!partsTouch(below.part, below.def, part)) continue;
      const y1 = part.y + def.shape.height;
      const shroud =
        def.category === 'engine'
          ? shroudMarkup(below.def.shape.rTop, part.y, y1)
          : def.category === 'heatshield'
            ? shroudMarkup(below.def.shape.rTop, part.y, y1, SHROUD_TINT_SHIELD)
            : '';
      if (shroud) markup += `<g transform="translate(${part.x} 0)">${shroud}</g>`;
    }
    markup += `</g>`;
    this.svg.innerHTML = markup;

    // part grab handlers: press-and-release selects, press-and-drag moves
    for (const el of this.svg.querySelectorAll<SVGElement>('[data-iid]')) {
      el.addEventListener('pointerdown', (e) =>
        this.startMovePart(Number(el.dataset.iid), e as PointerEvent),
      );
    }
    const deleteBtn = this.root.querySelector<HTMLButtonElement>('[data-action=delete]')!;
    deleteBtn.disabled = this.selectedIid === null;

    this.renderPanel();
  }

  private partMarkup(part: CraftPart, def: PartDef, x: number, y: number, mirror = false): string {
    const selected = part.iid === this.selectedIid;
    const transform = `translate(${x} ${y})${mirror ? ' scale(-1,1)' : ''}`;
    return (
      `<g data-iid="${part.iid}" transform="${transform}" class="craft-part${selected ? ' selected' : ''}">` +
      partArt(def) +
      // transparent copy of the outline: hit region + selection highlight
      `<path d="${partPath(def)}" fill="transparent" stroke="${selected ? '#7ec8ff' : 'none'}" stroke-width="0.09" stroke-linejoin="round"/>` +
      `</g>`
    );
  }

  private renderPanel(): void {
    const issues = validateCraft(this.design, PART_CATALOG);
    const errors = issues.filter((i) => i.severity === 'error');
    this.issuesEl.innerHTML = issues
      .map((i) => `<div class="issue issue-${i.severity}">${i.message}</div>`)
      .join('');
    this.root.querySelector<HTMLButtonElement>('[data-action=launch]')!.disabled = errors.length > 0;

    if (errors.length > 0) {
      this.statsEl.textContent = '';
      this.stagesEl.textContent = '';
      return;
    }
    const config = compileCraft(this.design, PART_CATALOG);
    const stats = craftStats(config, 9.81);
    this.statsEl.innerHTML =
      `<div>mass <b>${(stats.launchMass / 1000).toFixed(1)} t</b></div>` +
      `<div>TWR <b class="${stats.twr < 1 ? 'bad' : ''}">${stats.twr.toFixed(2)}</b></div>` +
      `<div>Δv <b>${stats.totalDeltaV.toFixed(0)} m/s</b></div>`;
    this.stagesEl.innerHTML = config.stages
      .map(
        (s, i) =>
          `<div class="stage-row">S${i + 1} · ${(s.thrust / 1000).toFixed(0)} kN · ` +
          `${s.fuelMass.toFixed(0)} kg fuel · Δv ${stats.deltaVPerStage[i]!.toFixed(0)}</div>`,
      )
      .join('');
  }
}
