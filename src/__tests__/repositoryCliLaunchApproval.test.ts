import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectRepositoryCliConfig, repositoryCliTrustKey, repositoryCliTrustMatches, repositoryCliTrustRecord, workspaceRootForCliCwd,
} from '../security/RepositoryCliConfig';

/**
 * v0.9.99 B4: the real `repositoryCliLaunchApproval` of extension.ts over a real repository on disk. A repository's
 * own executable configuration still needs the person's decision once; Claude Code's own rewrites of
 * settings.local.json do not ask again; a change to what the configuration can do does.
 */
const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function extensionFunction(name: string, host: object) {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  expect(found).toHaveLength(1);
  const code = ts.transpileModule(found[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return ${name}; }`)(host);
}

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function harness(answer: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'unode-cf5-repo-'));
  roots.push(root);
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ command: 'node start.js' }] } }));
  writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  const state = new Map<string, unknown>();
  const questions: string[] = [];
  const host: Record<string, unknown> = {
    vscode: {
      workspace: { workspaceFolders: [{ uri: { fsPath: root } }], isTrusted: true },
      window: { showWarningMessage: vi.fn(async (message: string) => { questions.push(message); return answer; }) },
    },
    firstWorkspaceRoot: () => root,
    workspaceRootForCliCwd,
    inspectRepositoryCliConfig: (kind: 'claude' | 'codex', workspaceRoot: string, cwd: string) =>
      inspectRepositoryCliConfig(kind, workspaceRoot, cwd, { homeDirectory: path.dirname(root), ancestorBoundary: root }),
    repositoryCliTrustKey, repositoryCliTrustMatches, repositoryCliTrustRecord,
    rootWorkspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); } },
    REPOSITORY_CLI_TRUST_KEY: 'trust',
    attentionAppearance: () => undefined,
    blockingPrompt: (_key: unknown, open: () => Promise<unknown>) => open(),
    pausingTurnClock: () => undefined,
  };
  host.repositoryCliTrustRecords = extensionFunction('repositoryCliTrustRecords', host);
  host.persistRepositoryCliTrust = extensionFunction('persistRepositoryCliTrust', host);
  const approve = extensionFunction('repositoryCliLaunchApproval', host) as
    (kind: 'claude', cwd: string, requester: string) => Promise<{ mode: string; assertCurrent: () => void }>;
  return { root, state, questions, approve: () => approve('claude', root, 'Developer') };
}

describe('v0.9.99 B4: repository CLI configuration through the real launch approval', () => {
  it('a repository-supplied configuration still asks before the first start, then not again for benign rewrites', async () => {
    const h = harness('Trust and load');
    await expect(h.approve()).resolves.toMatchObject({ mode: 'native' });
    expect(h.questions).toHaveLength(1);
    // Claude Code records an answer to its own prompt in settings.local.json.
    writeFileSync(path.join(h.root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)', 'Bash(git diff)'] } }, null, 2));
    const second = await h.approve();
    expect(second.mode).toBe('native');
    expect(h.questions).toHaveLength(1);
    expect(() => second.assertCurrent()).not.toThrow();
  });

  it('a decision stored with an earlier release\'s byte digest is kept and moved to the new digest without asking', async () => {
    const h = harness('Trust and load');
    const inspection = inspectRepositoryCliConfig('claude', h.root, h.root, { homeDirectory: path.dirname(h.root), ancestorBoundary: h.root });
    await h.state.set('trust', [{ ...repositoryCliTrustRecord(inspection, 'native'), digest: inspection.legacyDigest }]);
    await expect(h.approve()).resolves.toMatchObject({ mode: 'native' });
    expect(h.questions).toEqual([]);
    expect((h.state.get('trust') as Array<{ digest: string }>)[0].digest).toBe(inspection.digest);
  });

  it('a change to what the configuration can do asks once again (confirm-once for security configuration)', async () => {
    const h = harness('Trust and load');
    await h.approve();
    writeFileSync(path.join(h.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ command: 'node planted.js' }] } }));
    await h.approve();
    expect(h.questions).toHaveLength(2);
  });

  it('with Trust and load, a hook planted after the approval still stops that start; with project automation off it cannot matter', async () => {
    const trusted = harness('Trust and load');
    const native = await trusted.approve();
    writeFileSync(path.join(trusted.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ command: 'node planted.js' }] } }));
    expect(() => native.assertCurrent()).toThrow(/changed after you approved it/);

    const userOnly = harness('Continue without project automation');
    const restricted = await userOnly.approve();
    expect(restricted.mode).toBe('user-only');
    writeFileSync(path.join(userOnly.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ command: 'node planted.js' }] } }));
    expect(() => restricted.assertCurrent()).not.toThrow();
  });
});
