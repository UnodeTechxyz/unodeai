import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SummaryRequestCancelledError,
  sendSummaryRequest,
  summaryEgressScope,
  type SummaryEgressScope,
  type SummaryRequestDeps,
} from '../SummaryRequest';

const SCOPE: SummaryEgressScope = { profileId: 'unode', profileRevision: 3 };

/** A transport that records, in order, the consent it was asked for, the sent mark and the request. */
function transport(opts: { decline?: boolean; duringConsent?: () => void } = {}) {
  const events: string[] = [];
  const deps: SummaryRequestDeps = {
    approveEgress: async (url, scope) => {
      events.push(`consent ${scope.profileId}#${scope.profileRevision} ${url}`);
      opts.duringConsent?.();
      if (opts.decline) throw new Error('The user declined model egress.');
    },
    fetch: async (url, init) => {
      events.push(`fetch ${url} ${init.headers.Authorization}`);
      return { ok: true, status: 200, text: async () => '{"choices":[]}' };
    },
  };
  return { deps, events };
}

// Field run F6 and F7: a manual Compact on an agent whose connection was already allowed asked again under a
// generic scope; the request, cancelled by the 180 s budget while that dialog waited, still left a coverage gap.
describe('host-summary request on the agent\'s own connection', () => {
  it('asks consent for the agent\'s own connection, marks the request sent, then sends it', async () => {
    const { deps, events } = transport();
    const result = await sendSummaryRequest({
      url: 'https://gw.example/v1/chat/completions', apiKey: 'k', body: { model: 'eco' }, scope: SCOPE,
      onRequestSent: () => events.push('sent'),
    }, deps);
    expect(result).toEqual({ ok: true, status: 200, text: '{"choices":[]}' });
    expect(events).toEqual([
      'consent unode#3 https://gw.example/v1/chat/completions',
      'sent',
      'fetch https://gw.example/v1/chat/completions Bearer k',
    ]);
  });

  it('sends nothing and marks nothing when the user declines', async () => {
    const { deps, events } = transport({ decline: true });
    await expect(sendSummaryRequest({
      url: 'https://gw.example/v1/chat/completions', apiKey: 'k', body: {}, scope: SCOPE,
      onRequestSent: () => events.push('sent'),
    }, deps)).rejects.toThrow('declined');
    expect(events).toEqual(['consent unode#3 https://gw.example/v1/chat/completions']);
  });

  it('never sends a request that was cancelled while its consent was open', async () => {
    const controller = new AbortController();
    const { deps, events } = transport({ duringConsent: () => controller.abort() });
    await expect(sendSummaryRequest({
      url: 'https://gw.example/v1/chat/completions', apiKey: 'k', body: {}, scope: SCOPE, signal: controller.signal,
      onRequestSent: () => events.push('sent'),
    }, deps)).rejects.toBeInstanceOf(SummaryRequestCancelledError);
    expect(events).toEqual(['consent unode#3 https://gw.example/v1/chat/completions']);
  });

  it('takes the scope from the connection profile and its revision, and refuses an unknown connection', () => {
    expect(summaryEgressScope({ id: 'unode', revision: 3 }, 'PM')).toEqual({ profileId: 'unode', profileRevision: 3 });
    expect(() => summaryEgressScope(undefined, 'PM')).toThrow('Unknown connection for PM.');
  });

  it('is what the extension sends summaries through, with the agent\'s own connection and the sent mark', () => {
    const source = readFileSync(resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const start = source.indexOf('async function summaryChatCompletion(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('const scope = summaryEgressScope(connectionProfileForAgent(config, effectiveConnectionRegistry), config.name);');
    expect(body).toContain('sendSummaryRequest(');
    expect(body).toContain('...(onRequestSent ? { onRequestSent } : {})');
    expect(body).not.toMatch(/egressGate\(summarizerUrl/);
    expect(body).not.toMatch(/\.fetch\(summarizerUrl/);
  });
});
