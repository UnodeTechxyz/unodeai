import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

export default defineConfig({
  test: {
    // Only run TypeScript unit sources; never the compiled copies in out/ or the VS Code E2E suite.
    include: ['src/**/*.test.ts', 'tools/**/*.test.mjs'],
    exclude: ['out/**', 'out-e2e/**', 'test-e2e/**', 'node_modules/**'],
    // A shared Vite cache made concurrent human/CI gate runs corrupt one another. The process id keeps
    // independent invocations isolated; Harness Lab task workspaces reserve their own .vitest-cache too.
    cacheDir: process.env.UNODE_VITEST_CACHE_DIR ?? join('node_modules', '.vite', `unode-vitest-${process.pid}`),
    // NOTE: vitest's worker runtime cannot initialize when `npm test` is spawned by an agent via
    // run_command (no controlling terminal anywhere in the console-less VS Code/Electron process tree,
    // on Node 25) — fails the same way on vitest 1.x AND 4.x, every pool. So agents verify with build +
    // lint and Claude runs this suite (normal terminal / CI work fine). Default (parallel forks) here.
  },
});
