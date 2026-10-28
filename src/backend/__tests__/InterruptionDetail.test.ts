import { describe, expect, it } from 'vitest';
import { interruptionDetail, parseInterruptionDetail } from '../InterruptionDetail';
import { redactDiagnosticText } from '../../security/diagnosticRedaction';
import { redactEvidenceText } from '../../observability/RunLedger';

describe('private bounded interruption diagnostics', () => {
  it.each(['Authorization: Bearer eyJh.fake-token.signature', 'Bearer bare-credential-123',
    'sk-proj-' + 'aB9_'.repeat(12), 'sk-or-v1-' + 'cD8-'.repeat(12), 'https://host.invalid/v1?key=AIzaSensitive&safe=1'])
  ('redacts common credentials from both log/evidence and live details: %s', source => {
    const expectedMissing = ['eyJh.', 'bare-credential', 'aB9_', 'cD8-', 'AIzaSensitive'];
    for (const redacted of [redactDiagnosticText(source), redactEvidenceText(source), interruptionDetail(new Error(source)).message!]) {
      for (const fragment of expectedMissing) expect(redacted).not.toContain(fragment);
      expect(redacted).toContain('[redacted');
    }
  });
  it('copies only allowlisted fields, redacts a known bare credential, and never serializes body/stack/tool data', () => {
    const error = Object.assign(new TypeError('PRIVATE_DIAGNOSTIC bare-CREDENTIAL api_key=abc password=def'), {
      code: 'ECONNRESET', body: 'PRIVATE_BODY', toolOutput: 'PRIVATE_TOOL', stack: 'PRIVATE_STACK',
      toJSON() { throw new Error('must not serialize'); },
    });
    const detail = interruptionDetail(error, ['bare-CREDENTIAL']);
    expect(detail).toMatchObject({ schemaVersion: 1, name: 'TypeError', code: 'ECONNRESET' });
    expect(detail.message).toContain('PRIVATE_DIAGNOSTIC'); expect(detail.message).toContain('[redacted credential]');
    expect(JSON.stringify(detail)).not.toMatch(/bare-CREDENTIAL|abc|def|PRIVATE_BODY|PRIVATE_TOOL|PRIVATE_STACK/);
  });

  it('bounds message work and display, including a key/private-key block crossing the retained window', () => {
    expect(interruptionDetail(new Error('x'.repeat(100_000))).message).toHaveLength(1000);
    const secret = 'KEY_CONTENT_'.repeat(2000);
    const detail = interruptionDetail(new Error('safe '.repeat(100) + secret + 'tail'), [secret]);
    expect(detail.message).not.toContain('KEY_CONTENT_'); expect(detail.message).toContain('[redacted credential]');
    const privateKey = interruptionDetail(new Error('safe\n' + '-----BEGIN ' + 'PRIVATE KEY-----\n' + 'PRIVATE_KEY_BYTES'.repeat(2000)));
    expect(privateKey.message).not.toContain('PRIVATE_KEY_BYTES'); expect(privateKey.message).toContain('[redacted private key]');
  });

  it('keeps unknown names/codes out, reads bounded cause codes and does not stringify a foreign error object', () => {
    const error = Object.assign(new Error('safe'), { name: 'PRIVATE_NAME', code: 'PRIVATE_CODE',
      cause: Object.assign(new Error('PRIVATE_CAUSE_MESSAGE'), { code: 'UND_ERR_SOCKET' }) });
    expect(interruptionDetail(error)).toEqual({ schemaVersion: 1, name: 'Error', code: 'UND_ERR_SOCKET', message: 'safe' });
    expect(interruptionDetail({ message: 'PRIVATE_JSON', code: 'ECONNRESET', toString() { throw new Error('no'); } }))
      .toEqual({ schemaVersion: 1, name: 'Error' });
    const cycle = new Error('safe'); cycle.cause = cycle;
    expect(interruptionDetail(cycle).message).toBe('safe');
    const cause = Object.assign(new Error('deep'), { code: 'EPIPE' });
    const nested = new Error('root', { cause: new Error('1', { cause: new Error('2', { cause: new Error('3', { cause }) }) }) });
    expect(interruptionDetail(nested).code).toBeUndefined();
  });

  it('tolerates hostile field accessors without invoking arbitrary serialization', () => {
    const error = Object.defineProperty(new Error('PRIVATE'), 'name', { get() { throw new Error('no'); } });
    expect(interruptionDetail(error)).toEqual({ schemaVersion: 1, name: 'Error' });
    const raw = Object.defineProperty({}, 'schemaVersion', { get() { throw new Error('no'); } });
    expect(parseInterruptionDetail(raw)).toBeUndefined();
  });

  it('parses only bounded live detail fields and redacts again; it cannot carry a recursive exception', () => {
    const detail = { schemaVersion: 1, name: 'Error', code: 'EPIPE', message: 'https://user:pass@example.invalid api_key=PRIVATE_TOKEN',
      body: 'PRIVATE_BODY', stack: 'PRIVATE_STACK', cause: { message: 'PRIVATE_CAUSE' }, toJSON() { throw new Error('no'); } };
    const parsed = parseInterruptionDetail(detail);
    expect(parsed).toMatchObject({ schemaVersion: 1, name: 'Error', code: 'EPIPE' });
    expect(JSON.stringify(parsed)).not.toMatch(/user:pass|PRIVATE_|stack|cause|body/);
    for (const bad of [null, [], {}, { ...detail, schemaVersion: 2 }, { ...detail, name: 'PRIVATE_NAME' },
      { ...detail, code: 'PRIVATE_CODE' }, { ...detail, message: 'x'.repeat(1001) }]) expect(parseInterruptionDetail(bad)).toBeUndefined();
  });

  it('reuses exactly the existing evidence redactor rather than introducing competing pattern rules', () => {
    expect(redactEvidenceText).toBe(redactDiagnosticText);
    expect(redactEvidenceText('token=PRIVATE')).toBe('token=[redacted]');
  });
});
