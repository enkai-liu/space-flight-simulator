import {
  compileCraft,
  craftStats,
  validateCraft,
  stackOf,
  sidePartsOn,
  type CraftDesign,
  type CraftPart,
  type PartDef,
} from '@sfs/sim';
import { PARTS, PART_CATALOG, KARMAN_I_DESIGN } from '@sfs/data';
import { partIconSvg, partPath, partArt, shroudMarkup, SVG_DEFS } from './partSilhouette.js';

const SAVE_KEY = 'sfs.craft.v1';

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
  /** iid when re-dragging an existing part (already removed from the craft) */
  ghost: HTMLElement;
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

  constructor(container: HTMLElement, private readonly callbacks: BuilderCallbacks) {
    this.design = this.loadSaved() ?? structuredClone(KARMAN_I_DESIGN);
    this.nextIid = Math.max(0, ...this.design.parts.map((p) => p.iid)) + 1;

    this.root = document.createElement('div');
    this.root.className = 'builder';
    this.root.innerHTML = `
      <div class="builder-palette"></div>
      <div class="builder-canvas-wrap">
        <svg class="builder-canvas" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="builder-hint">tap a part to select · drag from the palette to add</div>
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
      this.design = { format: 1, name: this.design.name, parts: [] };
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
        .then((design) => {
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
      const parsed = JSON.parse(raw) as CraftDesign;
      if (parsed.format !== 1 || !Array.isArray(parsed.parts)) return null;
      return parsed;
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
    this.drag = { def, ghost };
    this.moveGhost(e);
  }

  private moveGhost(e: PointerEvent): void {
    if (!this.drag) return;
    this.drag.ghost.style.left = `${e.clientX - 26}px`;
    this.drag.ghost.style.top = `${e.clientY - 26}px`;
  }

  private readonly onPointerMove = (e: PointerEvent): void => this.moveGhost(e);

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    const { def, ghost } = this.drag;
    ghost.remove();
    this.drag = null;

    const rect = this.svg.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      return; // dropped outside the assembly area
    }
    const world = this.pointerToWorld(e, rect);
    this.dropPart(def, world.x, world.y);
  };

  /** Current stack layout: iid → [yBottom, yTop] in meters. */
  private stackLayout(): Array<{ part: CraftPart; def: PartDef; y0: number; y1: number }> {
    const out: Array<{ part: CraftPart; def: PartDef; y0: number; y1: number }> = [];
    let y = 0;
    for (const part of stackOf(this.design)) {
      const def = PART_CATALOG.get(part.part)!;
      out.push({ part, def, y0: y, y1: y + def.shape.height });
      y += def.shape.height;
    }
    return out;
  }

  private viewHeight(): number {
    const layout = this.stackLayout();
    const top = layout.length > 0 ? layout[layout.length - 1]!.y1 : 0;
    return Math.max(12, top + 5);
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
    const layout = this.stackLayout();

    if (def.attach.side) {
      // fins attach to whichever stack part the drop height intersects
      const host = layout.find((l) => y >= l.y0 && y <= l.y1) ?? layout[0];
      if (!host) return;
      const side = x >= 0 ? 1 : -1;
      // mirror symmetry: place both sides at once (plan §5.2)
      this.design.parts.push(
        { iid: this.nextIid++, part: def.id, x: side, y: host.part.iid },
        { iid: this.nextIid++, part: def.id, x: -side, y: host.part.iid },
      );
      this.mutated();
      return;
    }

    // stack part: insert at the gap nearest the drop height
    let index = layout.length;
    for (let i = 0; i < layout.length; i++) {
      const mid = (layout[i]!.y0 + layout[i]!.y1) / 2;
      if (y < mid) {
        index = i;
        break;
      }
    }
    const stack = stackOf(this.design);
    // shift stack ordinals at/above the insertion point
    for (const p of stack) {
      if (p.y >= index) p.y += 1;
    }
    this.design.parts.push({ iid: this.nextIid++, part: def.id, x: 0, y: index });
    this.mutated();
  }

  private deleteSelected(): void {
    if (this.selectedIid === null) return;
    const target = this.design.parts.find((p) => p.iid === this.selectedIid);
    if (!target) return;
    const removed = new Set<number>([target.iid]);
    if (target.x === 0) {
      // removing a stack part also removes its side parts
      for (const side of sidePartsOn(this.design, target.iid)) removed.add(side.iid);
    } else {
      // removing a fin removes its mirror twin on the same host
      const twin = this.design.parts.find(
        (p) => !removed.has(p.iid) && p.part === target.part && p.x === -target.x && p.y === target.y,
      );
      if (twin) removed.add(twin.iid);
    }
    this.design.parts = this.design.parts.filter((p) => !removed.has(p.iid));
    // re-pack stack ordinals
    stackOf(this.design).forEach((p, i) => {
      p.y = i;
    });
    this.mutated();
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const layout = this.stackLayout();
    const H = this.viewHeight();
    const rect = this.svg.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 0.8;
    const W = H * aspect;
    this.svg.setAttribute('viewBox', `${-W / 2} ${-H + 1.5} ${W} ${H}`);

    let markup = SVG_DEFS + `<g transform="scale(1,-1)">`;
    // launch pad ground line
    markup += `<rect x="${-W / 2}" y="-1.55" width="${W}" height="0.12" fill="#3d4a3a"/>`;

    for (const { part, def, y0 } of layout) {
      markup += this.partMarkup(part, def, 0, y0);
      for (const side of sidePartsOn(this.design, part.iid)) {
        const sideDef = PART_CATALOG.get(side.part)!;
        const xOff = side.x * def.shape.rBottom;
        markup += this.partMarkup(side, sideDef, xOff, y0, side.x < 0);
      }
    }
    // interstage fairings: an engine sitting on a decoupler is shrouded, so
    // second-stage engines aren't exposed mid-stack (drawn last, over the part)
    for (let i = 1; i < layout.length; i++) {
      const { def, y0, y1 } = layout[i]!;
      const below = layout[i - 1]!;
      if (def.category === 'engine' && below.def.category === 'decoupler') {
        markup += shroudMarkup(below.def.shape.rTop, y0, y1);
      }
    }
    markup += `</g>`;
    this.svg.innerHTML = markup;

    // selection + tap handlers
    for (const el of this.svg.querySelectorAll<SVGElement>('[data-iid]')) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedIid = Number(el.dataset.iid);
        this.render();
      });
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
