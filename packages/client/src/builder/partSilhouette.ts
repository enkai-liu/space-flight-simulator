import type { PartDef } from '@sfs/sim';

/**
 * Procedural SVG part art for the builder. Every part is drawn in y-up local
 * meters with its base at y=0 (the canvas and icons flip with scale(1,-1)).
 * Horizontal gradients fake cylindrical shading; they are defined once in
 * SVG_DEFS and referenced by id (identical defs may repeat per <svg> —
 * duplicate ids resolve to the first match, which is the same markup).
 */

const OUTLINE = '#141a24';
const STROKE = `stroke="${OUTLINE}" stroke-width="0.045" stroke-linejoin="round"`;

export const SVG_DEFS =
  `<defs>` +
  // white-metal hull (tanks, nose cones)
  grad('pgHull', ['#8f97a4', '#c9cfd8', '#f2f4f7', '#e3e7ec', '#a9b0bb', '#7f8794']) +
  // dark warm capsule shell
  grad('pgCapsule', ['#37342f', '#575249', '#6c665c', '#5e594f', '#453f38', '#2c2925']) +
  // bright silver (chute dome, engine machinery)
  grad('pgSilver', ['#767d88', '#d9dde3', '#f6f8fa', '#c4c9d1', '#949aa5', '#6d7480']) +
  // near-black engine bell
  grad('pgNozzle', ['#202226', '#4b4e54', '#5d6067', '#43464c', '#2b2d31', '#191b1e']) +
  // ablative gold heat shield
  grad('pgShield', ['#7c5f2f', '#c8a25a', '#e2c286', '#cda75e', '#96763a', '#6b5128']) +
  // decoupler ring
  grad('pgDecoupler', ['#6b5527', '#b8933f', '#d3b258', '#b08c3d', '#7d6229', '#57431d']) +
  grad('pgFin', ['#55617a', '#8fa0bb', '#a5b4cc', '#7d8da8', '#5d6a85']) +
  `</defs>`;

function grad(id: string, stops: string[]): string {
  const body = stops
    .map((c, i) => `<stop offset="${(i / (stops.length - 1)).toFixed(2)}" stop-color="${c}"/>`)
    .join('');
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${body}</linearGradient>`;
}

const n = (v: number): string => v.toFixed(3).replace(/\.?0+$/, '') || '0';

// ------------------------------------------------------------ outline paths

function capsulePath(def: PartDef): string {
  const { rTop: t, rBottom: b, height: h } = def.shape;
  // straight sloped sides, small base lip, rounded top shoulders
  return (
    `M ${n(-b)} 0 L ${n(-b)} 0.1 L ${n(-(t + 0.07))} ${n(h - 0.14)} ` +
    `Q ${n(-(t + 0.01))} ${n(h)} ${n(-(t - 0.09))} ${n(h)} L ${n(t - 0.09)} ${n(h)} ` +
    `Q ${n(t + 0.01)} ${n(h)} ${n(t + 0.07)} ${n(h - 0.14)} L ${n(b)} 0.1 L ${n(b)} 0 Z`
  );
}

function chutePath(def: PartDef): string {
  const { rBottom: b, height: h } = def.shape;
  return (
    `M ${n(-b)} 0 L ${n(-b)} ${n(h * 0.22)} ` +
    `C ${n(-b)} ${n(h * 0.72)} ${n(-b * 0.55)} ${n(h)} 0 ${n(h)} ` +
    `C ${n(b * 0.55)} ${n(h)} ${n(b)} ${n(h * 0.72)} ${n(b)} ${n(h * 0.22)} L ${n(b)} 0 Z`
  );
}

function shieldPath(def: PartDef): string {
  const { rBottom: r, height: h } = def.shape;
  // flat top, blunt convex face down (edges lifted, center lowest)
  return (
    `M ${n(-r)} ${n(h)} L ${n(r)} ${n(h)} L ${n(r)} ${n(h * 0.55)} ` +
    `Q ${n(r * 0.5)} ${n(h * 0.07)} 0 ${n(h * 0.07)} ` +
    `Q ${n(-r * 0.5)} ${n(h * 0.07)} ${n(-r)} ${n(h * 0.55)} Z`
  );
}

/** Bell half-width at f ∈ [0,1] (1 = throat, 0 = exit): concave flare. */
function bellWidth(def: PartDef, f: number): number {
  const throat = def.shape.rTop * 0.32;
  const exit = def.shape.rBottom * 0.85;
  return throat + (exit - throat) * Math.pow(1 - f, 1.3);
}

const BELL_TOP = 0.53; // throat height as a fraction of part height
const BELL_BOTTOM = 0.03; // exit-plane height, meters

/** Height of the bell profile at f ∈ [0,1] (1 = throat, 0 = exit), meters. */
function bellY(def: PartDef, f: number): number {
  return BELL_BOTTOM + f * (BELL_TOP * def.shape.height - BELL_BOTTOM);
}

function bellPath(def: PartDef): string {
  const pts: string[] = [];
  for (let i = 10; i >= 0; i--) pts.push(`${n(-bellWidth(def, i / 10))} ${n(bellY(def, i / 10))}`);
  for (let i = 0; i <= 10; i++) pts.push(`${n(bellWidth(def, i / 10))} ${n(bellY(def, i / 10))}`);
  return `M ${pts.join(' L ')} Z`;
}

function enginePlatePath(def: PartDef): string {
  const { rTop: t, height: h } = def.shape;
  return `M ${n(-t)} ${n(h * 0.91)} L ${n(-t)} ${n(h)} L ${n(t)} ${n(h)} L ${n(t)} ${n(h * 0.91)} Z`;
}

/**
 * SVG path for a part outline in y-up local meters, base at y=0. Used for the
 * hit region and the selection highlight; the visible art is partArt().
 */
export function partPath(def: PartDef): string {
  const { rTop, rBottom, height } = def.shape;
  switch (def.category) {
    case 'fin':
      return `M 0 ${n(height)} L 0 0 L ${n(rBottom)} 0 L ${n(rTop)} ${n(height)} Z`;
    case 'capsule':
      return capsulePath(def);
    case 'parachute':
      return chutePath(def);
    case 'heatshield':
      return shieldPath(def);
    case 'engine':
      return `${enginePlatePath(def)} ${bellPath(def)}`;
    case 'nose': {
      const c = height * 0.35;
      return (
        `M ${n(-rBottom)} 0 C ${n(-rBottom)} ${n(c)}, ${n(-rTop)} ${n(height - c)}, ${n(-rTop)} ${n(height)} ` +
        `L ${n(rTop)} ${n(height)} C ${n(rTop)} ${n(height - c)}, ${n(rBottom)} ${n(c)}, ${n(rBottom)} 0 Z`
      );
    }
    default:
      return `M ${n(-rBottom)} 0 L ${n(-rTop)} ${n(height)} L ${n(rTop)} ${n(height)} L ${n(rBottom)} 0 Z`;
  }
}

// ------------------------------------------------------------------- detail

function tankArt(def: PartDef): string {
  const { rTop: t, rBottom: b, height: h } = def.shape;
  return (
    `<path d="${partPath(def)}" fill="url(#pgHull)" ${STROKE}/>` +
    // soft weld shading at both rims
    `<rect x="${n(-t)}" y="${n(h - 0.07)}" width="${n(t * 2)}" height="0.07" fill="#141a24" opacity="0.12"/>` +
    `<rect x="${n(-b)}" y="0" width="${n(b * 2)}" height="0.07" fill="#141a24" opacity="0.18"/>`
  );
}

function noseArt(def: PartDef): string {
  const { rBottom: b } = def.shape;
  return (
    `<path d="${partPath(def)}" fill="url(#pgHull)" ${STROKE}/>` +
    `<rect x="${n(-b)}" y="0" width="${n(b * 2)}" height="0.07" fill="#141a24" opacity="0.18"/>`
  );
}

function capsuleArt(def: PartDef): string {
  const { rTop: t, rBottom: b, height: h } = def.shape;
  // inset bevel panel following the hull taper
  const pb = b - 0.16;
  const pt = t + 0.02;
  const p0 = h * 0.13;
  const p1 = h * 0.85;
  // window: trapezoid in the panel's upper half
  const wb = 0.14;
  const wt = 0.095;
  const w0 = h * 0.5;
  const w1 = h * 0.74;
  return (
    `<path d="${capsulePath(def)}" fill="url(#pgCapsule)" ${STROKE}/>` +
    // base heat-scorch lip
    `<path d="M ${n(-b)} 0 L ${n(-b)} 0.1 L ${n(b)} 0.1 L ${n(b)} 0 Z" fill="#1e1b17" opacity="0.6"/>` +
    // raised access panel: light bevel edge over a dark seam
    `<path d="M ${n(-pb)} ${n(p0)} L ${n(-pt)} ${n(p1)} L ${n(pt)} ${n(p1)} L ${n(pb)} ${n(p0)} Z"` +
    ` fill="#ffffff" opacity="0.05"/>` +
    `<path d="M ${n(-pb)} ${n(p0)} L ${n(-pt)} ${n(p1)} L ${n(pt)} ${n(p1)} L ${n(pb)} ${n(p0)} Z"` +
    ` fill="none" stroke="#16140f" stroke-width="0.035" stroke-linejoin="round"/>` +
    `<path d="M ${n(-pb + 0.05)} ${n(p0 + 0.05)} L ${n(-pt + 0.05)} ${n(p1 - 0.05)} L ${n(pt - 0.05)} ${n(p1 - 0.05)} L ${n(pb - 0.05)} ${n(p0 + 0.05)} Z"` +
    ` fill="none" stroke="#7b7468" stroke-width="0.025" opacity="0.6" stroke-linejoin="round"/>` +
    // window
    `<path d="M ${n(-wb)} ${n(w0)} L ${n(-wt)} ${n(w1)} L ${n(wt)} ${n(w1)} L ${n(wb)} ${n(w0)} Z"` +
    ` fill="#232529" stroke="#8b857b" stroke-width="0.035" stroke-linejoin="round"/>`
  );
}

function chuteArt(def: PartDef): string {
  const { rBottom: b, height: h } = def.shape;
  const collarTop = h * 0.24;
  return (
    // collar with a parachute-orange marker stripe
    `<path d="M ${n(-b)} 0 L ${n(-b * 0.9)} ${n(collarTop)} L ${n(b * 0.9)} ${n(collarTop)} L ${n(b)} 0 Z"` +
    ` fill="url(#pgSilver)" ${STROKE}/>` +
    `<rect x="${n(-b * 0.93)}" y="${n(h * 0.07)}" width="${n(b * 1.86)}" height="${n(h * 0.11)}" fill="#b0563c" opacity="0.9"/>` +
    // packed-canopy dome
    `<path d="M ${n(-b * 0.9)} ${n(collarTop)} C ${n(-b * 0.9)} ${n(h * 0.76)} ${n(-b * 0.5)} ${n(h)} 0 ${n(h)}` +
    ` C ${n(b * 0.5)} ${n(h)} ${n(b * 0.9)} ${n(h * 0.76)} ${n(b * 0.9)} ${n(collarTop)} Z" fill="url(#pgSilver)" ${STROKE}/>` +
    `<path d="M 0 ${n(h)} L 0 ${n(collarTop)}" stroke="#141a24" stroke-width="0.02" opacity="0.35"/>`
  );
}

function shieldArt(def: PartDef): string {
  const { rBottom: r, height: h } = def.shape;
  return (
    `<path d="${shieldPath(def)}" fill="url(#pgShield)" ${STROKE}/>` +
    // char line along the blunt face
    `<path d="M ${n(-r * 0.96)} ${n(h * 0.55)} Q ${n(-r * 0.48)} ${n(h * 0.18)} 0 ${n(h * 0.18)}` +
    ` Q ${n(r * 0.48)} ${n(h * 0.18)} ${n(r * 0.96)} ${n(h * 0.55)}"` +
    ` fill="none" stroke="#5e4722" stroke-width="0.04" opacity="0.7"/>` +
    // bright attachment rim up top
    `<rect x="${n(-r)}" y="${n(h * 0.8)}" width="${n(r * 2)}" height="${n(h * 0.2)}" fill="#ffffff" opacity="0.14"/>`
  );
}

function decouplerArt(def: PartDef): string {
  const { rTop: t, rBottom: b, height: h } = def.shape;
  return (
    `<path d="M ${n(-b)} 0 L ${n(-t)} ${n(h)} L ${n(t)} ${n(h)} L ${n(b)} 0 Z" fill="url(#pgDecoupler)" ${STROKE}/>` +
    `<rect x="${n(-b)}" y="${n(h * 0.35)}" width="${n(b * 2)}" height="${n(h * 0.3)}" fill="#5a4620"/>` +
    // jettison arrow
    `<path d="M 0 ${n(h * 0.78)} L ${n(-0.09)} ${n(h * 0.32)} L 0.09 ${n(h * 0.32)} Z" fill="#e2cc86" opacity="0.9"/>`
  );
}

function engineArt(def: PartDef): string {
  const { rTop: t, height: h } = def.shape;
  const plateY = h * 0.91;
  let out = '';

  // feed lines behind the machinery: dark casing under a silver core, sized
  // to the engine so the small vacuum engine doesn't get chunky plumbing
  const pipe = (d: string): string =>
    `<path d="${d}" fill="none" stroke="#26282c" stroke-width="${n(t * 0.22)}" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="#b3b9c2" stroke-width="${n(t * 0.12)}" stroke-linecap="round"/>`;
  out += pipe(
    `M ${n(-t * 0.55)} ${n(h * 0.9)} C ${n(-t * 0.68)} ${n(h * 0.82)} ${n(-t * 0.7)} ${n(h * 0.7)} ${n(-t * 0.58)} ${n(h * 0.58)}`,
  );
  out += pipe(
    `M ${n(t * 0.55)} ${n(h * 0.9)} C ${n(t * 0.7)} ${n(h * 0.84)} ${n(t * 0.74)} ${n(h * 0.72)} ${n(t * 0.66)} ${n(h * 0.6)} ` +
      `L ${n(t * 0.74)} ${n(h * 0.4)} C ${n(t * 0.76)} ${n(h * 0.32)} ${n(t * 0.7)} ${n(h * 0.28)} ${n(t * 0.64)} ${n(h * 0.31)}`,
  );

  // turbopump: neck down to the throat, ball on top, dark collar ring
  out +=
    `<path d="M ${n(-t * 0.32)} ${n(h * 0.78)} L ${n(-t * 0.26)} ${n(h * BELL_TOP)} L ${n(t * 0.26)} ${n(h * BELL_TOP)} L ${n(t * 0.32)} ${n(h * 0.78)} Z"` +
    ` fill="url(#pgSilver)" ${STROKE}/>`;
  out += `<ellipse cx="0" cy="${n(h * 0.78)}" rx="${n(t * 0.38)}" ry="${n(h * 0.12)}" fill="url(#pgSilver)" ${STROKE}/>`;
  out += `<rect x="${n(-t * 0.46)}" y="${n(h * 0.62)}" width="${n(t * 0.92)}" height="${n(h * 0.055)}" fill="#4a4e55" stroke="${OUTLINE}" stroke-width="0.03"/>`;

  // mount plate
  out += `<path d="${enginePlatePath(def)}" fill="#868c97" ${STROKE}/>`;

  // bell with cooling ribs and a glowing-free dark finish
  out += `<path d="${bellPath(def)}" fill="url(#pgNozzle)" ${STROKE}/>`;
  for (const f of [0.72, 0.52, 0.34, 0.18, 0.06]) {
    const w = bellWidth(def, f);
    out += `<path d="M ${n(-w)} ${n(bellY(def, f))} L ${n(w)} ${n(bellY(def, f))}" stroke="#17181b" stroke-width="0.03" opacity="0.6"/>`;
  }
  // exit-rim highlight
  const we = bellWidth(def, 0.02);
  out += `<path d="M ${n(-we)} ${n(BELL_BOTTOM + 0.03)} L ${n(we)} ${n(BELL_BOTTOM + 0.03)}" stroke="#8d9199" stroke-width="0.028" opacity="0.55"/>`;
  return out;
}

function finArt(def: PartDef): string {
  const { rTop: t, rBottom: b, height: h } = def.shape;
  return (
    `<path d="${partPath(def)}" fill="url(#pgFin)" ${STROKE}/>` +
    `<path d="M ${n(b * 0.6)} ${n(h * 0.08)} L ${n(t * 0.8)} ${n(h * 0.85)}" stroke="#ffffff" stroke-width="0.045" opacity="0.2" stroke-linecap="round"/>`
  );
}

/** Full visible markup for a part (fills + details + dark outline). */
export function partArt(def: PartDef): string {
  switch (def.category) {
    case 'capsule':
      return capsuleArt(def);
    case 'parachute':
      return chuteArt(def);
    case 'heatshield':
      return shieldArt(def);
    case 'engine':
      return engineArt(def);
    case 'decoupler':
      return decouplerArt(def);
    case 'fin':
      return finArt(def);
    case 'nose':
      return noseArt(def);
    default:
      return tankArt(def);
  }
}

/** Hull-white for engine interstages, ablative gold for heat-shield covers. */
export const SHROUD_TINT_HULL = '#dfe7f2';
export const SHROUD_TINT_SHIELD = '#e2c286';

/**
 * Interstage fairing drawn over an engine or heat shield that sits on a
 * decoupler: the shroud spans the part's slot at the decoupler's width,
 * translucent so the part reads through it (SFS-style covered stages).
 */
export function shroudMarkup(r: number, y0: number, y1: number, tint = SHROUD_TINT_HULL): string {
  const hSeam = (y: number): string =>
    `<path d="M ${n(-r)} ${n(y)} L ${n(r)} ${n(y)}" stroke="#141a24" stroke-width="0.025" opacity="0.4"/>`;
  return (
    `<g pointer-events="none">` +
    `<rect x="${n(-r)}" y="${n(y0)}" width="${n(r * 2)}" height="${n(y1 - y0)}" fill="${tint}" opacity="0.32"` +
    ` stroke="${OUTLINE}" stroke-width="0.04"/>` +
    // panel gores
    `<path d="M ${n(-r / 3)} ${n(y0)} L ${n(-r / 3)} ${n(y1)} M ${n(r / 3)} ${n(y0)} L ${n(r / 3)} ${n(y1)}"` +
    ` stroke="#ffffff" stroke-width="0.02" opacity="0.35"/>` +
    // bright rolled edges
    `<path d="M ${n(-r + 0.05)} ${n(y0)} L ${n(-r + 0.05)} ${n(y1)} M ${n(r - 0.05)} ${n(y0)} L ${n(r - 0.05)} ${n(y1)}"` +
    ` stroke="#ffffff" stroke-width="0.03" opacity="0.5"/>` +
    hSeam(y0 + 0.06) +
    hSeam(y1 - 0.06) +
    `</g>`
  );
}

/** Standalone <svg> markup for palette icons and drag ghosts. */
export function partIconSvg(def: PartDef, px: number): string {
  const { rTop, rBottom, height } = def.shape;
  const w = Math.max(rTop, rBottom) * 2 + 0.25;
  const h = height + 0.25;
  const scale = Math.min(px / w, px / h);
  return (
    `<svg width="${(w * scale).toFixed(0)}" height="${(h * scale).toFixed(0)}" viewBox="${-w / 2} ${-height - 0.125} ${w} ${h}">` +
    SVG_DEFS +
    `<g transform="scale(1,-1)">` +
    partArt(def) +
    `</g></svg>`
  );
}
