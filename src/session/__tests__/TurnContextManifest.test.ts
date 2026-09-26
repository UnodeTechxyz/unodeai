import { describe, expect, it } from 'vitest';
import { createTurnContextManifest, delegatedContentManifestSource, textContextSource } from '../TurnContextManifest';

describe('TurnContextManifest', () => {
  it('records each supplied source once with an honest text estimate and explicit unavailable filesystem fields', () => {
    const manifest = createTurnContextManifest([
      textContextSource('user-request', 'Current task', 'chat composer', 'Inspect src/app.ts', 'user-entered task'),
      textContextSource('context-mention', 'Explicit @ context (1)', '@src/app.ts', '\n\n[context]', 'user @file request'),
      {
        kind: 'user-attachment',
        label: 'diagram.png',
        location: 'user image attachment',
        bytes: 128,
        reason: 'user attached an image; image token estimate is unavailable',
      },
    ]);

    expect(manifest.sourceCount).toBe(3);
    expect(manifest.totalBytes).toBe(157);
    expect(manifest.estimatedTextTokens).toBe(8);
    expect(manifest.entries).toMatchObject([
      {
        label: 'Current task',
        bytes: 18,
        estimatedTokens: 5,
        tokenEstimate: 'bytes / 4',
        staleness: 'unavailable',
        sensitivity: 'unavailable',
      },
      {
        label: 'Explicit @ context (1)',
        bytes: 11,
        estimatedTokens: 3,
        reason: 'user @file request',
      },
      {
        label: 'diagram.png',
        bytes: 128,
        tokenEstimate: 'unavailable',
        staleness: 'unavailable',
        sensitivity: 'unavailable',
      },
    ]);
    expect(manifest.entries[2]?.estimatedTokens).toBeUndefined();
  });

  it('reports filesystem age and only mechanical sensitivity signals without copying secret content', () => {
    const manifest = createTurnContextManifest([{
      kind: 'repository-instruction',
      label: '.env',
      location: '.env',
      text: 'OPENAI_API_KEY=sk-not-the-real-token',
      reason: 'fixture',
      modifiedAt: '2020-01-01T00:00:00.000Z',
      fileMode: 0o600,
      gitIgnored: true,
      sensitivitySignals: ['OpenAI-style API key', 'sensitive path convention'],
    }]);

    expect(manifest.entries[0]).toMatchObject({
      staleness: 'unchanged-90-days-or-more',
      ageDays: expect.any(Number),
      sensitivity: 'potentially-sensitive',
      sensitivitySignals: expect.arrayContaining([
        'OpenAI-style API key',
        'sensitive path convention',
        'path is matched by .gitignore',
        'owner-only filesystem mode',
      ]),
    });
    expect(JSON.stringify(manifest.entries[0])).not.toContain('sk-not-the-real-token');
  });

  it('records forwarded user sources by opaque receipt without duplicating standing project context', () => {
    const delegated = delegatedContentManifestSource({
      assetId: 'content-7', kind: 'context-mention', label: 'Customer brief', location: '@brief.md',
      textBytes: 88, mediaKind: 'text',
    });
    const manifest = createTurnContextManifest([
      textContextSource('user-request', 'Current task', 'delegated instruction', 'Verify the supplied brief.', 'message routed to this agent'),
      delegated,
      textContextSource('project-conventions', 'Project conventions', 'workspace metadata', 'Use npm test.', 'fixed project-conventions path'),
    ]);

    expect(manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'context-mention', label: 'Delegated user source: Customer brief', bytes: 88 }),
    ]));
    expect(manifest.entries.filter((entry) => entry.kind === 'project-conventions')).toHaveLength(1);
    expect(JSON.stringify(manifest)).not.toContain('content-7');
  });

  it('records bounded typed trust counts for the exact shared-memory source without note prose', () => {
    const note = '<shared_memory><note>private row body</note></shared_memory>';
    const manifest = createTurnContextManifest([{
      kind: 'shared-memory',
      label: 'Shared team memory',
      location: '.unode/memory/notes.md',
      text: note,
      reason: 'physically confined primary-workspace memory',
      memoryTrustCounts: { untrusted: 2, humanAttested: 1 },
    }]);

    expect(manifest.entries[0]).toMatchObject({
      kind: 'shared-memory',
      bytes: Buffer.byteLength(note, 'utf8'),
      memoryTrustCounts: { untrusted: 2, humanAttested: 1 },
    });
    expect(JSON.stringify(manifest)).not.toContain('private row body');
  });

  it('drops malformed trust counts and never accepts them on another source kind', () => {
    const manifest = createTurnContextManifest([
      {
        kind: 'shared-memory', label: 'Memory', location: '.unode/memory/notes.md', text: 'x', reason: 'fixture',
        memoryTrustCounts: { untrusted: 31, humanAttested: 0 },
      },
      {
        kind: 'user-request', label: 'Task', location: 'chat', text: 'x', reason: 'fixture',
        memoryTrustCounts: { untrusted: 1, humanAttested: 0 },
      },
    ]);

    expect(manifest.entries[0].memoryTrustCounts).toBeUndefined();
    expect(manifest.entries[1].memoryTrustCounts).toBeUndefined();
  });
});
