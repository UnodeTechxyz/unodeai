import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContentAssetStore } from '../ContentAssetStore';
import { noteDelegatedSourcesDelivered, readDelegatedSourceInline } from '../DelegatedSourceRead';
import { compileTaskContract, TaskInputResolver, type CandidateContractAgent } from '../../backend/TaskContract';
import type { DelegationContentSource } from '../../session/TurnContextManifest';

// v0.9.97 ATTACH-CODEX. SECURITY.md "Attachments on a Codex agent": a source handed to a Codex teammate reaches it
// only through the reader tools' own grant rule, checked when the turn is sent; a withdrawn grant delivers nothing.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const roots: string[] = [];
const stores: ContentAssetStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function newStore(options: ConstructorParameters<typeof ContentAssetStore>[0] = {}): ContentAssetStore {
  const store = new ContentAssetStore(options);
  stores.push(store);
  return store;
}

function descriptor(assetId: string, mediaKind: DelegationContentSource['mediaKind']): DelegationContentSource {
  return { assetId, kind: 'user-attachment', label: 'source', location: 'user attachment', mediaKind };
}

function stored<T extends object>(value: T | { error: string }): T {
  if ('error' in value) throw new Error(`fixture storage failed: ${String(value.error)}`);
  return value as T;
}

function contractFor(assetId: string) {
  const result = compileTaskContract({
    version: 1,
    objective: 'Use the forwarded brief.',
    expected_deliverable: 'A summary.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [{
      input_id: 'brief', kind: 'contentAsset', asset_id: assetId, purpose: 'User brief',
      required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
    }],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
  }, 'pm');
  expect(result.error).toBeUndefined();
  return result.contract!;
}

function candidate(agentId: string, assetIds: string[]): CandidateContractAgent {
  return {
    agentId,
    capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn',
    verificationSensors: [],
    authorizedContentAssetIds: assetIds,
    liveContentAssetIds: assetIds,
    readyArtifacts: [],
  };
}

describe('readDelegatedSourceInline', () => {
  it('reads a handed text source whole and an image as a data URL of its own bytes', async () => {
    const store = newStore();
    const text = stored(await store.storeText('### brief.md\n```\nthe brief\n```', 'turn-supplied'));
    const image = stored(await store.storeImage(PNG, 'user-attachment', 'image/png'));

    expect(await readDelegatedSourceInline(store, undefined, 'worker', descriptor(text.assetId, 'text'), undefined))
      .toEqual({ kind: 'text', assetId: text.assetId, text: '### brief.md\n```\nthe brief\n```' });
    expect(await readDelegatedSourceInline(store, undefined, 'worker', descriptor(image.assetId, 'image'), undefined))
      .toEqual({ kind: 'image', assetId: image.assetId, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, mimeType: 'image/png', byteLength: PNG.byteLength });
  });

  it('reads a text source longer than one page in full and in order', async () => {
    const store = newStore();
    const long = 'a'.repeat(20_000) + 'b'.repeat(20_000) + 'tail';
    const text = stored(await store.storeText(long, 'turn-supplied'));
    const read = await readDelegatedSourceInline(store, undefined, 'worker', descriptor(text.assetId, 'text'), undefined);
    expect(read.kind === 'text' && read.text === long).toBe(true);
  });

  it('does not deliver a PDF, a source whose descriptor names another kind, or an expired one', async () => {
    let now = 1_000;
    const store = newStore({ now: () => now, ttlMs: 10 });
    const pdf = stored(await store.storePdf(Buffer.from('%PDF-1.7\nx'), 'user-attachment'));
    const image = stored(await store.storeImage(PNG, 'user-attachment', 'image/png'));
    const text = stored(await store.storeText('brief', 'turn-supplied'));

    expect(await readDelegatedSourceInline(store, undefined, 'worker', descriptor(pdf.assetId, 'pdf'), undefined))
      .toEqual({ kind: 'not-delivered', assetId: pdf.assetId, reason: 'pdf-unsupported' });
    expect(await readDelegatedSourceInline(store, undefined, 'worker', descriptor(image.assetId, 'text'), undefined))
      .toEqual({ kind: 'not-delivered', assetId: image.assetId, reason: 'unsupported' });
    now += 11;
    expect(await readDelegatedSourceInline(store, undefined, 'worker', descriptor(text.assetId, 'text'), undefined))
      .toEqual({ kind: 'not-delivered', assetId: text.assetId, reason: 'expired' });
  });

  it('delivers a contract input only to the agent of the live attempt that holds its grant, and not once it is withdrawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-delegated-read-'));
    roots.push(root);
    const store = newStore();
    const resolver = new TaskInputResolver(store, root);
    const granted = stored(await store.storeText('GRANTED', 'turn-supplied'));
    const other = stored(await store.storeText('NOT IN THE CONTRACT', 'turn-supplied'));
    const attempt = await resolver.beginAttempt(contractFor(granted.assetId), candidate('worker', [granted.assetId]), 'pm');
    const attemptId = attempt.card!.attemptId;

    expect(await readDelegatedSourceInline(store, resolver, 'worker', descriptor(granted.assetId, 'text'), attemptId))
      .toEqual({ kind: 'text', assetId: granted.assetId, text: 'GRANTED' });
    // Another agent, and an asset the attempt does not grant, get nothing.
    expect(await readDelegatedSourceInline(store, resolver, 'intruder', descriptor(granted.assetId, 'text'), attemptId))
      .toMatchObject({ kind: 'not-delivered', reason: 'not-granted' });
    expect(await readDelegatedSourceInline(store, resolver, 'worker', descriptor(other.assetId, 'text'), attemptId))
      .toMatchObject({ kind: 'not-delivered', reason: 'not-granted' });

    noteDelegatedSourcesDelivered(resolver, 'worker', attemptId, [granted.assetId]);
    expect(resolver.grantsForAttempt(attemptId)[0]).toMatchObject({ readAt: expect.any(String), reachableAt: expect.any(String) });

    // The grant is withdrawn with its attempt.
    resolver.endAttempt(attemptId, 'cancelled');
    expect(await readDelegatedSourceInline(store, resolver, 'worker', descriptor(granted.assetId, 'text'), attemptId))
      .toMatchObject({ kind: 'not-delivered', reason: 'not-granted' });
  });

  it('delivers an asset a contract manages only through a live attempt\'s grant, never by the handoff alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-delegated-read-'));
    roots.push(root);
    const store = newStore();
    const resolver = new TaskInputResolver(store, root);
    const source = stored(await store.storeText('SOURCE', 'turn-supplied'));
    const producer = await resolver.beginAttempt(contractFor(source.assetId), candidate('producer', [source.assetId]), 'pm');
    const published = await resolver.publishArtifact(producer.card!.attemptId, 'producer', 'PUBLISHED OUTPUT');
    const artifactAsset = published.artifact!.contentAssetId;
    expect(resolver.isContractManagedContentAsset(artifactAsset)).toBe(true);

    // Handed without a contract attempt, the artifact is not delivered, even to the agent that made it.
    for (const agentId of ['producer', 'worker']) {
      expect(await readDelegatedSourceInline(store, resolver, agentId, descriptor(artifactAsset, 'text'), undefined))
        .toMatchObject({ kind: 'not-delivered', reason: 'not-granted' });
    }
  });
});
