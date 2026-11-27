import { describe, expect, it } from 'vitest';
import { ResponseReplay } from '../ResponseReplay';
import { bodyReadInterruption, providerResponseInterruption, providerTimeoutInterruption, protocolInterruption } from '../TurnInterruption';

describe('private current-response replay proof', () => {
  const socket = () => bodyReadInterruption(new TypeError('terminated'));
  it('requires a source-typed transient failure, not a matching string, JSON tag or arbitrary Error', () => {
    const guard = new ResponseReplay('host-proven-no-tool-start');
    expect(guard.transient(socket())).toBe('connection-lost');
    expect(guard.transient(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe('connection-lost');
    expect(guard.transient(providerTimeoutInterruption(new Error('deadline'), 'reading-response'))).toBe('provider-timeout');
    for (const error of [new TypeError('terminated'), new Error('ECONNRESET'), { kind: 'connection-lost' },
      protocolInterruption(new SyntaxError('bad JSON'), 'reading-response'), providerResponseInterruption(new Error('HTTP 500'), 'before-response')]) {
      expect(guard.transient(error)).toBeUndefined();
    }
  });
  it('a handoff irrevocably removes eligibility before its result, not turn-wide or after its result', () => {
    const guard = new ResponseReplay('host-proven-no-tool-start'); guard.toolStarted();
    expect(guard.transient(socket())).toBeUndefined();
    expect(guard.transient(socket())).toBeUndefined();
    expect(new ResponseReplay('host-proven-no-tool-start').transient(socket())).toBe('connection-lost');
  });
  it('does not treat missing native tool events as proof of no execution', () => {
    expect(new ResponseReplay('native-unknown').transient(socket())).toBeUndefined();
  });
});
