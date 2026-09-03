import { describe, expect, it } from 'vitest';
import { ConsentGrantRegistry } from '../ConsentGrants';

describe('ConsentGrantRegistry', () => {
  it('migrates pre-0.9.35 string grants without fabricating their date or requester', () => {
    const grants = new ConsentGrantRegistry();
    const result = grants.restore('model', ['api.example.test']);

    expect(result).toEqual({ migratedLegacy: true });
    expect(grants.list('model')).toEqual([{ host: 'api.example.test' }]);
    expect(grants.serialize('model')).toEqual([{ host: 'api.example.test' }]);
  });

  it('records host, kind-specific provenance, and a real timestamp for a new approval', () => {
    const grants = new ConsentGrantRegistry();
    const at = new Date('2026-08-02T12:34:56.000Z');

    expect(grants.grant('metadata', 'models.example.test', 'Model picker: the list of models it can serve', at)).toBe(true);
    expect(grants.list('metadata')).toEqual([{
      host: 'models.example.test',
      grantedAt: '2026-08-02T12:34:56.000Z',
      requester: 'Model picker: the list of models it can serve',
    }]);
  });

  it('revokes only the requested kind and preserves the other grant plus its provenance', () => {
    const grants = new ConsentGrantRegistry();
    grants.grant('model', 'gateway.example.test', 'Developer via Gateway', new Date('2026-08-02T10:00:00.000Z'));
    grants.grant('metadata', 'gateway.example.test', 'Refresh model prices', new Date('2026-08-02T11:00:00.000Z'));

    expect(grants.revoke('model', 'gateway.example.test')).toBe(true);
    expect(grants.list('model')).toEqual([]);
    expect(grants.list('metadata')).toEqual([{
      host: 'gateway.example.test',
      grantedAt: '2026-08-02T11:00:00.000Z',
      requester: 'Refresh model prices',
    }]);
  });

  it('keeps vision and transcription approval separate even on the same host', () => {
    const grants = new ConsentGrantRegistry();
    grants.grant('model', 'gateway.example.test', 'ordinary model request');
    grants.grantMedia('gateway.example.test', 'vision', 'image asset routing');

    expect(grants.hasMedia('gateway.example.test', 'vision')).toBe(true);
    expect(grants.hasMedia('gateway.example.test', 'transcription')).toBe(false);
    expect(grants.list('media')).toMatchObject([{ host: 'gateway.example.test', mediaKind: 'vision' }]);
    expect(grants.revokeMedia('gateway.example.test', 'vision')).toBe(true);
    expect(grants.has('model', 'gateway.example.test')).toBe(true);
  });

  it('does not convert a legacy host-only grant into permission to upload media', () => {
    const grants = new ConsentGrantRegistry();
    expect(grants.restore('media', ['gateway.example.test'])).toEqual({ migratedLegacy: false });
    expect(grants.hasMedia('gateway.example.test', 'vision')).toBe(false);
  });
});
