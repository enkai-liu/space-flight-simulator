import { defineConfig } from 'vite';

export default defineConfig({
  // Workspace packages are consumed as TS source; keep them out of the
  // esbuild pre-bundle so edits to sim/data hot-reload the client.
  optimizeDeps: {
    exclude: ['@sfs/sim', '@sfs/data'],
  },
  server: {
    host: true,
  },
});
