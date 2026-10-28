/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the control journal's authority floor (v0.9.97)
 *  `control\authority\floor.bin` keeps the highest reduction epoch that was ever reported, so losing the newest
 *  control generation can never bring back authority that a reported change took away. The file is created once,
 *  at its full size, and is never truncated, appended to, recreated or repaired.
 *
 *  Every epoch E owns one fixed 64-byte record in each of two regions, A at `64 × E` and B at `1 MiB + 64 × E`. A
 *  reduction writes only its own record, in region A and then in region B, each followed by a flush of the handle;
 *  only then is it reported. No record is ever written by another epoch or cleared, so the set of valid records only
 *  grows and its highest epoch cannot fall. Position 0 is the header, which names the journal; 1-4094 are ordinary
 *  epochs; 4095 is the seal: from then on control has no managed authority left.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { isStoreToken } from './storeLayout';

export const FLOOR_RECORD_BYTES = 64;
/** Positions 0-4095: 0 the header, 1-4094 ordinary epochs, 4095 the seal. */
export const FLOOR_POSITIONS = 4096;
export const FLOOR_SEAL = FLOOR_POSITIONS - 1;
export const FLOOR_REGION_A = 0;
/** Far enough from region A that no write in flight to A can reach B. */
export const FLOOR_REGION_B = 1024 * 1024;
/** 1,310,720 bytes. */
export const FLOOR_FILE_BYTES = FLOOR_REGION_B + FLOOR_POSITIONS * FLOOR_RECORD_BYTES;

const MAGIC = Buffer.from('UNFL', 'ascii');
const FORMAT = 1;
const ZERO_CHUNK_BYTES = 64 * 1024;

/** The file operations the floor uses; tests inject one that records the order or fails a step. */
export interface FloorFs {
  open(file: string, flags: 'r' | 'r+' | 'wx'): number;
  fstat(fd: number): { size: number; isFile(): boolean };
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  write(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  /** On Windows this is `FlushFileBuffers` on the handle. */
  fsync(fd: number): void;
  close(fd: number): void;
}

export const nodeFloorFs: FloorFs = {
  open: (file, flags) => openSync(file, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  write: (fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, length, position),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
};

export type FloorUnknownReason =
  | 'missing'
  | 'wrong-size'
  | 'unreadable'
  /** Neither header copy is valid, or the two valid copies name different journals. */
  | 'header'
  /** The header is valid but names another journal than the one asked for. */
  | 'other-journal';

export type FloorRead =
  /** `torn`: epochs with a non-zero record that is valid in neither region; they are ignored. */
  | { known: true; controlId: string; floor: number; torn: number[] }
  | { known: false; reason: FloorUnknownReason; detail: string; controlId?: string };

/** One 64-byte record: magic, format 1, the journal's 16-byte id, the epoch, four zero bytes, SHA-256 of bytes 0-31. */
export function floorRecord(controlId: string, epoch: number): Buffer {
  if (!isStoreToken(controlId)) throw new Error('A floor record needs a 32-digit journal id.');
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > FLOOR_SEAL) throw new Error(`The floor has no position ${epoch}.`);
  const record = Buffer.alloc(FLOOR_RECORD_BYTES);
  MAGIC.copy(record, 0);
  record.writeUInt32LE(FORMAT, 4);
  Buffer.from(controlId, 'hex').copy(record, 8);
  record.writeUInt32LE(epoch, 24);
  createHash('sha256').update(record.subarray(0, 32)).digest().copy(record, 32);
  return record;
}

/** The journal id of a valid record at `offset` for position `epoch`, or undefined. */
function validRecordAt(file: Buffer, offset: number, epoch: number): string | undefined {
  const record = file.subarray(offset, offset + FLOOR_RECORD_BYTES);
  if (!record.subarray(0, 4).equals(MAGIC) || record.readUInt32LE(4) !== FORMAT) return undefined;
  if (record.readUInt32LE(24) !== epoch || record.readUInt32LE(28) !== 0) return undefined;
  if (!createHash('sha256').update(record.subarray(0, 32)).digest().equals(record.subarray(32, 64))) return undefined;
  return record.subarray(8, 24).toString('hex');
}

function nonZeroAt(file: Buffer, offset: number): boolean {
  for (let index = offset; index < offset + FLOOR_RECORD_BYTES; index++) if (file[index] !== 0) return true;
  return false;
}

function writeAll(fs: FloorFs, fd: number, bytes: Buffer, position: number): void {
  let written = 0;
  while (written < bytes.length) {
    const count = fs.write(fd, bytes, written, bytes.length - written, position + written);
    if (count <= 0) throw new Error('The floor file did not accept a write.');
    written += count;
  }
}

/**
 * Creates the floor once, for a new journal: exclusively, with explicit zeros over the whole size so that no range is
 * sparse and a later record write changes no allocation, then the header in both regions, flushed. Throws `EEXIST`
 * when the file exists; an existing floor is never replaced.
 */
export function createFloor(file: string, controlId: string, fs: FloorFs = nodeFloorFs): void {
  const header = floorRecord(controlId, 0);
  const fd = fs.open(file, 'wx');
  try {
    const zeros = Buffer.alloc(ZERO_CHUNK_BYTES);
    for (let at = 0; at < FLOOR_FILE_BYTES; at += zeros.length) {
      writeAll(fs, fd, zeros.subarray(0, Math.min(zeros.length, FLOOR_FILE_BYTES - at)), at);
    }
    writeAll(fs, fd, header, FLOOR_REGION_A);
    writeAll(fs, fd, header, FLOOR_REGION_B);
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
}

/**
 * One reduction's floor write: record `epoch` in region A, flushed, then in region B, flushed. It writes nothing
 * else. The caller may report the reduction only after this returns; a throw means it was not reported.
 */
export function writeFloorEpoch(file: string, controlId: string, epoch: number, fs: FloorFs = nodeFloorFs): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > FLOOR_SEAL) throw new Error(`A reduction cannot take floor position ${epoch}.`);
  const record = floorRecord(controlId, epoch);
  const fd = fs.open(file, 'r+');
  try {
    writeAll(fs, fd, record, FLOOR_REGION_A + epoch * FLOOR_RECORD_BYTES);
    fs.fsync(fd);
    writeAll(fs, fd, record, FLOOR_REGION_B + epoch * FLOOR_RECORD_BYTES);
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
}

/**
 * The recovery rule. Missing, of another size, unreadable, or valid in neither header copy: the floor is unknown,
 * and no epoch can be computed from it. Otherwise the floor is the highest epoch whose record is valid in region A
 * or region B; a non-zero record valid in neither is listed as torn and ignored. With `controlId`, a header naming
 * another journal is `other-journal`.
 */
export function readFloor(file: string, controlId?: string, fs: FloorFs = nodeFloorFs): FloorRead {
  let bytes: Buffer;
  let fd: number;
  try {
    fd = fs.open(file, 'r');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { known: false, reason: 'missing', detail: 'the floor file does not exist' };
    return { known: false, reason: 'unreadable', detail: `the floor file could not be opened (${code})` };
  }
  try {
    const stat = fs.fstat(fd);
    if (!stat.isFile()) return { known: false, reason: 'unreadable', detail: 'the floor is not a file' };
    if (stat.size !== FLOOR_FILE_BYTES) return { known: false, reason: 'wrong-size', detail: `the floor file has ${stat.size} bytes, not ${FLOOR_FILE_BYTES}` };
    bytes = Buffer.alloc(FLOOR_FILE_BYTES);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.read(fd, bytes, read, bytes.length - read, read);
      if (count <= 0) return { known: false, reason: 'wrong-size', detail: `the floor file ended after ${read} bytes` };
      read += count;
    }
  } catch (error) {
    return { known: false, reason: 'unreadable', detail: `the floor file could not be read (${errorCode(error)})` };
  } finally {
    try { fs.close(fd); } catch { /* the bytes are already read */ }
  }

  const headerA = validRecordAt(bytes, FLOOR_REGION_A, 0);
  const headerB = validRecordAt(bytes, FLOOR_REGION_B, 0);
  if (!headerA && !headerB) return { known: false, reason: 'header', detail: 'neither copy of the floor header is valid' };
  if (headerA && headerB && headerA !== headerB) {
    return { known: false, reason: 'header', detail: 'the two copies of the floor header name different journals' };
  }
  const owner = (headerA ?? headerB) as string;
  if (controlId !== undefined && owner !== controlId) {
    return { known: false, reason: 'other-journal', detail: 'the floor belongs to another control journal', controlId: owner };
  }

  let floor = 0;
  const torn: number[] = [];
  for (let epoch = 1; epoch <= FLOOR_SEAL; epoch++) {
    const a = validRecordAt(bytes, FLOOR_REGION_A + epoch * FLOOR_RECORD_BYTES, epoch) === owner;
    const b = validRecordAt(bytes, FLOOR_REGION_B + epoch * FLOOR_RECORD_BYTES, epoch) === owner;
    if (a || b) floor = epoch;
    else if (nonZeroAt(bytes, FLOOR_REGION_A + epoch * FLOOR_RECORD_BYTES) || nonZeroAt(bytes, FLOOR_REGION_B + epoch * FLOOR_RECORD_BYTES)) torn.push(epoch);
  }
  return { known: true, controlId: owner, floor, torn };
}

/**
 * The epoch a reduction takes: one above both its predecessor's epoch and the floor read in the same attempt, and at
 * or past the seal, the seal. It needs a numeric floor; with an unknown floor no epoch exists.
 */
export function nextReductionEpoch(predecessorEpoch: number, floor: number): number {
  for (const value of [predecessorEpoch, floor]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > FLOOR_SEAL) throw new Error(`${value} is not a floor epoch.`);
  }
  return Math.min(Math.max(predecessorEpoch, floor) + 1, FLOOR_SEAL);
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown');
}
