import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

export default defineConfig({
  // A shared Vite cache made concurrent human/CI gate runs corrupt one another. `cacheDir` is a Vite option,
  // not a Vitest `test` option. The process id isolates independent invocations; Harness Lab task workspaces
  // can still reserve their own directory through the environment override.
  cacheDir: process.env.UNODE_VITEST_CACHE_DIR ?? join('node_modules', '.vite', `unode-vitest-${process.pid}`),
  test: {
    // Only run TypeScript unit sources; never the compiled copies in out/ or the VS Code E2E suite.
    include: ['src/**/*.test.ts', 'tools/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    exclude: ['out/**', 'out-e2e/**', 'test-e2e/**', 'node_modules/**'],
    // Many cases spawn real git/CLI processes or write hundreds of real files. Alone they take 0.2-1.3 s; under the
    // full parallel suite on Windows a different one crossed Vitest's 5 s default in each of three release chains
    // (v0.9.100). One suite-wide budget instead of bounding the next case each time; a hang still fails at 30 s.
    testTimeout: 30_000,
    // NOTE: vitest's worker runtime cannot initialize when `npm test` is spawned by an agent via
    // run_command (no controlling terminal anywhere in the console-less VS Code/Electron process tree,
    // on Node 25) — fails the same way on vitest 1.x AND 4.x, every pool. So agents verify with build +
    // lint and Claude runs this suite (normal terminal / CI work fine). Default (parallel forks) here.
  },
});
