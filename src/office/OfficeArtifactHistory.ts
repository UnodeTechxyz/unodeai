import { randomUUID } from 'node:crypto';
import type { OfficeAssetHistorySink, OfficeImageBinding, OfficeImageOrigin, OfficeVisualReceipt } from './OfficeVisualContracts';
import type { OfficeWrittenFact } from './OfficeArtifactContracts';

interface ByteVersion { sha256: string; kind: 'office-source' | 'render-copy' | 'image-original' | 'transport-preview' | 'office-output'; bytes?: number }
interface Derivation { fromSha256: string; toSha256: string; kind: 'passive-copy' | 'render-page' | 'transport-preview' | 'source-data' | 'edit-source' | 'previous-version' | 'pdf-conversion' | 'page-source'; transformationRef?: string }
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
interface HistoryFile { format: string; artifactId: string; derivations: Derivation[]; outputs: string[] }
/** Every hash reachable backwards from `start` over the given edge kinds of file records of the given formats. */
function fileAncestors(files: readonly HistoryFile[], start: Iterable<string>, formats: readonly string[], kinds: readonly Derivation['kind'][]): Set<string> {
  const parents = new Map<string, string[]>();
  for (const file of files) {
    if (!formats.includes(file.format)) continue;
    for (const edge of file.derivations) if (kinds.includes(edge.kind)) parents.set(edge.toSha256, [...(parents.get(edge.toSha256) ?? []), edge.fromSha256]);
  }
  const found = new Set(start); const queue = [...found];
  while (queue.length) {
    for (const parent of parents.get(queue.shift()!) ?? []) if (!found.has(parent)) { found.add(parent); queue.push(parent); }
  }
  return found;
}
interface OfficeRecordBase {
  schemaVersion: 1; eventId: string; observedAt: string; agentId: string; attemptId?: string;
  operationId: string; versions: ByteVersion[]; derivations: Derivation[];
}
export interface OfficeImageArtifactRecord extends OfficeRecordBase {
  kind: 'image'; assetRef: string;
  origin: OfficeImageOrigin; delivery?: OfficeVisualReceipt;
}
export interface OfficeFileArtifactRecord extends OfficeRecordBase {
  kind: 'file'; artifactId: string; format: OfficeWrittenFact['format']; requestId?: string; turnId?: string;
  effect: OfficeWrittenFact['effect']; restorePointId?: string;
  data: Array<{ transformationRef: string; sources: Array<{ snapshotRef: string; sha256: string }>;
    selection: NonNullable<OfficeWrittenFact['dataBindings']>[number]['selection']; partial: boolean;
    output?: { status: string; differences: number; packageSha256: string } }>;
}
export type OfficeArtifactRecord = OfficeImageArtifactRecord | OfficeFileArtifactRecord;

/** Immutable private observations, not retained image bytes, permission grants or review conclusions. */
export class OfficeArtifactHistory implements OfficeAssetHistorySink {
  private readonly pending = new Map<string, OfficeArtifactRecord>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly ports: { write(key: string, record: OfficeArtifactRecord): PromiseLike<void>; failed(): void;
    /** The records already saved (any shape: each is checked before use). Absent: only this session's records are known. */
    saved?(): Iterable<unknown> }) {}

  /**
   * 13.10 source check, verification only (it grants nothing): whether the document now at `document.sha256` - or an
   * earlier version of it - is a document UnodeAi exported the PDF `pdfSha256` from, by the recorded hash edges.
   * The PDF side follows edit_pdf outputs back to the export (an edit_pdf output records its first input as its
   * source). The document side is its current bytes, the versions host edits derived it from, and, given its
   * artifactId, every version UnodeAi wrote or replaced at that same file. A file changed outside UnodeAi has no edge,
   * so it is not confirmed.
   */
  exportSourceConfirmed(pdfSha256: string, document: { sha256: string; artifactId?: string }): boolean {
    const files = this.fileRecords();
    const ancestors = (start: Iterable<string>, formats: readonly string[], kinds: readonly Derivation['kind'][]) => fileAncestors(files, start, formats, kinds);
    // The PDF, the PDFs edit_pdf made it from, and the documents those were exported from.
    const pdfSide = ancestors([pdfSha256], ['pdf'], ['edit-source']);
    const documentFormats = ['docx', 'pptx'];
    const start = new Set([document.sha256]);
    if (document.artifactId) {
      for (const file of files) {
        if (file.artifactId !== document.artifactId || !documentFormats.includes(file.format)) continue;
        for (const sha of file.outputs) start.add(sha);
        for (const edge of file.derivations) if (edge.kind === 'previous-version') start.add(edge.fromSha256);
      }
    }
    const documentSide = ancestors(start, documentFormats, ['edit-source', 'previous-version']);
    for (const sha of documentSide) if (sha !== pdfSha256 && pdfSide.has(sha)) return true;
    return false;
  }

  /**
   * 13.13: the PDFs a file was converted from by a derivation whose pages cannot be mapped (convert_pdf_to_docx),
   * directly or through later host edits, exports and PDF edits of the converted document - including every PDF an
   * edit took pages from (merge inputs after the first, replace_pages sources) - plus the earlier PDFs those were
   * edited from. The caller treats the file as derived from a signed version when any of them carries
   * UnodeAi signature records; an unknown mapping is never taken as "no signature".
   */
  convertedFrom(sha256: string): string[] {
    const files = this.fileRecords(); const kinds: Derivation['kind'][] = ['edit-source', 'page-source', 'pdf-conversion'];
    const sources = new Set<string>();
    for (const sha of fileAncestors(files, [sha256], ['docx', 'pptx', 'pdf'], kinds)) {
      for (const file of files) for (const edge of file.derivations) if (edge.kind === 'pdf-conversion' && edge.toSha256 === sha) sources.add(edge.fromSha256);
    }
    return [...fileAncestors(files, sources, ['pdf'], ['edit-source', 'page-source'])];
  }

  private fileRecords(): HistoryFile[] {
    const files: HistoryFile[] = [];
    let saved: Iterable<unknown> = [];
    try { saved = this.ports.saved?.() ?? []; } catch { saved = []; }
    for (const raw of [...this.pending.values(), ...saved]) {
      const record = raw as Partial<OfficeFileArtifactRecord> | undefined;
      if (!record || typeof record !== 'object' || record.kind !== 'file' || typeof record.format !== 'string' || !Array.isArray(record.derivations)) continue;
      const derivations = record.derivations.filter((edge): edge is Derivation => !!edge && typeof edge === 'object'
        && isSha(edge.fromSha256) && isSha(edge.toSha256) && typeof edge.kind === 'string');
      const outputs = Array.isArray(record.versions) ? record.versions.flatMap(version => version && version.kind === 'office-output' && isSha(version.sha256) ? [version.sha256] : []) : [];
      files.push({ format: record.format, artifactId: typeof record.artifactId === 'string' ? record.artifactId : '', derivations, outputs });
    }
    return files;
  }

  origin(assetId: string, origin: OfficeImageOrigin, binding: OfficeImageBinding): void { this.record(assetId, origin, binding); }
  visual(receipt: OfficeVisualReceipt, binding: OfficeImageBinding): void { this.record(receipt.asset_id, receipt.origin, binding, receipt); }

  written(fact: OfficeWrittenFact): void {
    const versions: ByteVersion[] = [{ sha256: fact.sha256, bytes: fact.bytes, kind: 'office-output' }];
    const derivations: Derivation[] = [];
    const addSource = (sha256: string | undefined, kind: Derivation['kind'], transformationRef?: string) => {
      if (!sha256) return;
      versions.push({ sha256, kind: 'office-source' });
      derivations.push({ fromSha256: sha256, toSha256: fact.sha256, kind, ...(transformationRef ? { transformationRef } : {}) });
    };
    addSource(fact.previousSha256, 'previous-version'); addSource(fact.sourceSha256, fact.sourceKind === 'pdf-conversion' ? 'pdf-conversion' : 'edit-source');
    for (const sha256 of new Set(fact.pageSourceSha256 ?? [])) if (sha256 !== fact.sourceSha256) addSource(sha256, 'page-source');
    const data: OfficeFileArtifactRecord['data'] = (fact.dataBindings ?? []).map(binding => {
      for (const source of binding.sources) addSource(source.sha256, 'source-data', binding.transformation_ref);
      return { transformationRef: binding.transformation_ref,
        sources: binding.sources.map(source => ({ snapshotRef: source.snapshot_ref, sha256: source.sha256 })),
        selection: structuredClone(binding.selection), partial: binding.partial,
        ...(binding.output ? { output: { status: binding.output.status, differences: binding.output.differences, packageSha256: binding.output.package_sha256 } } : {}) };
    });
    const eventId = randomUUID(); const key = `unode.officeArtifact.v1.${eventId}`;
    this.pending.set(key, structuredClone({ schemaVersion: 1, kind: 'file', eventId, observedAt: new Date().toISOString(), agentId: fact.agentId,
      ...(fact.attemptId ? { attemptId: fact.attemptId } : {}), ...(fact.requestId ? { requestId: fact.requestId } : {}), ...(fact.turnId ? { turnId: fact.turnId } : {}),
      operationId: fact.operationId, artifactId: fact.artifactId, format: fact.format, effect: fact.effect,
      ...(fact.restorePointId ? { restorePointId: fact.restorePointId } : {}), versions, derivations, data }));
    this.publish(key);
  }

  private record(assetId: string, raw: OfficeImageOrigin, binding: OfficeImageBinding, visual?: OfficeVisualReceipt): void {
    // Explicit fields: neither a private physical binding nor an incidental extra provider/model field is copied.
    const origin: OfficeImageOrigin = { kind: raw.kind, operation_id: raw.operation_id, sha256: raw.sha256,
      width: raw.width, height: raw.height, bytes: raw.bytes,
      ...(raw.source_sha256 ? { source_sha256: raw.source_sha256 } : {}),
      ...(raw.render_copy_sha256 ? { render_copy_sha256: raw.render_copy_sha256 } : {}),
      ...(raw.page !== undefined ? { page: raw.page } : {}), ...(raw.renderer ? { renderer: raw.renderer } : {}),
      ...(raw.render_copy_partial !== undefined ? { render_copy_partial: raw.render_copy_partial } : {}), ...(raw.model ? { model: raw.model } : {}) };
    const versions: ByteVersion[] = [{ sha256: origin.sha256, kind: 'image-original', bytes: origin.bytes }];
    const derivations: Derivation[] = [];
    const hash = (value: string | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (hash(origin.source_sha256)) versions.push({ sha256: origin.source_sha256, kind: 'office-source' });
    if (hash(origin.render_copy_sha256)) {
      versions.push({ sha256: origin.render_copy_sha256, kind: 'render-copy' });
      if (hash(origin.source_sha256)) derivations.push({ fromSha256: origin.source_sha256, toSha256: origin.render_copy_sha256, kind: 'passive-copy' });
      derivations.push({ fromSha256: origin.render_copy_sha256, toSha256: origin.sha256, kind: 'render-page' });
    }
    let delivery: OfficeVisualReceipt | undefined;
    if (visual) {
      const preview = visual.preview;
      delivery = { delivery_id: visual.delivery_id, asset_id: assetId, origin, preview: {
        sha256: preview.sha256, width: preview.width, height: preview.height, bytes: preview.bytes, resized: preview.resized, reencoded: preview.reencoded },
        state: visual.state, ...(visual.route ? { route: visual.route } : {}), ...(visual.model ? { model: visual.model } : {}),
        ...(visual.connection_id ? { connection_id: visual.connection_id } : {}),
        ...(visual.reason ? { reason: visual.reason } : {}), provider_result: visual.provider_result,
        transport: { submitted: visual.transport.submitted, accepted: visual.transport.accepted, rejected: visual.transport.rejected },
        viewed: visual.viewed, visual_review: visual.visual_review };
      versions.push({ sha256: preview.sha256, kind: 'transport-preview', bytes: preview.bytes });
      derivations.push({ fromSha256: origin.sha256, toSha256: preview.sha256, kind: 'transport-preview' });
    }
    const eventId = randomUUID();
    const key = `unode.officeArtifact.v1.${eventId}`;
    this.pending.set(key, structuredClone({ schemaVersion: 1, kind: 'image', eventId, observedAt: new Date().toISOString(), agentId: binding.agent_id,
      ...(binding.attempt_id ? { attemptId: binding.attempt_id } : {}), operationId: origin.operation_id,
      assetRef: `${origin.operation_id}:${assetId}`, versions, derivations, origin, ...(delivery ? { delivery } : {}) }));
    this.publish(key);
  }

  private publish(key: string): void {
    const record = this.pending.get(key); if (!record || this.writes.has(key)) return;
    const write = Promise.resolve().then(() => this.ports.write(key, structuredClone(record))).then(() => { this.pending.delete(key); })
      .catch(() => { try { this.ports.failed(); } catch { /* History failure cannot gate the operation. */ } })
      .finally(() => { this.writes.delete(key); });
    this.writes.set(key, write);
  }
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
    for (const key of this.pending.keys()) this.publish(key);
    await Promise.all([...this.writes.values()]);
  }
  get pendingWrites(): number { return this.pending.size; }
}
