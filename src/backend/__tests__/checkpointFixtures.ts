import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { compileTaskContract, type CandidateContractAgent, type EffectiveTaskContract, type TaskInputResolver } from '../TaskContract';
import { TaskCheckpointStore, type CheckpointFileSystem } from '../TaskCheckpoints';

/** v0.9.97 L1 fixtures: a contract that delivers in batches, the candidate it is granted to, and a durable store. */

export const ARTICLE_SECTIONS = [{ key: 'intro', title: 'Introduction' }, { key: 'body' }, { key: 'close' }];

export function incrementalProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Draft the article.',
    expected_deliverable: 'The article, section by section.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    required_capabilities: { version: 1, capabilities: [] },
    execution_strategy: 'delegate-required',
    delivery: { mode: 'incremental', sections: ARTICLE_SECTIONS, batch_target: 'one complete section' },
    ...overrides,
  };
}

export function incrementalContract(overrides: Record<string, unknown> = {}, proposedBy = 'pm'): EffectiveTaskContract {
  const compiled = compileTaskContract(incrementalProposal(overrides), proposedBy);
  if (!compiled.contract) throw new Error(compiled.error);
  return compiled.contract;
}

export function candidateFor(
  resolver: TaskInputResolver,
  agentId: string,
  overrides: Partial<CandidateContractAgent> = {},
): CandidateContractAgent {
  return {
    agentId,
    capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn',
    verificationSensors: [],
    authorizedContentAssetIds: [],
    liveContentAssetIds: [],
    readyArtifacts: resolver.readyArtifacts(),
    ...overrides,
  };
}

/** A durable store in a fresh temporary folder, and the cleanup that removes it. */
export async function temporaryCheckpointStore(fs?: CheckpointFileSystem): Promise<{ store: TaskCheckpointStore; root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'unode-l1-checkpoints-'));
  return {
    store: new TaskCheckpointStore({ root, ...(fs ? { fs } : {}) }),
    root,
    // An attempt's end is written fire-and-forget (a stop records the draft), so on Windows such a write can still be
    // landing while the folder is removed: retry instead of failing the test with ENOTEMPTY or EPERM.
    dispose: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
  };
}

/** Let fire-and-forget store writes (an attempt's end) finish. */
export async function settleStoreWrites(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}
