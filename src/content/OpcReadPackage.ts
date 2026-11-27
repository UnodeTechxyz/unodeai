import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { posix } from 'node:path';
import { readWorkbookXml, type WorkbookXmlEvents } from './WorkbookXml';
interface Entry { fileName: string; compressedSize: number; uncompressedSize: number; crc32: number; generalPurposeBitFlag: number }
interface Zip extends EventEmitter { readEntry(): void; close(): void; openReadStream(entry: Entry, callback: (error: Error | null, stream?: Readable) => void): void }
const yauzl = require('yauzl') as { open(path: string, options: object, callback: (error: Error | null, zip?: Zip) => void): void };
const crc32 = require('buffer-crc32') as { unsigned(bytes: Uint8Array, previous?: number): number };
const BASE = 'https://package.invalid';
/** OPC names are URI paths, not filesystem names. Canonical lookup never opens the URI. */
export function opcPartName(name: string): string {
  if (!name.startsWith('/') || /[?#\\]/.test(name) || /%(?![0-9a-f]{2})/i.test(name)) throw new Error('invalid-package-part');
  const unreserved = name.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const character = String.fromCharCode(parseInt(hex, 16)); return /[a-z0-9._~-]/i.test(character) ? character : '%' + hex.toUpperCase();
  });
  if (unreserved.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('invalid-package-part');
  const uri = new URL(unreserved, BASE); if (uri.origin !== BASE || uri.pathname === '/' || uri.pathname.endsWith('/')) throw new Error('invalid-package-part');
  return uri.pathname.toUpperCase();
}
export function opcRelationshipTarget(sourcePart: string, target: string): string {
  const uri = new URL(target, new URL(sourcePart, BASE));
  if (uri.origin !== BASE) throw new Error('external-package-target'); return opcPartName(uri.pathname);
}
export const opcRelationshipsPart = (sourcePart: string) => opcPartName(posix.join(posix.dirname(sourcePart), '_rels', posix.basename(sourcePart) + '.rels'));
export class ReadOnlyOpc {
  private compressed = 0; private actual = 0;
  private constructor(private readonly zip: Zip, private readonly entries: Map<string, Entry[]>, private readonly ratio: number,
    private readonly floor: number, private readonly progress: () => void) {}
  static async open(source: string, ratio: number, floor: number, progress: () => void) {
    return await new Promise<ReadOnlyOpc>((resolve, reject) => {
      yauzl.open(source, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
        if (error || !zip) { reject(new Error('invalid-office-zip')); return; }
        const entries = new Map<string, Entry[]>(); let finished = false;
        const fail = () => { if (!finished) { finished = true; zip.close(); reject(new Error('invalid-office-zip')); } };
        zip.on('error', fail); zip.on('entry', (entry: Entry) => {
          if (finished) return;
          progress();
          if (!entry.fileName.endsWith('/')) {
            try { const name = opcPartName('/' + entry.fileName); const prior = entries.get(name) ?? []; prior.push(entry); entries.set(name, prior); }
            catch { /* An unrelated non-part ZIP item is not read or extracted. Required parts still have to resolve. */ }
          }
          zip.readEntry();
        });
        zip.once('end', () => { if (!finished) { finished = true; resolve(new ReadOnlyOpc(zip, entries, ratio, floor, progress)); } }); zip.readEntry();
      });
    });
  }
  has(part: string): boolean { return this.entries.has(opcPartName(part)); }
  /** Original ZIP member spelling for preserving writers; canonical names remain lookup keys only. */
  memberName(part: string): string {
    const entries = this.entries.get(opcPartName(part)); if (!entries || entries.length !== 1) throw new Error('missing-or-ambiguous-office-part');
    return entries[0].fileName;
  }
  names(): string[] { return [...this.entries.keys()]; }
  async *bytes(part: string): AsyncGenerator<Uint8Array> {
    const entries = this.entries.get(opcPartName(part)); if (!entries || entries.length !== 1) throw new Error('missing-or-ambiguous-office-part');
    const entry = entries[0];
    if (entry.generalPurposeBitFlag & 1) throw new Error('encrypted-office-part');
    if (![entry.compressedSize, entry.uncompressedSize].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid-office-part-size');
    this.compressed += entry.compressedSize;
    const allowed = () => this.floor + this.ratio * this.compressed;
    if (this.actual + entry.uncompressedSize > allowed()) throw new Error('office-expansion-budget');
    const stream = await new Promise<Readable>((resolve, reject) => this.zip.openReadStream(entry, (error, value) => error || !value ? reject(new Error('invalid-office-part')) : resolve(value)));
    let checksum = 0; let actual = 0;
    try {
      for await (const chunk of stream) {
        this.actual += chunk.length; actual += chunk.length;
        if (this.actual > allowed()) throw new Error('office-expansion-budget'); checksum = crc32.unsigned(chunk, checksum);
        this.progress(); yield chunk;
      }
      if (actual !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('corrupt-office-part');
    } finally { stream.destroy(); }
  }
  async xml(part: string, events: WorkbookXmlEvents) { return await readWorkbookXml(this.bytes(part), events, this.progress); }
  close(): void { this.zip.close(); }
}
