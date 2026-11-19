import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { SessionLocalReadScopeConsent } from '../../../backend/localReadScope';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig } from '../../../types';

/*
 * v0.9.101 (the access table's state rule, R1 §2.2, R2 §1): one consumer's access to one target, judged by the facts
 * admission uses, under that consumer's own reach. A limit is the agent's own Folder Access, which no grant widens.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const folder = (files: Record<string, string> = {}) => {
  const made = tempFolder(files, 'unode-judge-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
};

function world() {
  const root = folder({ 'notes.md': 'workspace' });
  const outDir = folder({ 'kept.txt': 'kept' });
  const consent = new SessionLocalReadScopeConsent(async () => false);
  const configs: Record<string, AgentConfig> = {
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root }),
    limited: agentConfig('limited', { backend: 'openai-compat', workingDirectory: root, folderAccess: [{ path: outDir, permission: 'read' }] }),
  };
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => [], isTrusted: () => true }),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: () => 'r1',
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const grant = (target: string, permission: 'read' | 'readwrite') => consent.requestPathAccess(target,
    { requestId: 'r1', isCurrent: () => true }, async () => ({ permission, lifetime: 'request' }));
  return { root, outDir, configs, adapter, grant };
}

describe('judgeAccess: the access table\'s state rule', () => {
  it('a limit is the agent\'s own Folder Access: Read + Write in a read-only entry, or anything outside it, and no grant changes that', async () => {
    const w = world();
    const inside = path.join(w.outDir, 'summary.docx');
    expect(w.adapter.judgeAccess(w.configs.limited, 'r1', inside, 'readwrite').state).toBe('limit');
    expect(w.adapter.judgeAccess(w.configs.limited, 'r1', path.join(w.outDir, 'kept.txt'), 'read').state).toBe('met');
    const outside = path.join(folder(), 'other.txt');
    expect(w.adapter.judgeAccess(w.configs.limited, 'r1', outside, 'read').state).toBe('limit');
    await w.grant(w.outDir, 'readwrite');
    expect(w.adapter.judgeAccess(w.configs.limited, 'r1', inside, 'readwrite').state).toBe('limit');
  });

  it('Read held where Read + Write is needed is partial; Read + Write meets it, and a grant is reported as granted', async () => {
    const w = world();
    const inside = path.join(w.outDir, 'summary.docx');
    expect(w.adapter.judgeAccess(w.configs.dev, 'r1', inside, 'readwrite')).toMatchObject({ state: 'missing', effective: 'none', granted: 'none' });
    await w.grant(w.outDir, 'read');
    expect(w.adapter.judgeAccess(w.configs.dev, 'r1', inside, 'readwrite')).toMatchObject({ state: 'partial', effective: 'read', granted: 'read', source: 'grant' });
    await w.grant(w.outDir, 'readwrite');
    expect(w.adapter.judgeAccess(w.configs.dev, 'r1', inside, 'readwrite')).toMatchObject({ state: 'met', effective: 'readwrite', granted: 'readwrite', source: 'grant' });
  });

  it('existence is not access: a file still to be made, under a granted folder, is met for Read', async () => {
    const w = world();
    const notYet = path.join(w.outDir, 'not-yet.txt');
    expect(w.adapter.judgeAccess(w.configs.dev, 'r1', notYet, 'read').state).toBe('missing');
    await w.grant(w.outDir, 'read');
    expect(w.adapter.judgeAccess(w.configs.dev, 'r1', notYet, 'read').state).toBe('met');
  });

  it('reach that is not a grant is never reported as granted', () => {
    const w = world();
    expect(w.adapter.judgeAccess(w.configs.dev, 'r1', path.join(w.root, 'notes.md'), 'readwrite'))
      .toMatchObject({ state: 'met', granted: 'none', source: 'configured' });
  });
});
