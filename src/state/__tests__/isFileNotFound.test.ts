import { describe, it, expect, vi } from 'vitest';

// PersistenceManager imports `vscode`; we only exercise the pure isFileNotFound helper, so an
// empty module stub is enough to let the file load under vitest.
vi.mock('vscode', () => ({}));

import { isFileNotFound } from '../PersistenceManager';

// Regression: a missing .unode/team.json must be treated as "absent" (silent), not a warning.
// The file is read via vscode.workspace.fs, which throws a vscode.FileSystemError — its `.code`
// is 'FileNotFound', and/or it wraps a raw Node error whose only ENOENT signal is in the message.
// The old guard checked only Node's `code === 'ENOENT'`, so those shapes leaked a user-facing warning.
describe('isFileNotFound', () => {
  it('detects a Node ENOENT errno', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open 'x/.unode/team.json'"), {
      code: 'ENOENT',
    });
    expect(isFileNotFound(err)).toBe(true);
  });

  it('detects a vscode.FileSystemError (code FileNotFound)', () => {
    expect(isFileNotFound(Object.assign(new Error('Unable to read file'), { code: 'FileNotFound' }))).toBe(true);
    expect(isFileNotFound(Object.assign(new Error('not found'), { code: 'EntryNotFound' }))).toBe(true);
  });

  it('detects ENOENT carried only in the message (wrapped error, code Unknown)', () => {
    const wrapped = Object.assign(
      new Error("Error: ENOENT: no such file or directory, open 'c:\\proj\\.roam\\team.json'"),
      { code: 'Unknown' }
    );
    expect(isFileNotFound(wrapped)).toBe(true);
  });

  it('does NOT swallow real errors (parse/validation, permission)', () => {
    expect(isFileNotFound(new Error('Invalid .unode/team.json: members must be an array'))).toBe(false);
    expect(isFileNotFound(Object.assign(new Error('permission denied'), { code: 'EACCES' }))).toBe(false);
    expect(isFileNotFound(undefined)).toBe(false);
  });
});
