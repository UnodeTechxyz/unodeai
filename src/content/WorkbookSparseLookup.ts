import { openSync, closeSync, readSync, writeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
/** Sorted UInt32 key → safe integer record ordinal; no file sized by a model/source's largest arbitrary key. */
export class WorkbookSparseLookup {
  private readonly fd: number; readonly count: number;
  constructor(directory: string, name: string) {
    this.fd = openSync(join(directory, `${name}.lookup`), 'r'); this.count = fstatSync(this.fd).size / 16;
    if (!Number.isSafeInteger(this.count)) { closeSync(this.fd); throw new Error('invalid-workbook-index'); }
  }
  static write(directory: string, name: string, entries: Iterable<readonly [number, number]>): void {
    const fd = openSync(join(directory, `${name}.lookup`), 'wx'); let index = 0; let prior = -1;
    try { for (const [key, value] of entries) {
      if (!Number.isInteger(key) || key < 0 || key > 0xffffffff || key <= prior || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid-workbook-index');
      const record = Buffer.alloc(16); record.writeUInt32LE(key); record.writeBigUInt64LE(BigInt(value), 8); let at = 0;
      while (at < 16) at += writeSync(fd, record, at, 16 - at, index * 16 + at); prior = key; index++;
    } } finally { closeSync(fd); }
  }
  at(index: number): { key: number; value: number } | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) return undefined;
    const record = Buffer.alloc(16); let at = 0; while (at < 16) { const count = readSync(this.fd, record, at, 16 - at, index * 16 + at); if (!count) throw new Error('invalid-workbook-index'); at += count; }
    const value = Number(record.readBigUInt64LE(8)); if (!Number.isSafeInteger(value)) throw new Error('invalid-workbook-index'); return { key: record.readUInt32LE(), value };
  }
  lowerBound(key: number): { key: number; value: number } | undefined {
    let low = 0; let high = this.count; while (low < high) { const mid = Math.floor((low + high) / 2); if (this.at(mid)!.key < key) low = mid + 1; else high = mid; } return this.at(low);
  }
  get(key: number): number | undefined { const found = this.lowerBound(key); return found?.key === key ? found.value : undefined; }
  close(): void { closeSync(this.fd); }
}
