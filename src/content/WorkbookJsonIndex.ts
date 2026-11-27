import { openSync, closeSync, readSync, writeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';

/** Private fixed-code worker records. Only one JSON value is loaded at a time. */
export class WorkbookJsonIndex<T> {
  private readonly data: number; private readonly index: number; private offset = 0;
  count: number;
  constructor(directory: string, name: string, write = false) {
    this.data = openSync(join(directory, `${name}.json-data`), write ? 'wx+' : 'r');
    try { this.index = openSync(join(directory, `${name}.json-index`), write ? 'wx+' : 'r'); }
    catch (error) { closeSync(this.data); throw error; }
    this.count = fstatSync(this.index).size / 16;
    if (!Number.isSafeInteger(this.count)) { this.close(); throw new Error('invalid-workbook-index'); }
  }
  append(value: T): number {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8'); const record = Buffer.alloc(16);
    record.writeBigUInt64LE(BigInt(this.offset)); record.writeBigUInt64LE(BigInt(bytes.length), 8);
    let at = 0; while (at < bytes.length) at += writeSync(this.data, bytes, at, bytes.length - at, this.offset + at);
    at = 0; while (at < 16) at += writeSync(this.index, record, at, 16 - at, this.count * 16 + at);
    this.offset += bytes.length; return this.count++;
  }
  get(index: number): T | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) return undefined;
    const read = (fd: number, offset: number, length: number) => { const bytes = Buffer.alloc(length); let at = 0;
      while (at < length) { const count = readSync(fd, bytes, at, length - at, offset + at); if (!count) throw new Error('invalid-workbook-index'); at += count; } return bytes; };
    const record = read(this.index, index * 16, 16); const offset = Number(record.readBigUInt64LE()); const length = Number(record.readBigUInt64LE(8));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) throw new Error('invalid-workbook-index');
    return JSON.parse(read(this.data, offset, length).toString('utf8')) as T;
  }
  close(): void { closeSync(this.data); closeSync(this.index); }
}
