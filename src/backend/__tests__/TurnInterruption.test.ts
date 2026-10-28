import { describe, expect, it } from 'vitest';
import {
  INTERRUPTION_KINDS, INTERRUPTION_PHASES, INTERRUPTION_RETRIES, MAX_INTERRUPTION_ATTEMPTS,
  bodyReadInterruption, classifyTurnInterruption, interruptionReason, interruptionRetryReason,
  parseTurnInterruption, processExitInterruption, protocolInterruption, providerResponseInterruption,
  providerTimeoutInterruption, type InterruptionContext, type TurnInterruptionV1,
} from '../TurnInterruption';

const context: InterruptionContext = { phase: 'reading-response', retry: 'exhausted', attempts: 4 };
const coded = (code: unknown, cause?: unknown) => Object.assign(new Error('PRIVATE_ERROR_MESSAGE', { cause }), { code });
const kind = (error: unknown, options = context) => classifyTurnInterruption(error, options)?.kind;
const fact: TurnInterruptionV1 = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted', attempts: 4 };

describe('ITR-a source-owned interruption facts (no send/retry activation yet)', () => {
  it.each(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'UND_ERR_SOCKET'])('recognises actual Error code %s, not error wording', code => {
    expect(kind(coded(code))).toBe('connection-lost');
    expect(kind(new Error(`terminated ECONNRESET ${code}`))).toBe('unknown');
  });

  it.each(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])('recognises timeout %s, including underneath a reader wrapper', code => {
    expect(kind(coded(code))).toBe('provider-timeout');
    expect(kind(bodyReadInterruption(coded(code)))).toBe('provider-timeout');
    expect(kind(coded('ECONNRESET', coded(code)))).toBe('provider-timeout');
  });

  it('distinguishes the actual reader observation from a bare terminated error, copied tag, or provider JSON', () => {
    const bare = new TypeError('terminated');
    expect(kind(bare)).toBe('unknown');
    const observed = bodyReadInterruption(bare);
    expect(observed.cause).toBe(bare);
    expect(classifyTurnInterruption(observed, { ...context, phase: 'unknown' })).toEqual(fact);
    expect(kind(Object.assign(new Error('body-read-failed'), { kind: 'connection-lost', phase: 'reading-response', hostTag: 'body-read-failed' }))).toBe('unknown');
    expect(kind(Object.assign(new Error('copied'), { ...observed }))).toBe('unknown');
    expect(kind({ name: 'TypeError', message: 'terminated', code: 'ECONNRESET', kind: 'connection-lost' })).toBe('unknown');
    expect(kind(JSON.parse(JSON.stringify(observed)))).toBe('unknown');
  });

  it('never turns parser errors into socket failures', () => {
    expect(kind(new SyntaxError('terminated'))).toBe('unknown');
    expect(kind(bodyReadInterruption(new SyntaxError('PRIVATE_BAD_JSON')))).toBe('protocol-error');
    expect(kind(protocolInterruption(new Error('PRIVATE_PARSE'), 'reading-response'))).toBe('protocol-error');
  });

  it.each(['AbortError', 'TimeoutError', 'TypeError'])('does not infer Stop or timeout from a bare %s name', name => {
    expect(kind(Object.assign(new Error('timeout aborted by user'), { name }))).toBe('unknown');
  });

  it('uses typed adapter facts for HTTP/native failure, host timeout, process exit and protocol errors', () => {
    expect(kind(providerResponseInterruption(new Error('PRIVATE_HTTP_500'), 'before-response'))).toBe('provider-error');
    expect(classifyTurnInterruption(providerTimeoutInterruption(new Error('PRIVATE_HOST_TIMEOUT'), 'before-response'), context))
      .toMatchObject({ kind: 'provider-timeout', phase: 'before-response' });
    expect(classifyTurnInterruption(processExitInterruption(new Error('PRIVATE_EXIT_1')), context))
      .toMatchObject({ kind: 'process-exited', phase: 'native-turn' });
    expect(kind(protocolInterruption(new Error('PRIVATE_RPC'), 'native-turn'))).toBe('protocol-error');
  });

  it('walks at most three cause links, stops on cycles and hostile accessors, and does not stringify unknown objects', () => {
    const cause = coded('ECONNRESET');
    const nested = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause }) }) });
    expect(kind(nested)).toBe('connection-lost');
    expect(kind(new Error('too deep', { cause: nested }))).toBe('unknown');
    const cyclic = new Error('PRIVATE_CYCLE'); cyclic.cause = cyclic;
    expect(kind(cyclic)).toBe('unknown');
    const hostile = Object.defineProperty(new Error('PRIVATE'), 'cause', { get() { throw new Error('PRIVATE_GETTER'); } });
    expect(kind(hostile)).toBe('unknown');
    const hostileCode = Object.defineProperty(new Error('PRIVATE'), 'code', { get() { throw new Error('PRIVATE_CODE'); } });
    expect(kind(hostileCode)).toBe('unknown');
    expect(kind({ toString() { throw new Error('PRIVATE_STRING'); } })).toBe('unknown');
  });

  it.each(['stopped', 'host-deadline', 'approval-wait', 'safety-limit'] as const)('%s takes precedence over any observed transport failure', suppressed => {
    expect(classifyTurnInterruption(bodyReadInterruption(coded('ECONNRESET')), { ...context, suppressed })).toBeUndefined();
    expect(classifyTurnInterruption(providerTimeoutInterruption(undefined, 'reading-response'), { ...context, suppressed })).toBeUndefined();
  });

  it('has a closed, bounded, content-free parser and does not invoke caller serialization', () => {
    const raw = { ...fact, rawError: 'PRIVATE_ERROR', command: 'PRIVATE_COMMAND', callback: () => 'PRIVATE_CALLBACK', toJSON: () => 'PRIVATE_JSON' };
    expect(parseTurnInterruption(raw)).toEqual(fact);
    expect(JSON.stringify(parseTurnInterruption(raw))).not.toContain('PRIVATE_');
    for (const invalid of [undefined, null, [], {}, { ...fact, schemaVersion: 2 },
      { ...fact, kind: 'terminated' }, { ...fact, phase: 'PRIVATE_PHASE' }, { ...fact, retry: 'PRIVATE_RETRY' },
      ...[0, -1, Infinity, NaN, 1.5, MAX_INTERRUPTION_ATTEMPTS + 1, '4'].map(attempts => ({ ...fact, attempts }))]) {
      expect(parseTurnInterruption(invalid)).toBeUndefined();
    }
    expect(parseTurnInterruption({ ...fact, attempts: MAX_INTERRUPTION_ATTEMPTS })).toEqual({ ...fact, attempts: MAX_INTERRUPTION_ATTEMPTS });
    const { attempts: _removed, ...unknownAttempts } = fact;
    expect(parseTurnInterruption(unknownAttempts)).toEqual(unknownAttempts);
    expect(parseTurnInterruption(Object.defineProperty({}, 'kind', { get() { throw new Error('PRIVATE_PARSER'); } }))).toBeUndefined();
  });

  it('keeps all allowed enum combinations backward-compatible without inventing attempt counts', () => {
    for (const kind of INTERRUPTION_KINDS) for (const phase of INTERRUPTION_PHASES) for (const retry of INTERRUPTION_RETRIES) {
      const raw = { schemaVersion: 1 as const, kind, phase, retry };
      expect(parseTurnInterruption(raw)).toEqual(raw);
      expect(parseTurnInterruption(raw)).not.toHaveProperty('attempts');
    }
  });

  it('uses the same fixed English wording for every adapter and excludes original error details', () => {
    expect(interruptionReason(fact)).toBe('The connection to the model provider was interrupted while the reply was being received.');
    expect(interruptionReason({ ...fact, phase: 'before-response' })).toBe('The connection to the model provider ended before a complete reply was received.');
    expect(interruptionReason({ ...fact, kind: 'provider-timeout' })).toBe('Timed out waiting for the model provider. This turn was interrupted.');
    expect(interruptionReason({ ...fact, kind: 'provider-error' })).toBe('The model provider returned an error. This turn did not finish normally.');
    expect(interruptionReason({ ...fact, kind: 'process-exited' })).toBe('The agent program exited before this turn finished.');
    expect(interruptionReason({ ...fact, kind: 'protocol-error' })).toBe('This turn was interrupted by an error and did not finish normally.');
    for (const kind of INTERRUPTION_KINDS) for (const retry of INTERRUPTION_RETRIES) {
      const parsed = classifyTurnInterruption(providerResponseInterruption(new Error('PRIVATE terminated https://private.invalid/?key=secret'), 'unknown'), { ...context, retry })!;
      expect(interruptionReason({ ...parsed, kind }) + interruptionRetryReason(parsed)).not.toMatch(/PRIVATE|terminated|https:|secret/);
    }
    expect(interruptionRetryReason({ ...fact, retry: 'native-unknown' })).toBe('The CLI may already have acted, so this turn was not automatically sent again.');
    expect(interruptionRetryReason({ ...fact, retry: 'after-tool' })).toBe('No automatic resend was made because an operation had already started.');
  });
});
