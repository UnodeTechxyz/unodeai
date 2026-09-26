import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { FirstWorkspaceBinding, requireAbsoluteWorkingDirectory } from '../WorkspaceBinding';

describe('requireAbsoluteWorkingDirectory', () => {
  it('accepts an explicit absolute host-selected root', () => {
    const root = path.resolve('workspace-fixture');
    expect(requireAbsoluteWorkingDirectory(root)).toBe(root);
  });

  it.each([undefined, '', 'relative/project'])('refuses an absent or relative root: %s', (root) => {
    expect(() => requireAbsoluteWorkingDirectory(root)).toThrow(/Open a workspace folder/);
  });
});

describe('FirstWorkspaceBinding', () => {
  it('invalidates the captured root when the first folder changes and never rebinds old writers', () => {
    const first = path.resolve('workspace-one');
    const second = path.resolve('workspace-two');
    const binding = new FirstWorkspaceBinding(first);
    const capturedWriterRoot = binding.root();

    expect(binding.observe(first)).toBe(false);
    expect(binding.observe(second)).toBe(true);
    expect(binding.root()).toBeUndefined();
    expect(binding.isStale()).toBe(true);
    expect(capturedWriterRoot).toBe(first);
    expect(binding.observe(first)).toBe(false);
  });
});
