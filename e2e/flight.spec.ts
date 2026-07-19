import { expect, test } from '@playwright/test';
import { launchSolo } from './helpers.js';

test('LAUNCH transitions from builder to the flight screen', async ({ page }) => {
  await launchSolo(page);

  await expect(page.locator('.hud .readouts')).toBeVisible();
  await expect(page.locator('[data-testid=status]')).toHaveText('LANDED');
  await expect(page.locator('#app canvas')).toBeVisible();
});

test('full throttle lifts off and altitude climbs monotonically', async ({ page }) => {
  await launchSolo(page);

  await page.keyboard.press('z'); // full throttle
  await page.waitForFunction(() => window.__sfs!.readout().altitude > 50, undefined, {
    timeout: 30_000,
  });

  const first = await page.evaluate(() => window.__sfs!.readout().altitude);
  await page.waitForFunction(
    (prev) => window.__sfs!.readout().altitude > prev,
    first,
    { timeout: 10_000 },
  );

  const readout = await page.evaluate(() => window.__sfs!.readout());
  expect(readout.landed).toBe(false);
  expect(readout.destroyed).toBe(false);
  await expect(page.locator('[data-testid=status]')).not.toHaveText('LANDED');
});

test('staging drops exactly one stage', async ({ page }) => {
  await launchSolo(page);

  await page.keyboard.press('z');
  await page.waitForFunction(() => window.__sfs!.readout().altitude > 100, undefined, {
    timeout: 30_000,
  });

  const before = await page.evaluate(() => window.__sfs!.readout().stagesLeft);
  expect(before).toBeGreaterThan(1);

  await page.keyboard.press(' ');
  await page.waitForFunction(
    (prev) => window.__sfs!.readout().stagesLeft === prev - 1,
    before,
    { timeout: 5_000 },
  );
});

test('staging detaches the spent stage as debris and auto-ignites the next engine', async ({
  page,
}) => {
  await launchSolo(page);

  // engine switch panel: Hawk lit, Kite standing by
  await expect(page.locator('[data-testid=engine-1]')).toHaveClass(/\bon\b/);
  await expect(page.locator('[data-testid=engine-5]')).not.toHaveClass(/\bon\b/);

  await page.keyboard.press('z');
  await page.waitForFunction(() => window.__sfs!.readout().altitude > 100, undefined, {
    timeout: 30_000,
  });
  await page.keyboard.press(' '); // stage

  // the jettisoned booster keeps existing as a falling debris vessel
  await page.waitForFunction(
    () => window.__sfs!.vesselIds().some((id) => id.includes('debris')),
    undefined,
    { timeout: 5_000 },
  );
  // and the freshly exposed Kite auto-ignited (chip re-keyed to slot 1)
  const engines = await page.evaluate(() => window.__sfs!.readout().engines);
  expect(engines).toHaveLength(1);
  expect(engines[0]).toMatchObject({ iid: 5, on: true });
  await expect(page.locator('[data-testid=engine-5]')).toHaveClass(/\bon\b/);
});

test('engine switches gate thrust: all engines off means no liftoff', async ({ page }) => {
  await launchSolo(page);

  await page.locator('[data-testid=engine-1]').click(); // shut the Hawk down
  await expect(page.locator('[data-testid=engine-1]')).not.toHaveClass(/\bon\b/);

  await page.keyboard.press('z'); // full throttle, but nothing is lit
  await page.waitForTimeout(2_000);
  const readout = await page.evaluate(() => window.__sfs!.readout());
  expect(readout.landed).toBe(true);
  expect(readout.fuel).toBe(readout.fuelCapacity);

  // relight and it flies
  await page.locator('[data-testid=engine-1]').click();
  await page.waitForFunction(() => !window.__sfs!.readout().landed, undefined, {
    timeout: 15_000,
  });
});

test('map view toggles with the M key', async ({ page }) => {
  await launchSolo(page);

  const mapButton = page.locator('.map-btn');
  await expect(mapButton).toHaveText('MAP');

  await page.keyboard.press('m');
  await expect(mapButton).toHaveText('SHIP');

  await page.keyboard.press('m');
  await expect(mapButton).toHaveText('MAP');
});

test('debug overlay reports a live FPS counter and advancing sim clock', async ({ page }) => {
  await page.goto('/?debug');
  await page.waitForSelector('.builder svg.builder-canvas');
  await page.click('[data-action=launch]');
  await page.waitForSelector('.hud .readouts');

  // overlay populates on its 1 s cadence; no FPS floor — headless WebGL is SwiftShader
  await page.waitForFunction(() => {
    const fps = document.querySelector('[data-testid=fps]');
    return fps !== null && Number(fps.textContent) > 0;
  }, undefined, { timeout: 15_000 });

  const t1 = await page.evaluate(() =>
    Number(document.querySelector('[data-testid=simtime]')!.textContent),
  );
  await page.waitForFunction(
    (prev) => Number(document.querySelector('[data-testid=simtime]')!.textContent) > prev,
    t1,
    { timeout: 10_000 },
  );
});
