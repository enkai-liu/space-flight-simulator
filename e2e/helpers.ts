import type { Page } from '@playwright/test';

/**
 * Typed view of the dev-only `window.__sfs` handle the flight screen exposes.
 * E2E asserts on physics truth through this handle instead of scraping pixels
 * or racing transient toasts.
 */
export interface SfsEngineReadout {
  iid: number;
  title: string;
  on: boolean;
  hasFuel: boolean;
  stageIndex: number;
}

export interface SfsReadout {
  bodyId: string;
  altitude: number;
  speed: number;
  surfaceSpeed: number;
  apoapsis: number;
  periapsis: number;
  throttle: number;
  fuel: number;
  fuelCapacity: number;
  engines: SfsEngineReadout[];
  stagesLeft: number;
  mass: number;
  landed: boolean;
  onRails: boolean;
  destroyed: boolean;
  heading: number;
  heatFraction: number;
  chuteDeployed: boolean;
}

export interface SfsHandle {
  vesselId: string;
  getFps(): number;
  setThrottle(v: number): void;
  setHeading(rad: number): void;
  stage(): void;
  setEngine(iid: number, on: boolean): void;
  readout(): SfsReadout;
  vesselIds(): string[];
  lobbyCode(): string | null;
}

declare global {
  interface Window {
    __sfs?: SfsHandle;
  }
}

/** Open the builder home screen and wait for it to be interactive. */
export async function openBuilder(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.builder svg.builder-canvas');
}

/** Launch the stock craft solo and wait for the flight screen + dev handle. */
export async function launchSolo(page: Page): Promise<void> {
  await openBuilder(page);
  await page.click('[data-action=launch]');
  await page.waitForSelector('.hud .readouts');
  await page.waitForFunction(() => window.__sfs !== undefined);
}
