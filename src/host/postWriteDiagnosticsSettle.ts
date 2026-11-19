/**
 * v0.5.2: how long UnodeAi lets the editor's language servers recompute after an agent's write before it reads their
 * errors and warnings for the written files (an edit retriggers TS/ESLint asynchronously).
 *
 * v0.9.105 S8: in its own module so activation-level tests, whose stub editor runs no language server, can set it to
 * 0 and still run the same post-write diagnostics path. The product value is pinned by a test.
 */
export const POST_WRITE_DIAGNOSTICS_SETTLE_MS = 800;
