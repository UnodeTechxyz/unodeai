import { describe, it, expect } from 'vitest';
import { normalizeRunnerCommand, ProjectCommandInfo } from '../commandNormalize';

const info: ProjectCommandInfo = {
  packageManager: 'npm',
  scripts: {
    build: 'tsc -p ./',
    lint: 'eslint src --ext ts',
    test: 'vitest run',
    'test:watch': 'vitest',
  },
};

const n = (cmd: string, i: ProjectCommandInfo = info) => normalizeRunnerCommand(cmd, i);

describe('normalizeRunnerCommand', () => {
  it('rewrites a direct runner call to the matching project script', () => {
    expect(n('npx vitest').command).toBe('npm test');
    expect(n('vitest').command).toBe('npm test');
    expect(n('npx -y vitest').command).toBe('npm test');
    expect(n('pnpm exec vitest', { ...info, packageManager: 'pnpm' }).command).toBe('pnpm test');
    expect(n('yarn vitest', { ...info, packageManager: 'yarn' }).command).toBe('yarn test');
  });

  it('prefers the one-shot script over a watch variant', () => {
    // matches both `test` (vitest run) and `test:watch` (vitest) — must pick `test`.
    expect(n('npx vitest').command).toBe('npm test');
  });

  it('does not demote a one-shot script because its name contains dev', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { 'device-test': 'vitest run' },
    };
    expect(n('npx vitest', project).command).toBe('npm run device-test');
  });

  it('chooses an explicit one-shot body over bare watch-default vitest regardless of names', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { 'test:dev': 'vitest', 'device-test': 'vitest run' },
    };
    expect(n('npx vitest', project).command).toBe('npm run device-test');
  });

  it('demotes a body that explicitly watches', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'vitest --watch', checks: 'vitest --run' },
    };
    expect(n('npx vitest', project).command).toBe('npm run checks');
  });

  it('does not read another command\'s run token as the runner\'s one-shot subcommand', () => {
    // `npm run lint && vitest` leaves vitest bare, so the script watches forever. The word `run`
    // in it belongs to npm.
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'npm run lint && vitest' },
    };
    expect(n('npx vitest', project).command).toBe('npx vitest run');
  });

  it('passes over a composite watching script for the genuinely one-shot one', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { check: 'npm run lint && vitest', unit: 'vitest run' },
    };
    expect(n('npx vitest', project).command).toBe('npm run unit');
  });

  it('reads the runner arguments that follow a preceding one-shot command', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'npm run lint && vitest run --coverage' },
    };
    expect(n('npx vitest', project).command).toBe('npm test');
  });

  it('rejects a script whose first vitest invocation watches, however the rest of it reads', () => {
    // Reading only the last invocation chose `test` here: its leading bare vitest enters watch mode
    // and `vitest run` is never reached.
    for (const body of ['vitest && vitest run', 'vitest --watch && vitest run', 'vitest run && vitest']) {
      const project: ProjectCommandInfo = { packageManager: 'npm', scripts: { test: body, unit: 'vitest run' } };
      expect(n('npx vitest', project).command).toBe('npm run unit');
    }
  });

  it('splits command separators that carry no surrounding whitespace', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'vitest&&vitest run', unit: 'vitest run' },
    };
    expect(n('npx vitest', project).command).toBe('npm run unit');
  });

  it('treats a body it cannot read as ineligible rather than guessing', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'vitest run $(scripts/extra-args.sh)' },
    };
    expect(n('npx vitest', project).command).toBe('npx vitest run');
  });

  it('does not turn a quoted separator and runner name into a command invocation', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'echo "not a command && vitest run"' },
    };
    expect(n('npx vitest', project).command).toBe('npx vitest run');
  });

  it('does not read a quoted argument value as a flag of its own', () => {
    // The only case that separates real quote handling from ignoring quotes: unquoted, the `--watch`
    // inside this pattern becomes a token and demotes a script that is explicitly one-shot.
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { test: 'vitest run --testNamePattern="a --watch b"' },
    };
    expect(n('npx vitest', project).command).toBe('npm test');
  });

  it('keeps common quoted runner arguments eligible', () => {
    const project: ProjectCommandInfo = {
      packageManager: 'npm',
      scripts: { lint: 'eslint "src/**/*.ts"' },
    };
    expect(n('npx eslint src', project).command).toBe('npm run lint');
  });

  it('rejects shell groups it cannot classify and treats newlines as command separators', () => {
    for (const body of ['vitest run && (vitest)', 'vitest run\nvitest']) {
      const project: ProjectCommandInfo = { packageManager: 'npm', scripts: { test: body, unit: 'vitest run' } };
      expect(n('npx vitest', project).command).toBe('npm run unit');
    }
  });

  it('maps tsc -> build and eslint -> lint via the script bodies', () => {
    expect(n('npx tsc --noEmit').command).toBe('npm run build');
    expect(n('npx eslint src').command).toBe('npm run lint');
  });

  it('includes a note telling the agent to use the project scripts', () => {
    const r = n('npx vitest');
    expect(r.note).toMatch(/Use the project's npm scripts/i);
    expect(r.note).toContain('npm test');
  });

  it('leaves the command alone when it already goes through the project scripts', () => {
    expect(n('npm test')).toEqual({ command: 'npm test' });
    expect(n('npm run build')).toEqual({ command: 'npm run build' });
    expect(n('pnpm test', { ...info, packageManager: 'pnpm' })).toEqual({ command: 'pnpm test' });
  });

  it('leaves unrelated commands alone', () => {
    expect(n('git status')).toEqual({ command: 'git status' });
    expect(n('node server.js')).toEqual({ command: 'node server.js' });
    expect(n('ls -la')).toEqual({ command: 'ls -la' });
  });

  it('does not rewrite chained/shell commands (too risky)', () => {
    expect(n('npx vitest && echo done')).toEqual({ command: 'npx vitest && echo done' });
  });

  it('forces vitest out of watch mode when no test script exists', () => {
    const noScripts: ProjectCommandInfo = { packageManager: 'npm', scripts: {} };
    expect(n('npx vitest', noScripts).command).toBe('npx vitest run');
    expect(n('vitest', noScripts).command).toBe('vitest run');
    // already one-shot or explicit watch → leave as-is
    expect(n('vitest run', noScripts)).toEqual({ command: 'vitest run' });
    expect(n('vitest --watch', noScripts)).toEqual({ command: 'vitest --watch' });
  });
});
