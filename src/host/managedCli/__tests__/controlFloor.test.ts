import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFloor,
  FLOOR_FILE_BYTES,
  FLOOR_RECORD_BYTES,
  FLOOR_REGION_A,
  FLOOR_REGION_B,
  FLOOR_SEAL,
  floorRecord,
  nextReductionEpoch,
  nodeFloorFs,
  readFloor,
  writeFloorEpoch,
  type FloorFs,
} from '../controlFloor';

// The design these tests realise: the control journal's authority floor (Revision 5 §6.4, with the header carrying
// the journal's `controlId`). `floor.bin` is exactly 1,310,720 bytes: region A holds records 0-4095 at 64 × E, region
// B the same at 1 MiB + 64 × E, zeros between. A record is magic `UNFL`, format 1, the 16-byte journal id, the epoch,
// four zero bytes and the SHA-256 of bytes 0-31; record 0 is the header and 4095 the seal. Creation is `wx` with
// explicit zeros over the full size and the header in both regions, flushed. One reduction writes only its own
// record, region A then fsync then region B then fsync, and never rewrites or clears anything. Recovery rule: missing,
// wrong size, unreadable, or valid in neither header copy for this journal → unknown; otherwise the floor is the
// highest epoch valid in region A or B, and a non-zero invalid record is listed as torn and ignored. Epoch rule:
// E = min(max(P, F) + 1, 4095).

const ID = 'c0'.repeat(16);
const OTHER = '0d'.repeat(16);
const temps: string[] = [];
afterEach(() => {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function floorFile(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'unode-floor-'));
  temps.push(folder);
  return path.join(folder, 'floor.bin');
}

function patch(file: string, offset: number, bytes: Buffer): void {
  const fd = openSync(file, 'r+');
  try { writeSync(fd, bytes, 0, bytes.length, offset); } finally { closeSync(fd); }
}

/** A floor with records 1..upTo, written by the product writer. */
function floorUpTo(upTo: number, controlId = ID): string {
  const file = floorFile();
  createFloor(file, controlId);
  for (let epoch = 1; epoch <= upTo; epoch++) writeFloorEpoch(file, controlId, epoch);
  return file;
}

/** An fs that records every call in order, and can fail one of them. */
function recordingFs(failAt?: (call: string) => boolean): { fs: FloorFs; calls: string[] } {
  const calls: string[] = [];
  const step = (call: string) => {
    calls.push(call);
    if (failAt?.(call)) throw Object.assign(new Error(`injected failure at ${call}`), { code: 'EIO' });
  };
  return {
    calls,
    fs: {
      open: (file, flags) => { step(`open ${flags}`); return nodeFloorFs.open(file, flags); },
      fstat: (fd) => nodeFloorFs.fstat(fd),
      read: (fd, buffer, offset, length, position) => nodeFloorFs.read(fd, buffer, offset, length, position),
      write: (fd, buffer, offset, length, position) => { step(`write ${position} ${length}`); return nodeFloorFs.write(fd, buffer, offset, length, position); },
      fsync: (fd) => { step('fsync'); nodeFloorFs.fsync(fd); },
      close: (fd) => { calls.push('close'); nodeFloorFs.close(fd); },
    },
  };
}

describe('the floor file', () => {
  it('is created exclusively at exactly 1,310,720 bytes, written as explicit zeros with no gap, with the header in both regions, flushed', () => {
    const file = floorFile();
    const { fs, calls } = recordingFs();
    createFloor(file, ID, fs);
    const bytes = readFileSync(file);
    expect(FLOOR_FILE_BYTES).toBe(1_310_720);
    expect(bytes.length).toBe(FLOOR_FILE_BYTES);
    const header = floorRecord(ID, 0);
    expect(bytes.subarray(FLOOR_REGION_A, FLOOR_REGION_A + 64).equals(header)).toBe(true);
    expect(bytes.subarray(FLOOR_REGION_B, FLOOR_REGION_B + 64).equals(header)).toBe(true);
    const rest = Buffer.concat([bytes.subarray(64, FLOOR_REGION_B), bytes.subarray(FLOOR_REGION_B + 64)]);
    expect(rest.every((byte) => byte === 0)).toBe(true);

    // The zero writes cover [0, size) without a gap, before the two headers; then one flush and the close.
    expect(calls[0]).toBe('open wx');
    const writes = calls.filter((call) => call.startsWith('write')).map((call) => call.split(' ').slice(1).map(Number));
    const zeros = writes.slice(0, -2);
    let covered = 0;
    for (const [position, length] of zeros) {
      expect(position).toBe(covered);
      covered += length;
    }
    expect(covered).toBe(FLOOR_FILE_BYTES);
    expect(writes.slice(-2)).toEqual([[FLOOR_REGION_A, 64], [FLOOR_REGION_B, 64]]);
    expect(calls.slice(-2)).toEqual(['fsync', 'close']);
  });

  it('is never replaced: a second creation fails with EEXIST and leaves the file as it was', () => {
    const file = floorUpTo(3);
    const before = readFileSync(file);
    expect(() => createFloor(file, OTHER)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('lays out a record as magic, format 1, the 16-byte journal id, the epoch, four zero bytes and the SHA-256 of bytes 0-31', () => {
    const record = floorRecord(ID, 12);
    expect(record.length).toBe(FLOOR_RECORD_BYTES);
    expect(record.subarray(0, 4).toString('ascii')).toBe('UNFL');
    expect(record.readUInt32LE(4)).toBe(1);
    expect(record.subarray(8, 24).toString('hex')).toBe(ID);
    expect(record.readUInt32LE(24)).toBe(12);
    expect(record.readUInt32LE(28)).toBe(0);
    expect(record.subarray(32).equals(createHash('sha256').update(record.subarray(0, 32)).digest())).toBe(true);
    expect(() => floorRecord('not-an-id', 1)).toThrow();
    expect(() => floorRecord(ID, FLOOR_SEAL + 1)).toThrow();
  });

  it('writes one reduction as its own record in region A, flushed, then in region B, flushed, and changes no other byte', () => {
    const file = floorUpTo(4);
    const before = readFileSync(file);
    const { fs, calls } = recordingFs();
    writeFloorEpoch(file, ID, 5, fs);
    expect(calls).toEqual([
      'open r+',
      `write ${FLOOR_REGION_A + 5 * 64} 64`, 'fsync',
      `write ${FLOOR_REGION_B + 5 * 64} 64`, 'fsync',
      'close',
    ]);
    const after = readFileSync(file);
    const record = floorRecord(ID, 5);
    expect(after.subarray(FLOOR_REGION_A + 320, FLOOR_REGION_A + 384).equals(record)).toBe(true);
    expect(after.subarray(FLOOR_REGION_B + 320, FLOOR_REGION_B + 384).equals(record)).toBe(true);
    for (const region of [FLOOR_REGION_A, FLOOR_REGION_B]) record.copy(before, region + 320);
    expect(after.equals(before)).toBe(true);
  });

  it('refuses a reduction position outside 1-4095 and writes nothing for it', () => {
    const file = floorUpTo(1);
    const before = readFileSync(file);
    for (const epoch of [0, FLOOR_SEAL + 1, 2.5, -1, Number.NaN]) expect(() => writeFloorEpoch(file, ID, epoch)).toThrow();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('stops at a failed flush of region A: region B is never written, and the handle is closed', () => {
    const file = floorUpTo(2);
    const { fs, calls } = recordingFs((call) => call === 'fsync');
    expect(() => writeFloorEpoch(file, ID, 3, fs)).toThrow(/injected/);
    expect(calls).toEqual(['open r+', `write ${FLOOR_REGION_A + 3 * 64} 64`, 'fsync', 'close']);
    expect(readFileSync(file).subarray(FLOOR_REGION_B + 192, FLOOR_REGION_B + 256).every((byte) => byte === 0)).toBe(true);
  });

  it('closes the handle when creation fails part way; the partial file is left and reads as unknown', () => {
    const file = floorFile();
    const { fs, calls } = recordingFs((call) => call === `write ${64 * 1024} ${64 * 1024}`);
    expect(() => createFloor(file, ID, fs)).toThrow(/injected/);
    expect(calls.at(-1)).toBe('close');
    expect(readFloor(file, ID)).toMatchObject({ known: false, reason: 'wrong-size' });
  });
});

describe('reading the floor (the recovery rule)', () => {
  it('is the highest valid epoch, not the last one written', () => {
    const file = floorUpTo(10);
    writeFloorEpoch(file, ID, 12);
    // A hole at 11 (a reducer that died after its generation) does not stop the scan.
    expect(readFloor(file, ID)).toEqual({ known: true, controlId: ID, floor: 12, torn: [] });
    writeFloorEpoch(file, ID, 11);
    expect(readFloor(file, ID)).toEqual({ known: true, controlId: ID, floor: 12, torn: [] });
  });

  it('reads a header-only floor as 0 and adopts the header\'s journal when none is named', () => {
    const file = floorUpTo(0);
    expect(readFloor(file)).toEqual({ known: true, controlId: ID, floor: 0, torn: [] });
  });

  it('takes a record torn in region A from region B', () => {
    const file = floorUpTo(12);
    patch(file, FLOOR_REGION_A + 12 * 64 + 20, randomBytes(30));
    expect(readFloor(file, ID)).toMatchObject({ known: true, floor: 12 });
  });

  it('reads a record torn in both regions as never reported: the floor is lower and the epoch is listed torn', () => {
    const file = floorUpTo(12);
    patch(file, FLOOR_REGION_A + 12 * 64, randomBytes(64));
    patch(file, FLOOR_REGION_B + 12 * 64 + 40, randomBytes(24));
    expect(readFloor(file, ID)).toEqual({ known: true, controlId: ID, floor: 11, torn: [12] });
  });

  it('keeps the header and the floor from region B when a whole page of region A is destroyed', () => {
    const file = floorUpTo(12);
    patch(file, FLOOR_REGION_A, randomBytes(4096));
    expect(readFloor(file, ID)).toMatchObject({ known: true, controlId: ID, floor: 12 });
  });

  it('does not count a record whose checksum does not match, in either region', () => {
    const file = floorUpTo(12);
    const forged = floorRecord(ID, 13);
    forged[40] ^= 0xff;
    patch(file, FLOOR_REGION_A + 13 * 64, forged);
    patch(file, FLOOR_REGION_B + 13 * 64, forged);
    expect(readFloor(file, ID)).toEqual({ known: true, controlId: ID, floor: 12, torn: [13] });
  });

  it('does not count a record at another epoch\'s position, or a record of another journal', () => {
    const file = floorUpTo(12);
    patch(file, FLOOR_REGION_A + 14 * 64, floorRecord(ID, 15));
    patch(file, FLOOR_REGION_A + 13 * 64, floorRecord(OTHER, 13));
    patch(file, FLOOR_REGION_B + 13 * 64, floorRecord(OTHER, 13));
    expect(readFloor(file, ID)).toEqual({ known: true, controlId: ID, floor: 12, torn: [13, 14] });
  });

  it('is unknown when the file is missing, of another size, not a file, or unreadable', () => {
    const file = floorUpTo(3);
    expect(readFloor(path.join(path.dirname(file), 'none.bin'), ID)).toMatchObject({ known: false, reason: 'missing' });
    truncateSync(file, FLOOR_FILE_BYTES - 1);
    expect(readFloor(file, ID)).toMatchObject({ known: false, reason: 'wrong-size' });
    unlinkSync(file);
    writeFileSync(file, Buffer.alloc(FLOOR_FILE_BYTES + 64));
    expect(readFloor(file, ID)).toMatchObject({ known: false, reason: 'wrong-size' });
    unlinkSync(file);
    mkdirSync(file);
    expect(readFloor(file, ID).known).toBe(false);
    const denied: FloorFs = { ...nodeFloorFs, open: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    expect(readFloor(file, ID, denied)).toMatchObject({ known: false, reason: 'unreadable' });
    const failing: FloorFs = { ...nodeFloorFs, read: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
    const good = floorUpTo(1);
    expect(readFloor(good, ID, failing)).toMatchObject({ known: false, reason: 'unreadable' });
  });

  it('is unknown when both header copies are damaged, whatever the records say', () => {
    const file = floorUpTo(3);
    patch(file, FLOOR_REGION_A, Buffer.alloc(64));
    patch(file, FLOOR_REGION_B + 8, Buffer.alloc(8, 1));
    expect(readFloor(file, ID)).toMatchObject({ known: false, reason: 'header' });
    expect(readFloor(file)).toMatchObject({ known: false, reason: 'header' });
  });

  it('is unknown when the two valid header copies name different journals', () => {
    const file = floorUpTo(3);
    patch(file, FLOOR_REGION_B, floorRecord(OTHER, 0));
    expect(readFloor(file, ID)).toMatchObject({ known: false, reason: 'header' });
  });

  it('names another journal\'s floor as such, with that journal\'s id, and gives no floor for it', () => {
    const file = floorUpTo(9, OTHER);
    const read = readFloor(file, ID);
    expect(read).toMatchObject({ known: false, reason: 'other-journal', controlId: OTHER });
    expect('floor' in read).toBe(false);
  });
});

describe('the epoch rule and the seal', () => {
  it.each([
    [10, 10, 11],
    [11, 10, 12],
    [10, 12, 13],
    [0, 0, 1],
    [4093, 4093, 4094],
    [4094, 4094, FLOOR_SEAL],
    [4094, 4095, FLOOR_SEAL],
    [FLOOR_SEAL, FLOOR_SEAL, FLOOR_SEAL],
  ])('E = min(max(P %d, F %d) + 1, 4095) = %d', (predecessor, floor, expected) => {
    expect(nextReductionEpoch(predecessor, floor)).toBe(expected);
  });

  it('computes no epoch without a numeric floor', () => {
    for (const [predecessor, floor] of [[3, Number.NaN], [3, -1], [3, FLOOR_SEAL + 1], [Number.NaN, 3], [2.5, 3]]) {
      expect(() => nextReductionEpoch(predecessor, floor)).toThrow();
    }
  });

  it('reads the seal as floor 4095, and a reduction after it takes no new position', () => {
    const file = floorUpTo(5);
    writeFloorEpoch(file, ID, FLOOR_SEAL);
    expect(readFloor(file, ID)).toMatchObject({ known: true, floor: FLOOR_SEAL });
    expect(nextReductionEpoch(FLOOR_SEAL, FLOOR_SEAL)).toBe(FLOOR_SEAL);
    expect(() => writeFloorEpoch(file, ID, FLOOR_SEAL + 1)).toThrow();
  });
});
