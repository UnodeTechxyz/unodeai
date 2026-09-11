import { describe, it, expect } from 'vitest';
import { sanitizedCommandEnv } from '../commandEnv';

describe('sanitizedCommandEnv', () => {
  it('strips the VS Code / Electron host vars that break child Node toolchains', () => {
    const out = sanitizedCommandEnv({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_INSPECTOR_OPTIONS: 'x',
      VSCODE_PID: '123',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--require /vscode/bootstrap.js --inspect=0',
    });
    expect(out.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(out.VSCODE_INSPECTOR_OPTIONS).toBeUndefined();
    expect(out.VSCODE_PID).toBeUndefined();
    expect(out.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(out.NODE_OPTIONS).toBeUndefined(); // looks vscode/inspector-injected -> dropped
    expect(out.PATH).toBe('/usr/bin'); // ordinary vars preserved
  });

  it('keeps a user-set NODE_OPTIONS that is not VS Code/inspector related', () => {
    expect(sanitizedCommandEnv({ PATH: '/x', NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS)
      .toBe('--max-old-space-size=4096');
    // Codex review: a legit `--require` (ts-node/source-map-support) must NOT be stripped.
    expect(sanitizedCommandEnv({ NODE_OPTIONS: '--require ts-node/register' }).NODE_OPTIONS)
      .toBe('--require ts-node/register');
    expect(sanitizedCommandEnv({ NODE_OPTIONS: '--require source-map-support/register' }).NODE_OPTIONS)
      .toBe('--require source-map-support/register');
  });

  it('still strips an inspector NODE_OPTIONS', () => {
    expect(sanitizedCommandEnv({ NODE_OPTIONS: '--inspect=0' }).NODE_OPTIONS).toBeUndefined();
    expect(sanitizedCommandEnv({ NODE_OPTIONS: '--inspect-brk' }).NODE_OPTIONS).toBeUndefined();
  });

  it('does not mutate the input env', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1', PATH: '/x' };
    sanitizedCommandEnv(base);
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
