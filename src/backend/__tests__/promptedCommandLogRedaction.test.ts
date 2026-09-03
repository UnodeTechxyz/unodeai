/*---------------------------------------------------------------------------------------------
 * CommandPolicy.commandTemplate() is a SAFETY function for allowlisting, not a sanitizer for
 * logging. It deliberately keeps the second token so "git status" cannot green-light
 * "git reset --hard" — correct there, but it means the template still carries whatever the second
 * token happens to be. For interpreter-style tools that is an absolute path, and when the second
 * token is a flag with an inline value it is that value:
 *
 *   node /Users/alice/clients/acme-confidential/deploy.js  ->  keeps the whole path
 *   kubectl --token=SECRETVALUE get pods                   ->  keeps the secret
 *
 * The prompted-command log is opt-in and local, but it is written to be READ — and pasted into a
 * chat or an issue. Home-directory layout, client names and inline credentials must not survive
 * into it. Redaction costs AR2 nothing: you would never allowlist bare `node` or a `--token=` flag,
 * so "node <path> was prompted 47 times" is exactly as actionable as the full path.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { PromptedCommandLog } from '../PromptedCommandLog';

const recorded = (template: string): string => {
  const log = new PromptedCommandLog();
  log.record(template);
  return log.ranked()[0]?.template ?? '';
};

describe('prompted-command log redaction', () => {
  it('never retains an absolute path', () => {
    expect(recorded('node /Users/alice/clients/acme-confidential/deploy.js')).toBe('node <path>');
    expect(recorded('python3 /home/bob/secret-project/train.py')).toBe('python3 <path>');
    expect(recorded('node C:\\Users\\alice\\private\\build.js')).toBe('node <path>');
    expect(recorded('node ~/secret/app.js')).toBe('node <path>');
  });

  it('never retains a value attached to a flag', () => {
    expect(recorded('kubectl --token=secretvalue')).toBe('kubectl --token=<redacted>');
    expect(recorded('docker --config=/home/me/.docker-secret')).toBe('docker --config=<redacted>');
  });

  it('keeps what AR2 actually needs — the verb and its subcommand', () => {
    expect(recorded('git clone')).toBe('git clone');
    expect(recorded('npm run deploy-prod')).toBe('npm run deploy-prod');
    expect(recorded('pip install')).toBe('pip install');
    expect(recorded('curl')).toBe('curl');
    expect(recorded('docker --config')).toBe('docker --config');
  });

  it('redacts defensively even if a caller passes a raw command line', () => {
    // The module docstring says callers must pass commandTemplate(). A comment is not a guarantee;
    // record() must be safe on its own.
    const out = recorded('psql postgres://user:hunter2@db.internal/prod');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('db.internal');
  });

  it('frequency aggregation still works after redaction', () => {
    const log = new PromptedCommandLog();
    log.record('node /home/a/one.js');
    log.record('node /home/b/two.js');
    log.record('git clone');
    expect(log.ranked()).toEqual([
      { template: 'node <path>', count: 2 },
      { template: 'git clone', count: 1 },
    ]);
  });
});
