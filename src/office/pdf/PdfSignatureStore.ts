import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { decodePng } from '../PngDecode';
import type { PdfRect } from './PdfEditContracts';

/** "My signature" (D11): one user PNG kept host-side in extension storage; the stored image is not sent to a model. A PDF it is placed on is an
    ordinary file: an agent's own file reading or a command can read it, signature included (Owner, 2026-11-22: say so, known limit). */
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
export interface PdfSignatureStatus { sha256: string; bytes: number; width: number; height: number; saved_at: string }
export type PdfSignatureSaveResult = { ok: true; status: PdfSignatureStatus } | { ok: false; reason: 'not-png' | 'too-large' | 'no-transparency' | 'unreadable' };

/** The notice shown after "Choose signature PNG..." / "Replace signature...". The success text says what the Settings card
    and SECURITY.md say (Owner, 2026-11-22): per-placement confirmation, the saved image is not sent to a model, and a
    signed PDF is a file an agent's own reading or a command can see the signature in. Installed smoke 6ee15ae9 found the
    old "they never see the image". */
export function signatureSaveNotice(saved: PdfSignatureSaveResult): string {
  if (saved.ok) return 'Your signature is saved in UnodeAi on this computer and is not sent to a model. '
    + 'Agents can place it on a PDF only after you confirm each placement. A PDF it is placed on is a file like any other: '
    + 'an agent that reads that PDF with its own file reading or a command can see the signature.';
  return saved.reason === 'too-large' ? 'The signature image is larger than 2 MB. Choose a smaller PNG.'
    : saved.reason === 'no-transparency' ? 'The signature PNG has no transparent background. Export it with transparency (for example from your image editor), then choose it again.'
      : saved.reason === 'not-png' ? 'That file is not a readable PNG image. Choose a PNG with a transparent background.' : 'The signature could not be saved. Try again.';
}

/**
 * 13.13 signature provenance: per signed output file (keyed by its SHA-256), where UnodeAi placed a signature,
 * in visible page coordinates, so images of that file or its mapped derivatives can hide the signature.
 */
export interface PdfSignatureRecord {
  page: number; page_ref: string; page_content_sha256: string; page_size: [number, number];
  rect: PdfRect; signature_sha256: string; receipt_id: string;
}

export class PdfSignatureStore {
  private status?: PdfSignatureStatus | null;
  private records?: Record<string, PdfSignatureRecord[]>;
  private recordWrite: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  private file(name: string): string { return path.join(this.root, name); }

  /** Display only: the last loaded status (undefined until first loaded, null when none is saved). */
  cachedStatus(): PdfSignatureStatus | null | undefined { return this.status; }

  async current(): Promise<PdfSignatureStatus | undefined> {
    if (this.status === undefined) {
      try { this.status = JSON.parse(await fs.readFile(this.file('signature.json'), 'utf8')) as PdfSignatureStatus; } catch { this.status = null; }
    }
    return this.status ?? undefined;
  }

  /** The stored image, only when its bytes still match the recorded hash. */
  async read(): Promise<{ bytes: Buffer; sha256: string } | undefined> {
    const status = await this.current(); if (!status) return undefined;
    try {
      const bytes = await fs.readFile(this.file('signature.png'));
      return createHash('sha256').update(bytes).digest('hex') === status.sha256 ? { bytes, sha256: status.sha256 } : undefined;
    } catch { return undefined; }
  }

  async save(bytes: Buffer): Promise<PdfSignatureSaveResult> {
    if (bytes.length > SIGNATURE_MAX_BYTES) return { ok: false, reason: 'too-large' };
    let decoded;
    try { decoded = decodePng(bytes, 512 * 1024 * 1024); } catch { return { ok: false, reason: 'not-png' }; }
    let transparent = false;
    for (let at = 3; at < decoded.pixels.length; at += 4) if (decoded.pixels[at] < 255) { transparent = true; break; }
    if (!transparent) return { ok: false, reason: 'no-transparency' };
    const status: PdfSignatureStatus = { sha256: decoded.sha256, bytes: bytes.length, width: decoded.width, height: decoded.height, saved_at: this.now().toISOString() };
    try {
      await fs.mkdir(this.root, { recursive: true });
      const staged = this.file(`signature-${randomUUID()}.tmp`);
      await fs.writeFile(staged, bytes, { mode: 0o600 }); await fs.rename(staged, this.file('signature.png'));
      await fs.writeFile(this.file('signature.json'), JSON.stringify(status), { mode: 0o600 });
    } catch { this.status = undefined; return { ok: false, reason: 'unreadable' }; }
    this.status = status; return { ok: true, status };
  }

  async delete(): Promise<void> {
    await fs.rm(this.file('signature.png'), { force: true }); await fs.rm(this.file('signature.json'), { force: true });
    this.status = null;
  }

  private async loadRecords(): Promise<Record<string, PdfSignatureRecord[]>> {
    if (!this.records) {
      try { const parsed = JSON.parse(await fs.readFile(this.file('records.json'), 'utf8')); this.records = parsed?.version === 1 && parsed.records && typeof parsed.records === 'object' ? parsed.records : {}; }
      catch { this.records = {}; }
    }
    return this.records!;
  }

  async recordsFor(sha256: string): Promise<PdfSignatureRecord[]> { return [...((await this.loadRecords())[sha256] ?? [])]; }

  async setRecords(sha256: string, records: PdfSignatureRecord[]): Promise<void> {
    const all = await this.loadRecords(); if (!records.length) return;
    all[sha256] = records.map(record => ({ ...record, rect: [...record.rect] as PdfRect, page_size: [...record.page_size] as [number, number] }));
    this.recordWrite = this.recordWrite.then(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const staged = this.file(`records-${randomUUID()}.tmp`);
      await fs.writeFile(staged, JSON.stringify({ version: 1, records: all }), { mode: 0o600 }); await fs.rename(staged, this.file('records.json'));
    }).catch(() => undefined);
    await this.recordWrite;
  }
}

/**
 * A visible rectangle after the page turned `rotated` degrees clockwise (13.13 propagation). The page size is the
 * visible size before the turn; the result is in the turned page's visible frame.
 */
export function rotateVisibleRect([x, y, w, h]: PdfRect, [width, height]: [number, number], rotated: number): { rect: PdfRect; size: [number, number] } {
  switch (((rotated % 360) + 360) % 360) {
    case 90: return { rect: [height - (y + h), x, h, w], size: [height, width] };
    case 180: return { rect: [width - (x + w), height - (y + h), w, h], size: [width, height] };
    case 270: return { rect: [y, width - (x + w), h, w], size: [height, width] };
    default: return { rect: [x, y, w, h], size: [width, height] };
  }
}
