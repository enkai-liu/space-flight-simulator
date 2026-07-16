import type { PartDef } from '@sfs/sim';

/** Fill colors per part category. */
const CATEGORY_COLORS: Record<string, string> = {
  capsule: '#aab4c4',
  tank: '#c8ccd4',
  engine: '#8a8f98',
  decoupler: '#a8853f',
  fin: '#7d8aa0',
  nose: '#9aa4b4',
  parachute: '#b0563c',
};

export function partColor(def: PartDef): string {
  return CATEGORY_COLORS[def.category] ?? '#999';
}

/**
 * SVG path for a part silhouette in y-up local meters, base at y=0.
 * Most parts are truncated cones; fins are right triangles hugging x=0.
 */
export function partPath(def: PartDef): string {
  const { rTop, rBottom, height } = def.shape;
  if (def.category === 'fin') {
    return `M 0 ${height} L 0 0 L ${rBottom} 0 L ${rTop} ${height} Z`;
  }
  if (def.category === 'capsule' || def.category === 'nose') {
    // slightly curved shoulders read better than a hard trapezoid
    const c = height * 0.35;
    return `M ${-rBottom} 0 C ${-rBottom} ${c}, ${-rTop} ${height - c}, ${-rTop} ${height} L ${rTop} ${height} C ${rTop} ${height - c}, ${rBottom} ${c}, ${rBottom} 0 Z`;
  }
  return `M ${-rBottom} 0 L ${-rTop} ${height} L ${rTop} ${height} L ${rBottom} 0 Z`;
}

/** Extra detail markup drawn on top of the base silhouette (engine nozzles). */
export function partDetail(def: PartDef): string {
  if (def.category === 'engine') {
    const { rBottom, height } = def.shape;
    const nozzleH = height * 0.45;
    return `<path d="M ${-rBottom * 0.55} ${nozzleH} L ${-rBottom * 0.85} 0 L ${rBottom * 0.85} 0 L ${rBottom * 0.55} ${nozzleH} Z" fill="#3a3d42"/>`;
  }
  if (def.category === 'decoupler') {
    const { rBottom, height } = def.shape;
    return `<rect x="${-rBottom}" y="${height * 0.35}" width="${rBottom * 2}" height="${height * 0.3}" fill="#5a4620"/>`;
  }
  return '';
}

/** Standalone <svg> markup for palette icons and drag ghosts. */
export function partIconSvg(def: PartDef, px: number): string {
  const { rTop, rBottom, height } = def.shape;
  const w = Math.max(rTop, rBottom) * 2 + 0.2;
  const h = height + 0.2;
  const scale = Math.min(px / w, px / h);
  return (
    `<svg width="${(w * scale).toFixed(0)}" height="${(h * scale).toFixed(0)}" viewBox="${-w / 2} ${-height - 0.1} ${w} ${h}">` +
    `<g transform="scale(1,-1)">` +
    `<path d="${partPath(def)}" fill="${partColor(def)}" stroke="#1c2430" stroke-width="0.05"/>` +
    partDetail(def) +
    `</g></svg>`
  );
}
