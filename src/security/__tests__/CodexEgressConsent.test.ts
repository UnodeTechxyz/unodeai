import { describe, expect, it, vi } from 'vitest';
import { CodexEgressConsent } from '../CodexEgressConsent';
import { ConsentGrantRegistry } from '../ConsentGrants';

describe('CodexEgressConsent', () => {
  it('stores Codex CLI consent without granting ordinary OpenAI API model egress', async () => {
    const grants = new ConsentGrantRegistry();
    const persist = vi.fn(async () => undefined);
    const consent = new CodexEgressConsent(grants, persist, async () => undefined);

    await consent.grant('API.OPENAI.COM', 'C:/tools/codex.exe', 'OpenAI Codex CLI');

    expect(consent.has('api.openai.com', 'C:/tools/codex.exe')).toBe(true);
    expect(consent.has('api.openai.com', 'C:/other/codex.exe')).toBe(false);
    expect(grants.has('model', 'api.openai.com')).toBe(false);
    expect(consent.list()).toEqual([expect.objectContaining({
      host: 'api.openai.com', executablePath: 'C:/tools/codex.exe',
    })]);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('revoking the Codex consent persists the removal and kills running Codex process trees', async () => {
    const grants = new ConsentGrantRegistry();
    grants.grant('codex', 'api.openai.com', 'Legacy OpenAI Codex CLI');
    grants.grantCodex('api.openai.com', 'C:/tools/codex.exe', 'OpenAI Codex CLI');
    const persist = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const consent = new CodexEgressConsent(grants, persist, stop);

    await expect(consent.revoke('api.openai.com')).resolves.toBe(true);

    expect(consent.has('api.openai.com', 'C:/tools/codex.exe')).toBe(false);
    expect(consent.list()).toEqual([]);
    expect(persist).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('restores a legacy host-only grant as revocable but never treats it as executable consent', () => {
    const grants = new ConsentGrantRegistry();
    const consent = new CodexEgressConsent(grants, async () => undefined, async () => undefined);
    consent.restore([{ host: 'api.openai.com', requester: 'Older UnodeAi' }]);

    expect(consent.list()).toEqual([expect.objectContaining({ host: 'api.openai.com' })]);
    expect(consent.has('api.openai.com', 'C:/tools/codex.exe')).toBe(false);
  });
});
