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
