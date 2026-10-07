import { describe, it, expect } from 'vitest';
import { TaskClaimRegistry, pathsOverlap } from '../TaskClaimRegistry';

describe('pathsOverlap', () => {
  it('treats equal and path-boundary-contained specs as overlapping', () => {
    expect(pathsOverlap('src/auth', 'src/auth')).toBe(true);
    expect(pathsOverlap('src/auth/**', 'src/auth/login.ts')).toBe(true);
    expect(pathsOverlap('src/auth', 'src/auth/login.ts')).toBe(true);
    expect(pathsOverlap('src/auth/login.ts', 'src/auth/**')).toBe(true);
  });

  it('treats distinct files / sibling dirs as non-overlapping', () => {
    expect(pathsOverlap('src/auth/a.ts', 'src/auth/b.ts')).toBe(false);
    expect(pathsOverlap('src/auth/**', 'src/api/**')).toBe(false);
    expect(pathsOverlap('tests/**', 'src/**')).toBe(false);
  });

  it('normalizes slashes / ./ / case, and treats a repo-wide claim as overlapping all', () => {
    expect(pathsOverlap('.\\src\\Auth\\', 'src/auth')).toBe(true);
    expect(pathsOverlap('**', 'src/anything.ts')).toBe(true);
  });
});

describe('TaskClaimRegistry', () => {
  it('allows non-overlapping parallel claims', () => {
    const r = new TaskClaimRegistry();
    expect(r.claim('t1', 'dev', ['src/auth/**']).ok).toBe(true);
    expect(r.claim('t2', 'tester', ['tests/**']).ok).toBe(true);
    expect(r.activeClaims()).toHaveLength(2);
  });

  it('rejects a claim that overlaps an in-flight one, naming the holder, without recording it', () => {
    const r = new TaskClaimRegistry();
    r.claim('t1', 'dev', ['src/auth/**']);
    const res = r.claim('t2', 'tester', ['src/auth/login.ts']);
    expect(res.ok).toBe(false);
    expect(res.conflicts?.[0]).toMatch(/src\/auth\/login\.ts \(overlaps in-flight task t1 held by dev\)/);
    expect(r.activeClaims()).toHaveLength(1); // rejected claim not recorded
  });

  it('frees paths on release so they can be re-claimed', () => {
    const r = new TaskClaimRegistry();
    r.claim('t1', 'dev', ['src/auth/**']);
    expect(r.claim('t2', 'tester', ['src/auth/x.ts']).ok).toBe(false);
    r.release('t1');
    expect(r.claim('t2', 'tester', ['src/auth/x.ts']).ok).toBe(true);
  });

  it('an empty paths list always succeeds (opt-out of ownership)', () => {
    const r = new TaskClaimRegistry();
    r.claim('t1', 'dev', ['src/**']);
    expect(r.claim('t2', 'tester', []).ok).toBe(true);
  });

  it('re-claiming the same taskId does not conflict with itself', () => {
    const r = new TaskClaimRegistry();
    r.claim('t1', 'dev', ['src/auth/**']);
    expect(r.claim('t1', 'dev', ['src/auth/**', 'src/auth/extra.ts']).ok).toBe(true);
  });
});
