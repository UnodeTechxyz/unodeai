import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { renderSecurityHtml, SecuritySnapshot } from '../SecurityPanel';

const base: SecuritySnapshot = {
  workspaceTrusted: true,
  virtualWorkspace: false,
  commandApproval: 'ask',
  writeApproval: 'none',
  concurrencyStrategy: 'optimistic',
  fetchCatalog: false,
  egressGrants: [
    { host: 'ai.weroam.xyz', grantedAt: '2026-08-02T12:34:56.000Z', requester: 'Developer via Roam' },
    { host: 'api.openai.com' },
  ],
  mcpServers: [{ id: 'gh', name: 'github', ready: true, toolCount: 5 }],
  agents: [{
    id: 'dev',
    name: 'Developer',
    backend: 'claude',
    folderAccess: [{ path: 'src', permission: 'readwrite' }, { path: 'docs', permission: 'read' }],
    mcpServers: ['gh'],
  }, {
    id: 'reviewer',
    name: 'Reviewer',
    backend: 'openai-compat',
    folderAccess: [],
    mcpServers: [],
  }],
  providers: [
    { providerId: 'unode', hasApiKey: true },
    { providerId: 'openai', hasApiKey: false },
  ],
};

const render = (s: SecuritySnapshot) => renderSecurityHtml(s, "default-src 'none'", 'nonce123');

describe('renderSecurityHtml', () => {
  it('renders every section for a trusted workspace', () => {
    const html = render(base);
    expect(html).toContain('UnodeAi Security');
    expect(html).toContain('Trusted');
    expect(html).toContain('No unapproved network'); // nothing is contacted until a host is approved
    expect(html).toContain('Ask each');               // commandApproval
    expect(html).toContain('github');                 // mcp server
    expect(html).toContain('Agent grants');
    expect(html).toContain('Read+Write');
    expect(html).toContain('src');
    expect(html).toContain('Workspace default');
    expect(html).toContain('unode');                  // provider
    expect(html).toContain('key set');                // provider with a key
    expect(html).toContain('nonce123');               // script nonce wired through
  });

  it('lists each approved egress host with a revoke control', () => {
    const html = render(base);
    expect(html).toContain('ai.weroam.xyz');
    expect(html).toContain('data-revoke="ai.weroam.xyz"');
    expect(html).toContain('data-revoke="api.openai.com"');
  });

  it('renders each grant\'s provenance in the row body without inventing a legacy date', () => {
    const html = render({
      ...base,
      metadataGrants: [{
        host: 'prices.example.test',
        grantedAt: '2026-08-02T12:34:56.000Z',
        requester: 'Refresh model prices',
      }],
    });
    const body = html.slice(html.lastIndexOf('</style>'));

    expect(body).toContain('Granted 2026-08-02 12:34:56.000 UTC');
    expect(body).toContain('Requested by Refresh model prices');
    expect(body).toContain('Granted before 0.9.35 — date unknown');
    expect(body).toContain('Requester unknown (legacy grant)');
  });

  it('shows the read-only warning when the workspace is untrusted', () => {
    const html = render({ ...base, workspaceTrusted: false });
    expect(html).toContain('Untrusted');
    expect(html).toMatch(/read-only/i);
    expect(html).toMatch(/disabled until you trust/i);
  });

  it('shows the "no gateway approved" state when there is no egress consent yet', () => {
    const html = render({ ...base, egressGrants: [] });
    expect(html).toContain('No gateway approved yet');
    expect(html).not.toContain('data-revoke=');
  });

  // Was: `fetchCatalog: true` → "Catalog fetch: ON". That test asserted the panel echo the SETTING. In the
  // state this build ships in (no bundled signing key) the code refuses to fetch a hosted catalog at all, so
  // the badge told the user the opposite of what the extension does — and this is the one screen a user reads
  // precisely because they do not want to read the code. It must report behaviour. (Codex, v0.9.29 review.)
  it('reports the EFFECTIVE catalog state, not the setting', () => {
    const shipped = render({
      ...base,
      fetchCatalog: true, // the user turned it on...
      catalogStatus: { text: 'Hosted catalog unavailable — publisher signing is not configured; bundled catalog only.', ok: true },
    });
    expect(shipped).toContain('publisher signing is not configured');
    expect(shipped).not.toContain('Catalog fetch: ON'); // ...and nothing is fetched, so we do not claim it is
  });

  it('warns only when a catalog actually failed verification', () => {
    expect(render({ ...base, fetchCatalog: true, catalogStatus: { text: 'Hosted catalog verified.', ok: true } }))
      .not.toContain('Catalog unverified');
    expect(render({
      ...base,
      fetchCatalog: true,
      catalogStatus: { text: 'Hosted catalog unverified — signature missing or invalid; bundled catalog only.', ok: false },
    })).toContain('Catalog unverified');
  });

  it('HTML-escapes host names (no injection from a crafted egress host)', () => {
    const html = render({ ...base, egressGrants: [{ host: '<script>alert(1)</script>' }] });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTML-escapes agent grant content', () => {
    const html = render({
      ...base,
      agents: [{
        id: 'bad',
        name: '<script>agent</script>',
        folderAccess: [{ path: '<script>path</script>', permission: 'read' }],
        mcpServers: ['<script>mcp</script>'],
      }],
    });
    expect(html).not.toContain('<script>agent</script>');
    expect(html).not.toContain('<script>path</script>');
    expect(html).not.toContain('<script>mcp</script>');
    expect(html).toContain('&lt;script&gt;agent');
    expect(html).toContain('&lt;script&gt;path');
    expect(html).toContain('&lt;script&gt;mcp');
  });

  it('uses a supplied registry display name and retains the raw id only in a support title', () => {
    const customId = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const html = renderSecurityHtml(
      { ...base, providers: [{ providerId: customId, hasApiKey: true }] },
      "default-src 'none'",
      'nonce123',
      (providerId) => providerId === customId ? 'Personal Gateway' : providerId,
    );
    expect(html).toContain('>Personal Gateway</code>');
    expect(html).toContain(`title="${customId}"`);
  });

  it('renders media upload consent separately from model and metadata grants', () => {
    const html = render({
      ...base,
      egressGrants: [],
      metadataGrants: [],
      mediaGrants: [{ host: 'vision.example.test', mediaKind: 'vision', requester: 'Image asset routing' }],
    });
    expect(html).toContain('vision upload only');
    expect(html).toContain('data-kind="media"');
    expect(html).toContain('data-media-kind="vision"');
  });
});
