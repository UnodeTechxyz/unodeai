import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentGrantRegistry } from '../security/ConsentGrants';
import { CodexEgressConsent } from '../security/CodexEgressConsent';
import {
  codexDeclineKey, ConsentDeclines, mediaDeclineKey, modelDeclineKey, resolveImpliedConsent,
} from '../security/ImpliedConsent';
import { describeMediaEgress, validateMediaEgressRequest } from '../media/MediaEgress';

/**
 * v0.9.99 B1/B2/B5: the real egress gates of extension.ts, run against the real grant registry and decline list.
 * Only the VS Code window is a stub, so each test sees exactly which question or notice a person would get.
 */
const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function extensionFunction(name: string, host: object) {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  expect(found).toHaveLength(1);
  const code = ts.transpileModule(found[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return ${name}; }`)(host);
}

class EgressConsentDeclinedError extends Error {}

function harness(stored: { declines?: unknown } = {}) {
  const warnings: string[] = [];
  const notices: string[] = [];
  let answer: string | undefined = 'Allow';
  const saved = new Map<string, unknown>();
  const consentGrants = new ConsentGrantRegistry();
  const consentDeclines = new ConsentDeclines();
  consentDeclines.restore(stored.declines);
  const stopCodex = vi.fn(async () => {});
  const host: Record<string, unknown> = {
    vscode: {
      window: {
        showWarningMessage: vi.fn(async (message: string) => { warnings.push(message); return answer; }),
        showInformationMessage: vi.fn((message: string) => { notices.push(message); return new Promise(() => {}); }),
      },
    },
    blockingPrompt: (_key: unknown, open: () => Promise<unknown>) => open(),
    attentionAppearance: () => undefined,
    pausingTurnClock: () => undefined,
    displayNameForProviderId: (id: string) => `Gateway ${id}`,
    effectiveConnectionRegistry: {},
    consentGrants,
    consentDeclines,
    persistConsentGrants: vi.fn(async (kind: string) => { saved.set(kind, consentGrants.serialize(kind as never)); }),
    persistConsentDeclines: vi.fn(async () => { saved.set('declines', consentDeclines.serialize()); }),
    resolveImpliedConsent, modelDeclineKey, codexDeclineKey, mediaDeclineKey,
    validateMediaEgressRequest, describeMediaEgress,
    canonicalCodexExecutablePath: (file: string) => file,
    EgressConsentDeclinedError,
    outputChannel: { warn: vi.fn() },
    codexEgressConsent: new CodexEgressConsent(consentGrants, async () => { saved.set('codex', consentGrants.serialize('codex')); }, stopCodex),
  };
  host.canonicalDestination = extensionFunction('canonicalDestination', host);
  const ensure = extensionFunction('ensureEgressConsent', host);
  const codex = extensionFunction('codexEgressGate', host);
  const media = extensionFunction('mediaEgressGate', host);
  const revoke = extensionFunction('revokeEgressConsent', host);
  return {
    warnings, notices, saved, consentGrants, stopCodex,
    answer: (value: string | undefined) => { answer = value; },
    model: (scope = { profileId: 'custom:abc', profileRevision: 3 }) =>
      ensure('https://gateway.example.test/v1/chat', 'Developer via Gateway', undefined, scope) as Promise<boolean>,
    codex: () => codex(undefined, 'Developer', '/opt/codex/bin/codex') as Promise<void>,
    media: () => media({ host: 'vision.example.test', provider: 'Vision', kind: 'vision', mediaClass: 'image', byteCount: 10 }, 'Developer') as Promise<void>,
    revoke: revoke as (host: string, kind?: string, mediaKind?: string, scope?: object) => void,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('B1 model egress: the connection the person chose is the consent', () => {
  it('the first request is sent without a question, records the grant and shows one non-modal notice', async () => {
    const h = harness();
    await expect(Promise.all([h.model(), h.model()])).resolves.toEqual([true, true]);
    await expect(h.model()).resolves.toBe(true);
    expect(h.warnings).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('https://gateway.example.test:443');
    expect(h.notices[0]).toContain('"UnodeAi: Security"');
    expect(h.saved.get('model')).toEqual([expect.objectContaining({ profileId: 'custom:abc', profileRevision: 3, host: 'gateway.example.test' })]);
  });

  it('a revoke in the Security panel survives: the next request asks, and "Do not allow" sends nothing', async () => {
    const h = harness();
    await h.model();
    h.revoke('gateway.example.test', 'model', undefined, { profileId: 'custom:abc', destination: 'https://gateway.example.test:443', profileRevision: 3 });
    expect(h.saved.get('declines')).toEqual([modelDeclineKey('custom:abc', 'https://gateway.example.test:443')]);
    h.answer('Do not allow');
    // An edited connection (a new revision) is still the revoked destination.
    await expect(h.model({ profileId: 'custom:abc', profileRevision: 4 })).resolves.toBe(false);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('You revoked or declined');
    await expect(h.model({ profileId: 'custom:abc', profileRevision: 4 })).resolves.toBe(false);
    expect(h.warnings).toHaveLength(2);
  });

  it('a decline stored by an earlier session is restored and kept; only "Allow" releases it', async () => {
    const h = harness({ declines: [modelDeclineKey('custom:abc', 'https://gateway.example.test:443'), 42] });
    h.answer('Allow');
    await expect(h.model()).resolves.toBe(true);
    expect(h.warnings).toHaveLength(1);
    expect(h.notices).toEqual([]);
    expect(h.saved.get('declines')).toEqual([]);
    await expect(h.model()).resolves.toBe(true);
    expect(h.warnings).toHaveLength(1);
  });

  it('another connection is not covered by a decline of the first', async () => {
    const h = harness({ declines: [modelDeclineKey('custom:abc', 'https://gateway.example.test:443')] });
    await expect(h.model({ profileId: 'custom:other', profileRevision: 1 })).resolves.toBe(true);
    expect(h.warnings).toEqual([]);
  });
});

describe('B2 Codex: choosing a Codex program is the consent', () => {
  it('starts without a question and records the grant for that program', async () => {
    const h = harness();
    await expect(h.codex()).resolves.toBeUndefined();
    expect(h.warnings).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('/opt/codex/bin/codex');
    expect(h.consentGrants.hasCodex('api.openai.com', '/opt/codex/bin/codex')).toBe(true);
  });

  it('a revoke stops Codex and survives: the next start asks, and a decline starts nothing', async () => {
    const h = harness();
    await h.codex();
    h.revoke('api.openai.com', 'codex');
    await vi.waitFor(() => expect(h.stopCodex).toHaveBeenCalled());
    h.answer('Do not allow');
    await expect(h.codex()).rejects.toBeInstanceOf(EgressConsentDeclinedError);
    expect(h.warnings).toHaveLength(1);
    h.answer('Start Codex');
    await expect(h.codex()).resolves.toBeUndefined();
    expect(h.saved.get('declines')).toEqual([]);
  });
});

describe('B5 media: the vision or transcription model the person set up is the consent', () => {
  it('uploads without a question, and a revoke brings the question back', async () => {
    const h = harness();
    await expect(h.media()).resolves.toBeUndefined();
    expect(h.warnings).toEqual([]);
    expect(h.notices).toHaveLength(1);
    h.revoke('vision.example.test', 'media', 'vision');
    h.answer(undefined);
    await expect(h.media()).rejects.toThrow('no media bytes were sent');
    expect(h.warnings).toHaveLength(1);
    expect(h.saved.get('declines')).toEqual([mediaDeclineKey('vision.example.test', 'vision')]);
  });
});
