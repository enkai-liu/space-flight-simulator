import { expect, test } from '@playwright/test';
import { openBuilder } from './helpers.js';

test('builder home screen renders the stock craft ready to launch', async ({ page }) => {
  await openBuilder(page);

  await expect(page.locator('.builder')).toBeVisible();
  await expect(page.locator('svg.builder-canvas')).toBeVisible();

  // stock craft parts are drawn into the SVG
  expect(await page.locator('svg.builder-canvas *').count()).toBeGreaterThan(0);

  // palette offers parts to drag in
  expect(await page.locator('.builder-palette .palette-item').count()).toBeGreaterThan(0);

  // a valid stock craft means LAUNCH is enabled
  await expect(page.locator('[data-action=launch]')).toBeEnabled();
});
