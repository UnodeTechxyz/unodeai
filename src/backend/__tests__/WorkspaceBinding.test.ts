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
  // v0.9.99 (B12): a first-folder change no longer invalidates the bound root. Project state keeps the root the window
  // started with (never redirected to the new folder), work is not refused, and a reload is offered once per change.
  it('keeps the bound root when the first folder changes, and reports each different folder once', () => {
    const first = path.resolve('workspace-one');
    const second = path.resolve('workspace-two');
    const third = path.resolve('workspace-three');
    const binding = new FirstWorkspaceBinding(first);

    expect(binding.observe(first)).toBe(false);
    expect(binding.switchPending()).toBe(false);
    expect(binding.observe(second)).toBe(true);
    expect(binding.root()).toBe(first);
    expect(binding.isStale()).toBe(false);
    expect(binding.switchPending()).toBe(true);
    expect(binding.observe(second)).toBe(false);
    expect(binding.observe(third)).toBe(true);
    expect(binding.root()).toBe(first);
    // Back to the bound folder: nothing to switch, and a later change is reported again.
    expect(binding.observe(first)).toBe(false);
    expect(binding.switchPending()).toBe(false);
    expect(binding.observe(second)).toBe(true);
  });

  it('a window that started without a folder stays without one until it reloads', () => {
    const binding = new FirstWorkspaceBinding(undefined);
    expect(binding.observe(path.resolve('workspace-one'))).toBe(true);
    expect(binding.root()).toBeUndefined();
    expect(binding.observe(undefined)).toBe(false);
  });
});
