import type { VesselConfig } from '@sfs/sim';

/**
 * The M1 stock rocket: a two-stage orbital launcher with generous margins
 * (~6,100 m/s of Δv vs ~3,400 needed for low Terra orbit) so imperfect
 * hand-flown gravity turns still make it.
 *
 * Launch mass 24.3 t, pad TWR ≈ 1.9.
 */
export const KARMAN_I: VesselConfig = {
  name: 'Karman I',
  stages: [
    {
      // booster
      dryMass: 4_000,
      fuelMass: 16_000,
      thrust: 450_000,
      ispVac: 290,
      ispSL: 250,
      dragArea: 4.0,
    },
    {
      // upper stage
      dryMass: 800,
      fuelMass: 2_700,
      thrust: 60_000,
      ispVac: 340,
      ispSL: 120,
      dragArea: 1.2,
    },
    {
      // capsule (unpowered)
      dryMass: 800,
      fuelMass: 0,
      thrust: 0,
      ispVac: 1,
      ispSL: 1,
      dragArea: 0.8,
    },
  ],
};
