import type { PartDef, CraftDesign } from '@sfs/sim';

/**
 * The launch part catalog (~10 parts, plan §5.1). Shapes are truncated cones
 * (rTop/rBottom/height in meters) rendered procedurally — no asset pipeline.
 */
export const PARTS: PartDef[] = [
  {
    id: 'capsule-mk1',
    title: 'Mk1 Capsule',
    category: 'capsule',
    massDry: 800,
    dragArea: 0.8,
    maxHeat: 2600,
    shape: { rTop: 0.3, rBottom: 0.7, height: 1.3 },
    attach: { top: true, bottom: true },
  },
  {
    id: 'chute-mk1',
    title: 'Mk1 Parachute',
    category: 'parachute',
    massDry: 80,
    // sized so even a full upper stage (~1.8 t) touches down under the
    // 10 m/s crash threshold (~9.5 m/s); a shielded capsule lands at ~7 m/s
    parachute: { dragArea: 320 },
    dragArea: 0.1,
    maxHeat: 900,
    shape: { rTop: 0.1, rBottom: 0.28, height: 0.45 },
    attach: { top: false, bottom: true },
  },
  {
    id: 'heatshield-mk1',
    title: 'Mk1 Heat Shield',
    category: 'heatshield',
    massDry: 180,
    // blunt ablative face: big drag, big heat margin for the section it caps
    dragArea: 0.6,
    maxHeat: 3400,
    shape: { rTop: 0.7, rBottom: 0.7, height: 0.3 },
    attach: { top: true, bottom: true },
  },
  {
    id: 'nose-a',
    title: 'Aero Nose Cone',
    category: 'nose',
    massDry: 60,
    dragArea: -0.4,
    maxHeat: 2000, // streamlines the stack it caps
    shape: { rTop: 0.02, rBottom: 0.7, height: 1.2 },
    attach: { top: false, bottom: true },
  },
  {
    id: 'tank-s',
    title: 'FT-400 Tank',
    category: 'tank',
    massDry: 250,
    fuel: 2_000,
    dragArea: 0.5,
    maxHeat: 1200,
    shape: { rTop: 0.7, rBottom: 0.7, height: 1.6 },
    attach: { top: true, bottom: true },
  },
  {
    id: 'tank-m',
    title: 'FT-800 Tank',
    category: 'tank',
    massDry: 500,
    fuel: 4_000,
    dragArea: 0.9,
    maxHeat: 1200,
    shape: { rTop: 0.7, rBottom: 0.7, height: 3.0 },
    attach: { top: true, bottom: true },
  },
  {
    id: 'tank-l',
    title: 'FT-1600 Heavy Tank',
    category: 'tank',
    massDry: 1_000,
    fuel: 8_000,
    dragArea: 1.4,
    maxHeat: 1200,
    shape: { rTop: 0.7, rBottom: 0.7, height: 4.4 },
    attach: { top: true, bottom: true },
  },
  {
    id: 'engine-hawk',
    title: 'Hawk Engine',
    category: 'engine',
    massDry: 1_200,
    engine: { thrust: 400_000, ispVac: 290, ispSL: 250 },
    dragArea: 0.4,
    maxHeat: 1900,
    shape: { rTop: 0.5, rBottom: 0.65, height: 1.1 },
    attach: { top: true, bottom: false },
  },
  {
    id: 'engine-kite',
    title: 'Kite Vacuum Engine',
    category: 'engine',
    massDry: 450,
    engine: { thrust: 60_000, ispVac: 340, ispSL: 120 },
    dragArea: 0.3,
    maxHeat: 1500,
    shape: { rTop: 0.35, rBottom: 0.55, height: 0.9 },
    attach: { top: true, bottom: false },
  },
  {
    id: 'decoupler-s',
    title: 'TD-1 Decoupler',
    category: 'decoupler',
    massDry: 120,
    dragArea: 0.1,
    maxHeat: 1300,
    shape: { rTop: 0.7, rBottom: 0.7, height: 0.4 },
    attach: { top: true, bottom: true },
  },
  {
    id: 'fin-a',
    title: 'AV-1 Fin',
    category: 'fin',
    massDry: 45,
    dragArea: 0.25,
    maxHeat: 1300,
    shape: { rTop: 0.35, rBottom: 0.75, height: 1.1 },
    attach: { top: false, bottom: false, side: true },
  },
];

export const PART_CATALOG: Map<string, PartDef> = new Map(PARTS.map((p) => [p.id, p]));

/** The stock two-stage orbital launcher as a buildable craft design (y = bottom, meters). */
export const KARMAN_I_DESIGN: CraftDesign = {
  format: 2,
  name: 'Karman I',
  parts: [
    // bottom stage: hawk + two heavy tanks
    { iid: 1, part: 'engine-hawk', x: 0, y: 0 },
    { iid: 2, part: 'tank-l', x: 0, y: 1.1 },
    { iid: 3, part: 'tank-l', x: 0, y: 5.5 },
    { iid: 4, part: 'decoupler-s', x: 0, y: 9.9 },
    // upper stage: kite (shrouded by the decoupler below) + medium tank
    { iid: 5, part: 'engine-kite', x: 0, y: 10.3 },
    { iid: 6, part: 'tank-m', x: 0, y: 11.2 },
    { iid: 7, part: 'decoupler-s', x: 0, y: 14.2 },
    // re-entry section: shield under the capsule, chute on top
    { iid: 8, part: 'heatshield-mk1', x: 0, y: 14.6 },
    { iid: 9, part: 'capsule-mk1', x: 0, y: 14.9 },
    { iid: 10, part: 'chute-mk1', x: 0, y: 16.2 },
  ],
};
