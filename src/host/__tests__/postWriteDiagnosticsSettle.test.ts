import { describe, expect, it } from 'vitest';
import { POST_WRITE_DIAGNOSTICS_SETTLE_MS } from '../postWriteDiagnosticsSettle';

// v0.9.105 S8: the activation-level flows set this wait to 0, because their stub editor runs no language server. The
// product keeps the language servers' time to recompute after an agent's write before their errors are read.
describe('post-write diagnostics settle time', () => {
  it('is 800 ms in the product', () => {
    expect(POST_WRITE_DIAGNOSTICS_SETTLE_MS).toBe(800);
  });
});
