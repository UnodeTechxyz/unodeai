import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parseResultMailboxIndex, parseResultMailboxMetadata, resultMailboxMetadata } from '../ResultMailboxMetadata';
import { resultMailboxKey, type ResultMailboxEntry } from '../DelegationResultMailbox';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const entry = (): ResultMailboxEntry => ({ coordinatorId: 'pm', ref: { handle: 'h', revision: 1 }, attemptId: 'attempt', settledEventId: 'completion',
  state: 'ready', delivery: 'pending', body: { text: 'private worker result', bytes: 21, sourceBytes: 21, sourceDigest: sha('private worker result'), truncated: false } });
describe('small result recovery metadata', () => {
  it('stores only exact byte receipts and closed metadata, never result prose or arbitrary fields', () => {
    const value = entry(); const file = { key: resultMailboxKey(value.coordinatorId, value.ref), bytes: 21, sha256: sha(value.body!.text) };
    const metadata = resultMailboxMetadata(value, file)!;
    expect(metadata.body).toEqual({ bytes: 21, sourceBytes: 21, sourceDigest: file.sha256, truncated: false, file });
    expect(JSON.stringify(metadata)).not.toContain('private worker result');
    expect(parseResultMailboxMetadata({ ...metadata, arbitrary: 'private', body: { ...metadata.body, text: 'private' } })).toEqual(metadata);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(2048);
  });
  it('cannot acknowledge a settled result without its verified file receipt', () => {
    expect(resultMailboxMetadata(entry())).toBeUndefined();
    const value = entry(); const file = { key: resultMailboxKey('pm', value.ref), bytes: 21, sha256: sha(value.body!.text) };
    expect(resultMailboxMetadata(value, { ...file, key: sha('other completion') })).toBeUndefined();
    expect(resultMailboxMetadata(value, { ...file, bytes: 22 })).toBeUndefined();
    expect(resultMailboxMetadata({ ...value, body: { ...value.body!, truncated: true, sourceBytes: 100000 } }, file)).toBeUndefined();
  });
  it('retains reservation and delivery facts without turning a missing body into ready', () => {
    const value = entry(); delete value.body; value.state = 'reserved'; delete value.delivery;
    const metadata = resultMailboxMetadata(value)!; expect(metadata.state).toBe('reserved'); expect(metadata.body).toBeUndefined();
    expect(parseResultMailboxMetadata({ ...metadata, state: 'ready' })).toBeUndefined();
  });
  it('enforces the original index slot and per-item UTF-8 metadata budgets', () => {
    expect(parseResultMailboxIndex([sha('a'), sha('a')])).toBeUndefined();
    expect(parseResultMailboxIndex(Array.from({ length: 257 }, (_, i) => sha(String(i))))).toBeUndefined();
    const value = entry(); value.coordinatorId = '中'.repeat(500); value.attemptId = '中'.repeat(500);
    expect(resultMailboxMetadata(value, { key: resultMailboxKey(value.coordinatorId, value.ref), bytes: 21, sha256: sha(value.body!.text) })).toBeUndefined();
  });
});
