import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { completionVerificationCommandIssue, parseCompletionVerificationPolicy, resolveCompletionVerificationPolicy,
  sameVerificationBinding, verificationCommandIssueMessage } from '../CompletionVerificationPolicy';
import { KNOWLEDGE_TEAM_SKILLS, teamKindFromSkills } from '../../state/TeamKind';
import { workspaceRootIdentity } from '../../state/WorkspaceRootIdentity';

const workspaceId = workspaceRootIdentity('C:/fixtures/software');
const resolve = (completionVerification?: unknown, agentSkills: string[] = [], legacy: unknown = 'npm run ci') =>
  resolveCompletionVerificationPolicy({ workspaceId, agentSkills, completionVerification, readLegacyGlobalCommand: () => legacy });

describe('completion verification policy (SPEC V02/V03, T1a only)', () => {
  it.each(KNOWLEDGE_TEAM_SKILLS)('keeps a missing %s knowledge policy disabled without reading the old command', (skill) => {
    const readLegacyGlobalCommand = vi.fn(() => { throw new Error('must not read global'); });
    const result = resolveCompletionVerificationPolicy({ workspaceId, agentSkills: ['coding', skill], readLegacyGlobalCommand });
    expect(result).toMatchObject({ kind: 'resolved', effective: {
      policy: { mode: 'disabled' }, source: 'legacy-default', teamKind: 'knowledge',
      binding: { workspaceId, source: 'legacy-default', teamKind: 'knowledge' },
    } });
    expect(readLegacyGlobalCommand).not.toHaveBeenCalled();
    expect(teamKindFromSkills([skill])).toBe('knowledge');
  });

  it('retains the software user command without materialising it into the input document', () => {
    const input = { workspaceId, agentSkills: [], readLegacyGlobalCommand: () => 'npm run ci' };
    expect(resolveCompletionVerificationPolicy(input)).toMatchObject({ kind: 'resolved', effective: {
      policy: { mode: 'command', command: 'npm run ci' }, source: 'legacy-global', teamKind: 'software',
    } });
    expect(input).not.toHaveProperty('completionVerification');
  });

  it.each([undefined, '', '  '])('retains software auto when the old user value is %j', (legacy) => {
    const result = resolveCompletionVerificationPolicy({ workspaceId, agentSkills: [], readLegacyGlobalCommand: () => legacy });
    expect(result).toMatchObject({ kind: 'resolved', effective: { policy: { mode: 'auto' }, source: 'legacy-default' } });
  });

  it.each([{ mode: 'auto' }, { mode: 'disabled' }, { mode: 'command', command: ' npm run ci  ' }])('explicit %j wins without reading legacy', (policy) => {
    const readLegacyGlobalCommand = vi.fn(() => { throw new Error('must not read'); });
    const result = resolveCompletionVerificationPolicy({ workspaceId, agentSkills: ['market-research'], completionVerification: policy, readLegacyGlobalCommand });
    expect(result).toMatchObject({ kind: 'resolved', effective: {
      policy: policy.mode === 'command' ? { mode: 'command', command: 'npm run ci' } : policy,
      source: 'team-document', teamKind: 'knowledge',
    } });
    expect(readLegacyGlobalCommand).not.toHaveBeenCalled();
  });

  it.each([null, false, '', [], {}, { mode: 'unknown' }, { mode: 'auto', command: 'npm test' },
    { mode: 'disabled', approval: true }, { mode: 'command' }, { mode: 'command', command: '' },
    { mode: 'command', command: 'echo ok\n' }, { mode: 'command', command: '\recho ok' },
    { mode: 'command', command: 'echo\0x' }, { mode: 'command', command: 'é'.repeat(1025) },
  ])('invalid explicit input never falls back: %j', (raw) => {
    const readLegacyGlobalCommand = vi.fn(() => 'npm test');
    expect(parseCompletionVerificationPolicy(raw)).toEqual({ kind: 'invalid' });
    expect(resolveCompletionVerificationPolicy({ workspaceId, agentSkills: [], completionVerification: raw, readLegacyGlobalCommand }))
      .toEqual({ kind: 'configuration-invalid', source: 'team-document', workspaceId, teamKind: 'software' });
    expect(readLegacyGlobalCommand).not.toHaveBeenCalled();
  });

  it('bounds commands by UTF-8 bytes, not UTF-16 length', () => {
    expect(parseCompletionVerificationPolicy({ mode: 'command', command: 'é'.repeat(1024) }).kind).toBe('valid');
    expect(parseCompletionVerificationPolicy({ mode: 'command', command: 'x'.repeat(2048) }).kind).toBe('valid');
    expect(parseCompletionVerificationPolicy({ mode: 'command', command: 'x'.repeat(2049) }).kind).toBe('invalid');
  });

  it.each([123, null, 'npm test\n', 'x'.repeat(2049)])('does not replace an invalid legacy setting with auto', (legacy) => {
    expect(resolve(undefined, [], legacy)).toMatchObject({ kind: 'configuration-invalid', source: 'legacy-global' });
  });

  it.each([
    ['type', { command: 'private-token' }, 'not-string'],
    ['NUL', 'private-token\0', 'nul'],
    ['CR', '\rprivate-token', 'line-break'],
    ['LF', 'private-token\n', 'line-break'],
    ['line break only', '\n', 'line-break'],
    ['CRLF whitespace only', ' \r\n\t', 'line-break'],
    ['empty', '  \t', 'empty'],
    ['ASCII over bound', 'x'.repeat(2049), 'too-long'],
    ['UTF-8 over bound', 'é'.repeat(1025), 'too-long'],
  ] as const)('diagnoses %s consistently with parsing, without raw command content', (_name, raw, issue) => {
    expect(completionVerificationCommandIssue(raw)).toBe(issue);
    expect(parseCompletionVerificationPolicy({ mode: 'command', command: raw })).toEqual({ kind: 'invalid' });
    expect(verificationCommandIssueMessage(issue)).not.toContain('private-token');
    if (issue === 'empty') {
      expect(resolve(undefined, [], raw)).toMatchObject({ kind: 'resolved', effective: { policy: { mode: 'auto' } } });
    } else {
      expect(resolve(undefined, [], raw)).toEqual({
        kind: 'configuration-invalid', source: 'legacy-global', workspaceId, teamKind: 'software', commandIssue: issue,
      });
    }
  });

  it.each(['x'.repeat(2048), 'é'.repeat(1024), '  npm test\t '])('retains command normalization at the exact byte boundary', raw => {
    expect(completionVerificationCommandIssue(raw)).toBeUndefined();
    expect(parseCompletionVerificationPolicy({ mode: 'command', command: raw })).toEqual({
      kind: 'valid', policy: { mode: 'command', command: raw.trim() },
    });
  });

  it('hashes only canonical policy and compares workspace, source and kind independently', () => {
    const first = resolve({ mode: 'command', command: ' npm run ci ' });
    const reordered = resolve({ command: 'npm run ci', mode: 'command' });
    if (first.kind !== 'resolved' || reordered.kind !== 'resolved') throw new Error('fixture');
    const binding = first.effective.binding;
    expect(binding.policyDigest).toBe(createHash('sha256').update('{"mode":"command","command":"npm run ci"}').digest('hex'));
    expect(sameVerificationBinding(binding, reordered.effective.binding)).toBe(true);
    for (const changed of [
      { ...binding, workspaceId: workspaceRootIdentity('C:/fixtures/other') },
      { ...binding, source: 'legacy-global' as const },
      { ...binding, teamKind: 'knowledge' as const },
      { ...binding, policyDigest: 'different' },
    ]) expect(sameVerificationBinding(binding, changed)).toBe(false);
    // An unrelated roster/MCP field is not an input to the resolver or binding.
    expect(Object.keys(binding).sort()).toEqual(['policyDigest', 'source', 'teamKind', 'workspaceId']);
  });
});
