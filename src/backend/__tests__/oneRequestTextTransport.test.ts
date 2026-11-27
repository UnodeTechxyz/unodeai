import { describe, expect, it, vi } from 'vitest';
import { sendOneTextRequest, TextRequestCancelledError } from '../oneRequestTextTransport';
import { SummaryRequestCancelledError, sendSummaryRequest } from '../../compaction/SummaryRequest';

/*
 * v0.9.110 (Codex audit F5): the host's one-request text transport, shared by the conversation summary and the reply
 * suggestion. Consent first, the caller's last check, then exactly one POST; nothing is retried.
 */

const request = (signal?: AbortSignal, onRequestSent?: () => void) => ({
  url: 'https://gateway.example/v1/chat/completions', apiKey: 'k', body: { model: 'm', messages: [], stream: false },
  scope: { profileId: 'unode', profileRevision: 1 }, ...(signal ? { signal } : {}), ...(onRequestSent ? { onRequestSent } : {}),
});

function deps(events: string[], status = 200) {
  return {
    approveEgress: vi.fn(async () => { events.push('consent'); }),
    fetch: vi.fn(async () => { events.push('fetch'); return { ok: status < 400, status, text: async () => '{"ok":true}' }; }),
  };
}

describe('sendOneTextRequest', () => {
  it('asks consent, runs the last check, marks the request sent, then POSTs once', async () => {
    const events: string[] = [];
    const d = deps(events);
    const result = await sendOneTextRequest(request(undefined, () => events.push('sent')), {
      ...d, beforeSend: () => { events.push('check'); return true; },
    });
    expect(events).toEqual(['consent', 'check', 'sent', 'fetch']);
    expect(result).toEqual({ ok: true, status: 200, text: '{"ok":true}' });
    expect(d.fetch.mock.calls[0]).toEqual([request().url, expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' } })]);
  });

  it('a last check that says no, or a cancel after consent, sends nothing', async () => {
    const events: string[] = [];
    const d = deps(events);
    await expect(sendOneTextRequest(request(), { ...d, beforeSend: () => false })).rejects.toBeInstanceOf(TextRequestCancelledError);
    const controller = new AbortController();
    await expect(sendOneTextRequest(request(controller.signal), {
      ...d, approveEgress: async () => { controller.abort(); },
    })).rejects.toBeInstanceOf(TextRequestCancelledError);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('a declined consent sends nothing and is reported as the decline', async () => {
    const events: string[] = [];
    const d = deps(events);
    await expect(sendOneTextRequest(request(), { ...d, approveEgress: async () => { throw new Error('declined'); } })).rejects.toThrow('declined');
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('a provider failure is returned as it came: one request, no retry', async () => {
    const events: string[] = [];
    const d = deps(events, 500);
    expect(await sendOneTextRequest(request(), d)).toMatchObject({ ok: false, status: 500 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('the summary request keeps its own behaviour over the shared transport', async () => {
    const events: string[] = [];
    const d = deps(events);
    await expect(sendSummaryRequest(request(), { ...d, requestBoundary: async () => 'stopped' })).rejects.toBeInstanceOf(SummaryRequestCancelledError);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(await sendSummaryRequest(request(), { ...d, requestBoundary: async () => 'proceed' })).toMatchObject({ ok: true });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
});
