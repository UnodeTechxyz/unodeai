import { describe, expect, it, vi } from 'vitest';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../OfficeArtifactHistory';
import type { OfficeWrittenFact } from '../OfficeArtifactContracts';

// 13.10 source check over recorded hash edges: verification only, never a grant.
const sha = (n: number) => n.toString(16).padStart(64, '0');
const D0 = sha(1), D1 = sha(2), X0 = sha(3), XC = sha(4), OTHER = sha(5), X9 = sha(6), D2 = sha(7);
function setup(options: { saved?: boolean } = {}) {
  const records: OfficeArtifactRecord[] = [];
  const history = new OfficeArtifactHistory({ failed: vi.fn(), write: async (_key, record) => { records.push(record); },
    ...(options.saved === false ? {} : { saved: () => records }) });
  const write = (fact: Partial<OfficeWrittenFact> & Pick<OfficeWrittenFact, 'format' | 'sha256'>) => history.written({ operationId: 'op', artifactId: 'file-' + fact.sha256.slice(-2),
    bytes: 1, agentId: 'agent', effect: 'created', ...fact });
  return { history, records, write };
}

describe('OfficeArtifactHistory.exportSourceConfirmed', () => {
  it('confirms the exported document, through an edit_pdf output and a later tracked edit of the document', async () => {
    const { history, write } = setup();
    write({ format: 'pdf', sha256: X0, sourceSha256: D0 });              // export_pdf: D0 -> X0
    write({ format: 'pdf', sha256: XC, sourceSha256: X0 });              // edit_pdf merge: X0 (first input) -> XC
    write({ format: 'docx', sha256: D1, sourceSha256: D0, previousSha256: D0, artifactId: 'contract' }); // edit_office in place
    await history.flush();
    expect(history.exportSourceConfirmed(X0, { sha256: D0 })).toBe(true);
    expect(history.exportSourceConfirmed(XC, { sha256: D1 })).toBe(true);
    expect(history.exportSourceConfirmed(XC, { sha256: OTHER })).toBe(false);
  });

  it('knows records not yet saved (this session) as well as saved ones from earlier sessions', () => {
    const { history, write } = setup({ saved: false });
    write({ format: 'pdf', sha256: X0, sourceSha256: D0 });
    expect(history.exportSourceConfirmed(X0, { sha256: D0 })).toBe(true);
    const restored = new OfficeArtifactHistory({ failed: vi.fn(), write: async () => {}, saved: () => [{ schemaVersion: 1, kind: 'file', format: 'pdf', artifactId: 'x',
      versions: [{ sha256: X0, kind: 'office-output' }], derivations: [{ fromSha256: D0, toSha256: X0, kind: 'edit-source' }] }] });
    expect(restored.exportSourceConfirmed(X0, { sha256: D0 })).toBe(true);
  });

  it('confirms by the same file when the document changed outside UnodeAi after a recorded version', async () => {
    const { history, write } = setup();
    write({ format: 'docx', sha256: D1, sourceSha256: D0, artifactId: 'contract' }); // UnodeAi wrote D1 at this file
    write({ format: 'pdf', sha256: X0, sourceSha256: D1 });                           // and exported D1
    await history.flush();
    expect(history.exportSourceConfirmed(X0, { sha256: D2, artifactId: 'contract' })).toBe(true);
    expect(history.exportSourceConfirmed(X0, { sha256: D2, artifactId: 'another-file' })).toBe(false);
    expect(history.exportSourceConfirmed(X0, { sha256: D2 })).toBe(false);
  });

  it('a PDF that only replaced an exported PDF at the same path is not that export', async () => {
    const { history, write } = setup();
    write({ format: 'pdf', sha256: X0, sourceSha256: D0, artifactId: 'out' });
    write({ format: 'pdf', sha256: X9, previousSha256: X0, artifactId: 'out' }); // a different PDF later saved over it
    await history.flush();
    expect(history.exportSourceConfirmed(X9, { sha256: D0 })).toBe(false);
  });

  it('follows only edit and earlier-version edges of the document, never data sources', async () => {
    const { history, write } = setup();
    write({ format: 'pdf', sha256: X0, sourceSha256: D0 });
    history.written({ operationId: 'op', artifactId: 'report', sha256: D1, bytes: 1, agentId: 'agent', effect: 'created', format: 'docx',
      dataBindings: [{ transformation_ref: 't', sources: [{ snapshot_ref: 's', sha256: D0 }], selection: {} as any, partial: false } as any] });
    await history.flush();
    expect(history.exportSourceConfirmed(X0, { sha256: D1 })).toBe(false);
  });

  it('a DOCX converted from a PDF is never confirmed as that PDF\u2019s export source', async () => {
    const { history, write } = setup();
    write({ format: 'docx', sha256: D1, sourceSha256: X0, sourceKind: 'pdf-conversion' });
    await history.flush();
    expect(history.exportSourceConfirmed(X0, { sha256: D1 })).toBe(false);
  });

  it('convertedFrom finds the converted PDF through later edits, exports and PDF edits, and its earlier PDF versions', async () => {
    const { history, write } = setup();
    write({ format: 'pdf', sha256: XC, sourceSha256: X0 });                                   // signed X0 -> edited XC
    write({ format: 'docx', sha256: D1, sourceSha256: XC, sourceKind: 'pdf-conversion' });    // convert_pdf_to_docx
    write({ format: 'docx', sha256: D2, sourceSha256: D1 });                                  // edit_office
    write({ format: 'pdf', sha256: X9, sourceSha256: D2 });                                   // export_pdf
    write({ format: 'pdf', sha256: OTHER, sourceSha256: X9 });                                // edit_pdf of the export
    await history.flush();
    expect(new Set(history.convertedFrom(OTHER))).toEqual(new Set([XC, X0]));
    expect(history.convertedFrom(XC)).toEqual([]);
    expect(history.convertedFrom(D0)).toEqual([]);
  });

  it('convertedFrom follows every PDF an edit took pages from, not only its first input', async () => {
    const { history, write } = setup();
    write({ format: 'docx', sha256: D1, sourceSha256: X0, sourceKind: 'pdf-conversion' });       // signed X0 converted
    write({ format: 'pdf', sha256: X9, sourceSha256: D1 });                                       // exported
    write({ format: 'pdf', sha256: XC, sourceSha256: OTHER, pageSourceSha256: [X9, OTHER] });    // merged after a cover
    await history.flush();
    expect(history.convertedFrom(XC)).toEqual([X0]);
    expect(history.convertedFrom(OTHER)).toEqual([]);
  });

  it('ignores malformed saved records and an unreadable store', () => {
    const broken = new OfficeArtifactHistory({ failed: vi.fn(), write: async () => {}, saved: () => [null, 7, { kind: 'file', format: 'pdf', derivations: [{ fromSha256: 'x', toSha256: X0, kind: 'edit-source' }] },
      { kind: 'image', format: 'pdf', derivations: [{ fromSha256: D0, toSha256: X0, kind: 'edit-source' }] }] });
    expect(broken.exportSourceConfirmed(X0, { sha256: D0 })).toBe(false);
    const throwing = new OfficeArtifactHistory({ failed: vi.fn(), write: async () => {}, saved: () => { throw Error('state unavailable'); } });
    expect(throwing.exportSourceConfirmed(X0, { sha256: D0 })).toBe(false);
  });
});
