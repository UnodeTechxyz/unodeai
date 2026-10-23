import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import type { Message } from '../../types';
import { compileTaskContract, TaskInputResolver, type CandidateContractAgent } from '../TaskContract';
import { TeamTools, type TeamView } from '../TeamTools';
import { WorkspaceTools } from '../WorkspaceTools';
import { readRegularFileInsideRoot, type RegularFileReadHooks } from '../workspacePath';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

/*
 * v0.9.97 S0, defect A3 in released v0.9.96: a coordinator's dispatch-snapshot input passed a lexical check only,
 * then fs.readFile followed links, and the content was granted to the delegate as a content asset. A delegate's own
 * read_file refuses the same link. The canary below is a harmless marker string; no credential and no model is used.
 */

afterEach(removeTemporaryFolders);

const CANARY = 'S0-A3-CANARY-harmless-marker';
type SnapshotReader = (root: string, candidate: string, maxBytes: number) => ReturnType<typeof readRegularFileInsideRoot>;
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

/** A workspace with `docs/brief.md`, and outside it a folder holding the canary under the same names. */
async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await temporaryFolder('unode-a3-root-');
  const outside = await temporaryFolder('unode-a3-outside-');
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'brief.md'), 'the real brief', 'utf8');
  await fs.writeFile(path.join(outside, 'brief.md'), CANARY, 'utf8');
  await fs.writeFile(path.join(outside, 'canary.txt'), CANARY, 'utf8');
  await fs.symlink(outside, path.join(root, 'linked'), linkType);
  return { root, outside };
}

/** Swap `docs` for a link to the outside folder: the same path now names the canary. */
async function swapDocsForLink(root: string, outside: string): Promise<void> {
  await fs.rename(path.join(root, 'docs'), path.join(root, 'docs-before'));
  await fs.symlink(outside, path.join(root, 'docs'), linkType);
}

/** Remove one link itself, never what it points at. */
async function removeLink(link: string): Promise<void> {
  if (process.platform === 'win32') {
    await fs.rmdir(link); // a junction; rmdir removes the junction alone
  } else {
    await fs.unlink(link);
  }
}

/**
 * Codex's audit of 8c552a5, R4: a workspace root `bound` that is a link to `A`. The returned hook re-binds it to
 * `B` for good, and `B/docs` links back to `A/docs`, so the same path still reaches the same file, which is no longer
 * inside the root as it now is.
 */
async function reboundRootFixture(): Promise<{ bound: string; rebind: () => Promise<void> }> {
  const base = await temporaryFolder('unode-a3-rebound-');
  const a = path.join(base, 'A');
  const b = path.join(base, 'B');
  const bound = path.join(base, 'bound');
  await fs.mkdir(path.join(a, 'docs'), { recursive: true });
  await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'docs', 'brief.md'), 'the bound brief', 'utf8');
  await fs.symlink(a, bound, linkType);
  return {
    bound,
    rebind: async () => {
      await removeLink(bound);
      await fs.symlink(b, bound, linkType);
      await fs.symlink(path.join(a, 'docs'), path.join(b, 'docs'), linkType);
    },
  };
}

describe('A3: readRegularFileInsideRoot reads only a regular file physically inside the root', () => {
  it('reads a file, including one under a "..name" folder', async () => {
    const { root } = await fixture();
    await fs.mkdir(path.join(root, '..cache'));
    await fs.writeFile(path.join(root, '..cache', 'x.md'), 'cached', 'utf8');
    const read = await readRegularFileInsideRoot(root, 'docs/brief.md', 1024);
    expect(read).toMatchObject({ status: 'read' });
    expect(read.status === 'read' && read.bytes.toString('utf8')).toBe('the real brief');
    const cached = await readRegularFileInsideRoot(root, '..cache/x.md', 1024);
    expect(cached.status === 'read' && cached.bytes.toString('utf8')).toBe('cached');
  });

  it('names each reason it reads nothing', async () => {
    const { root } = await fixture();
    await fs.writeFile(path.join(root, 'big.md'), 'x'.repeat(2048), 'utf8');
    expect(await readRegularFileInsideRoot(root, 'linked/canary.txt', 1024)).toEqual({ status: 'refused', reason: 'scope' });
    expect(await readRegularFileInsideRoot(root, '../outside.md', 1024)).toEqual({ status: 'refused', reason: 'scope' });
    expect(await readRegularFileInsideRoot(root, '.', 1024)).toEqual({ status: 'refused', reason: 'scope' });
    expect(await readRegularFileInsideRoot(root, 'docs', 1024)).toEqual({ status: 'failed', reason: 'not-regular' });
    expect(await readRegularFileInsideRoot(root, 'docs/none.md', 1024)).toEqual({ status: 'failed', reason: 'missing' });
    expect(await readRegularFileInsideRoot(root, 'big.md', 1024)).toEqual({ status: 'failed', reason: 'too-large' });
  });

  it('refuses when the root is re-bound to another folder, though the target still reaches the same file', async () => {
    const { bound, rebind } = await reboundRootFixture();
    expect(await readRegularFileInsideRoot(bound, 'docs/brief.md', 1024)).toMatchObject({ status: 'read' });
    expect(await readRegularFileInsideRoot(bound, 'docs/brief.md', 1024, { afterResolve: rebind }))
      .toEqual({ status: 'refused', reason: 'changed' });
  });

  it('refuses when the path now reaches the same file somewhere else', async () => {
    const { root } = await fixture();
    const read = await readRegularFileInsideRoot(root, 'docs/brief.md', 1024, {
      afterResolve: async () => {
        // Root and file are unchanged; only the target's real path is no longer the one checked.
        await fs.rename(path.join(root, 'docs'), path.join(root, 'docs-moved'));
        await fs.symlink(path.join(root, 'docs-moved'), path.join(root, 'docs'), linkType);
      },
    });
    expect(read).toEqual({ status: 'refused', reason: 'changed' });
  });

  it('refuses when the root folder is moved and re-bound, though the file reached is the same file at the same path', async () => {
    const { bound } = await reboundRootFixture();
    const a = await fs.realpath(bound);
    const moved = `${a}-moved`;
    const read = await readRegularFileInsideRoot(bound, 'docs/brief.md', 1024, {
      afterResolve: async () => {
        // The root keeps its identity under a new path; a new A holds a hard link to the file, and the moved
        // root's docs link back to it. Only the root's real path changed.
        await fs.rename(a, moved);
        await removeLink(bound);
        await fs.symlink(moved, bound, linkType);
        await fs.mkdir(path.join(a, 'docs'), { recursive: true });
        await fs.link(path.join(moved, 'docs', 'brief.md'), path.join(a, 'docs', 'brief.md'));
        await fs.rename(path.join(moved, 'docs'), path.join(moved, 'docs-before'));
        await fs.symlink(path.join(a, 'docs'), path.join(moved, 'docs'), linkType);
      },
    });
    await fs.rm(moved, { recursive: true, force: true });
    expect(read).toEqual({ status: 'refused', reason: 'changed' });
  });

  it('refuses when the root folder is replaced by a new one at the same path that holds a hard link to the file', async () => {
    const { root } = await fixture();
    const read = await readRegularFileInsideRoot(root, 'docs/brief.md', 1024, {
      // Before the open: Windows refuses to rename a folder while a file inside it is open.
      afterResolve: async () => {
        // Both real paths stay the same and the file stays the same file: only the root's own identity changed.
        await fs.rename(root, `${root}-old`);
        await fs.mkdir(path.join(root, 'docs'), { recursive: true });
        await fs.link(path.join(`${root}-old`, 'docs', 'brief.md'), path.join(root, 'docs', 'brief.md'));
      },
    });
    await fs.rm(`${root}-old`, { recursive: true, force: true });
    expect(read).toEqual({ status: 'refused', reason: 'changed' });
  });

  describe('a change between its steps refuses the read', () => {
    const swaps: Array<[string, (root: string, outside: string) => RegularFileReadHooks]> = [
      ['a folder on the way becomes a link out, after resolving', (root, outside) => ({ afterResolve: () => swapDocsForLink(root, outside) })],
      ['the file is replaced by another, after resolving', (root) => ({
        afterResolve: async () => {
          await fs.writeFile(path.join(root, 'docs', 'other.md'), CANARY, 'utf8');
          await fs.rename(path.join(root, 'docs', 'other.md'), path.join(root, 'docs', 'brief.md'));
        },
      })],
      ['the root itself is moved and a link put in its place, after resolving', (root) => ({
        afterResolve: async () => {
          await fs.rename(root, `${root}-moved`);
          await fs.symlink(`${root}-moved`, root, linkType);
        },
      })],
      ['the file grows past the bound, after resolving', (root) => ({
        afterResolve: () => fs.appendFile(path.join(root, 'docs', 'brief.md'), 'x'.repeat(4096), 'utf8'),
      })],
    ];
    for (const [name, hooksFor] of swaps) {
      it(name, async () => {
        const { root, outside } = await fixture();
        try {
          const read = await readRegularFileInsideRoot(root, 'docs/brief.md', 1024, hooksFor(root, outside));
          expect(read.status).not.toBe('read');
          expect(JSON.stringify(read)).not.toContain(CANARY);
        } finally {
          await fs.rm(`${root}-moved`, { recursive: true, force: true });
        }
      });
    }

    it('the file is replaced by another, after reading', async () => {
      const { root } = await fixture();
      let replaced = false;
      const read = await readRegularFileInsideRoot(root, 'docs/brief.md', 1024, {
        afterRead: async () => {
          await fs.writeFile(path.join(root, 'docs', 'other.md'), 'replacement', 'utf8');
          try {
            await fs.rename(path.join(root, 'docs', 'other.md'), path.join(root, 'docs', 'brief.md'));
            replaced = true;
          } catch (error) {
            // Windows refuses to replace a file that is open, so there the swap cannot happen at all.
            expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
          }
        },
      });
      if (replaced) {
        expect(read).toEqual({ status: 'refused', reason: 'changed' });
      } else {
        expect(read.status === 'read' && read.bytes.toString('utf8')).toBe('the real brief');
      }
    });
  });
});

function snapshotContract(paths: string[], extraInputs: Array<Record<string, unknown>> = []) {
  const result = compileTaskContract({
    version: 1,
    objective: 'Inspect the declared source and deliver a bounded result.',
    expected_deliverable: 'A concrete result.',
    effects: { read_files: paths, expected_file_effect: 'none' },
    inputs: [
      ...paths.map((inputPath, index) => ({
        input_id: `snapshot-${index + 1}`, kind: 'workspacePath', path: inputPath, purpose: 'Frozen source',
        required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
      })),
      ...extraInputs,
    ],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
  }, 'pm');
  expect(result.error).toBeUndefined();
  return result.contract!;
}

function worker(extras: Partial<CandidateContractAgent> = {}): CandidateContractAgent {
  return {
    agentId: 'worker',
    capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn',
    verificationSensors: [],
    authorizedContentAssetIds: [],
    liveContentAssetIds: [],
    readyArtifacts: [],
    ...extras,
  };
}

describe('A3: the resolver takes a snapshot only of what the delegate itself may read', () => {
  it('refuses a snapshot through a link out of the workspace, as the delegate\'s own read is refused', async () => {
    const { root } = await fixture();
    expect(await new WorkspaceTools(root, new Set(['read'])).run('read_file', { path: 'linked/canary.txt' })).toMatchObject({ status: 'refused' });
    const store = new ContentAssetStore();
    const stored = vi.spyOn(store, 'storeText');
    try {
      const attempt = await new TaskInputResolver(store, root).beginAttempt(snapshotContract(['linked/canary.txt']), worker(), 'pm');
      expect(attempt.card).toBeUndefined();
      expect(attempt.error).toMatch(/task-scope: workspace snapshot input "snapshot-1" is outside the workspace this assignment may read/);
      expect(stored).not.toHaveBeenCalled();
    } finally {
      await store.dispose();
    }
  });

  it('names the reason: missing, not a regular file, too large', async () => {
    const { root } = await fixture();
    await fs.writeFile(path.join(root, 'big.md'), 'x'.repeat(200_001), 'utf8');
    const store = new ContentAssetStore();
    try {
      const resolver = new TaskInputResolver(store, root);
      const errorOf = async (inputPath: string) => (await resolver.beginAttempt(snapshotContract([inputPath]), worker(), 'pm')).error;
      expect(await errorOf('docs/none.md')).toMatch(/does not exist/);
      expect(await errorOf('docs')).toMatch(/is not a regular file/);
      expect(await errorOf('big.md')).toMatch(/is too large to snapshot/);
    } finally {
      await store.dispose();
    }
  });

  it('keeps nothing of a refused attempt: no earlier snapshot, no reservation, and no asset it did not create is touched', async () => {
    const { root } = await fixture();
    const store = new ContentAssetStore();
    const stored = vi.spyOn(store, 'storeText');
    try {
      const shared = await store.storeText('SHARED SOURCE', 'turn-supplied');
      if ('error' in shared) throw new Error('fixture storage failed');
      stored.mockClear();
      const resolver = new TaskInputResolver(store, root);
      const sharedInput = {
        input_id: 'shared', kind: 'contentAsset', asset_id: shared.assetId, purpose: 'Shared source',
        required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
      };
      const contract = snapshotContract(['docs/brief.md', 'linked/canary.txt'], [sharedInput]);
      const candidate = worker({ authorizedContentAssetIds: [shared.assetId], liveContentAssetIds: [shared.assetId] });
      const refused = await resolver.beginAttempt(contract, candidate, 'pm');
      expect(refused.error).toMatch(/snapshot-2/);
      // The first input's snapshot was stored, then discarded with the attempt.
      expect(stored).toHaveBeenCalledTimes(1);
      const firstSnapshot = await stored.mock.results[0].value as { assetId: string };
      expect(store.getReceipt(firstSnapshot.assetId)).toBeUndefined();
      expect(store.getReceipt(shared.assetId)).toBeDefined();
      // The reservation is released: the contract can be attempted again once its input is fixed.
      await fs.rm(path.join(root, 'linked'), { recursive: true, force: true });
      await fs.mkdir(path.join(root, 'linked'));
      await fs.writeFile(path.join(root, 'linked', 'canary.txt'), 'now inside', 'utf8');
      expect((await resolver.beginAttempt(contract, candidate, 'pm')).card).toBeDefined();
    } finally {
      await store.dispose();
    }
  });
});

const roster = [
  { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
  {
    id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
    capabilities: { read: true, write: false, shell: false, verificationSensors: [], toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const },
  },
];
const view: TeamView = {
  list: () => roster,
  preflightTaskScope: () => undefined,
  resolve: (ref) => (ref === 'dev' ? { id: 'dev' } : ref === 'pm' ? { id: 'pm' } : undefined),
};

/**
 * The real delegation entry: TeamTools' dispatch_task, the production resolver and store, and a fake delegate that
 * only records what it was handed. Nothing calls a provider.
 */
async function dispatchSnapshot(root: string, paths: string[], readSnapshot?: SnapshotReader) {
  const store = new ContentAssetStore();
  const stored = vi.spyOn(store, 'storeText');
  const resolver = readSnapshot ? new TaskInputResolver(store, root, readSnapshot) : new TaskInputResolver(store, root);
  const bus = new MessageBus();
  const assigned: Message[] = [];
  bus.onType('task.assign', (message: Message) => { assigned.push(message); });
  const tools = new TeamTools('pm', view, bus, { timeoutMs: 1_000, taskInputResolver: resolver });
  const contract = snapshotContract(paths);
  const raw = {
    version: 1,
    objective: contract.objective,
    expected_deliverable: 'A concrete result.',
    effects: { read_files: paths, expected_file_effect: 'none' },
    inputs: contract.inputs.map((input) => ({
      input_id: input.inputId, kind: 'workspacePath', path: input.kind === 'workspacePath' ? input.path : '',
      purpose: 'Frozen source', required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
    })),
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
  };
  const output = (await tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Inspect the frozen source.', contract: raw })).output;
  const storedTexts = stored.mock.calls.map((call) => String(call[0]));
  return { store, output, assigned, storedTexts };
}

describe('A3 through the real delegation entry (TeamTools dispatch_task, fake delegate)', () => {
  it('refuses a snapshot through a link out: no delegate is started and the canary is never stored', async () => {
    const { root } = await fixture();
    const run = await dispatchSnapshot(root, ['linked/canary.txt']);
    try {
      expect(run.output).toMatch(/outside the workspace this assignment may read/);
      expect(run.assigned).toEqual([]);
      expect(run.storedTexts.join('\n')).not.toContain(CANARY);
    } finally {
      await run.store.dispose();
    }
  });

  it('hands an ordinary snapshot to the delegate', async () => {
    const { root } = await fixture();
    const run = await dispatchSnapshot(root, ['docs/brief.md']);
    try {
      expect(run.assigned).toHaveLength(1);
      const assetId = run.assigned[0].payload.taskAttempt.grants[0].resolvedContentAssetId as string;
      const snapshot = await run.store.readExtractedContent(assetId, { start: 1, end: 1 });
      expect('error' in snapshot ? snapshot.error : snapshot.items[0].text).toContain('the real brief');
    } finally {
      await run.store.dispose();
    }
  });

  it('a later input\'s refusal discards the earlier snapshot and starts no delegate', async () => {
    const { root } = await fixture();
    const run = await dispatchSnapshot(root, ['docs/brief.md', 'linked/canary.txt']);
    try {
      expect(run.output).toMatch(/snapshot-2/);
      expect(run.assigned).toEqual([]);
      expect(run.storedTexts).toEqual(['the real brief']);
      expect(run.storedTexts.join('\n')).not.toContain(CANARY);
    } finally {
      await run.store.dispose();
    }
  });

  it('a root re-bound to another folder during the read is refused: no delegate, nothing stored', async () => {
    const { bound, rebind } = await reboundRootFixture();
    const run = await dispatchSnapshot(bound, ['docs/brief.md'], (snapshotRoot, candidate, maxBytes) =>
      readRegularFileInsideRoot(snapshotRoot, candidate, maxBytes, { afterResolve: rebind }));
    try {
      expect(run.output).toMatch(/changed while it was being read/);
      expect(run.assigned).toEqual([]);
      expect(run.storedTexts).toEqual([]);
    } finally {
      await run.store.dispose();
    }
  });

  it('a folder swapped for a link out between resolving and reading is refused: no delegate, no canary', async () => {
    const { root, outside } = await fixture();
    const run = await dispatchSnapshot(root, ['docs/brief.md'], (snapshotRoot, candidate, maxBytes) =>
      readRegularFileInsideRoot(snapshotRoot, candidate, maxBytes, { afterResolve: () => swapDocsForLink(root, outside) }));
    try {
      expect(run.output).toMatch(/changed while it was being read/);
      expect(run.assigned).toEqual([]);
      expect(run.storedTexts.join('\n')).not.toContain(CANARY);
    } finally {
      await run.store.dispose();
    }
  });
});
