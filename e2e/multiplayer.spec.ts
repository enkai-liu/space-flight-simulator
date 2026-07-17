import { expect, test } from '@playwright/test';
import { openBuilder } from './helpers.js';

test('two pilots join one lobby and see each other on the server-authoritative sim', async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // pilot A hosts a lobby
    await openBuilder(pageA);
    await pageA.fill('.pilot-name', 'ALPHA');
    await pageA.click('[data-action=host]');
    await pageA.waitForSelector('.hud .readouts');
    await pageA.waitForFunction(() => window.__sfs?.lobbyCode() != null, undefined, {
      timeout: 15_000,
    });
    const code = await pageA.evaluate(() => window.__sfs!.lobbyCode());
    expect(code).toMatch(/^[A-Z0-9]+$/i);

    // pilot B joins with the code
    await openBuilder(pageB);
    await pageB.fill('.pilot-name', 'BRAVO');
    await pageB.fill('.lobby-code', code!);
    await pageB.click('[data-action=join]');
    await pageB.waitForSelector('.hud .readouts');

    // both clients converge on two vessels in the shared sim
    await pageA.waitForFunction(() => window.__sfs!.vesselIds().length >= 2, undefined, {
      timeout: 15_000,
    });
    await pageB.waitForFunction(() => window.__sfs!.vesselIds().length >= 2, undefined, {
      timeout: 15_000,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
