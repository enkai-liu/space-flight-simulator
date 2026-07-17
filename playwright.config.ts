import { defineConfig } from '@playwright/test';

/**
 * E2E suite: drives the real Vite client against the real ws server.
 * workers: 1 — flight specs are stateful and keyboard-driven, and lobby codes
 * share one server namespace; serial keeps them deterministic.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    // headless Chromium falls back to SwiftShader for WebGL; ≥128 needs this flag
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: [
    {
      command: 'pnpm --filter @sfs/client dev -- --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
    {
      // port-wait, not url-wait: the server's HTTP surface 404s unknown paths
      command: 'pnpm --filter @sfs/server dev',
      port: 8081,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
