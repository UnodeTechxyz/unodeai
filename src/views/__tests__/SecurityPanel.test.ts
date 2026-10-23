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

  it('renders Codex CLI consent as a separate revocable grant from the OpenAI API', () => {
    const html = render({
      ...base,
      egressGrants: [],
      codexGrants: [{ host: 'api.openai.com', requester: 'OpenAI Codex CLI' }],
    });
    expect(html).toContain('Codex CLI (configured provider)');
    expect(html).toContain('configured provider (OpenAI by default)');
    expect(html).toContain('does not grant ordinary OpenAI API access');
    expect(html).toContain('data-kind="codex"');
    expect(html).not.toContain('data-kind="model"');
  });

  it('shows the executable a Codex consent is bound to and marks legacy grants for re-prompt', () => {
    const bound = render({
      ...base,
      egressGrants: [],
      codexGrants: [{ host: 'api.openai.com', executablePath: 'C:/tools/codex.exe' }],
    });
    expect(bound).toContain('Executable: C:/tools/codex.exe');
    const legacy = render({ ...base, egressGrants: [], codexGrants: [{ host: 'api.openai.com' }] });
    expect(legacy).toContain('Legacy grant: no executable bound; next start asks again');
  });

  it('describes Codex using its native permission profile instead of Commands/Writes', () => {
    const html = render({
      ...base,
      agents: [{ id: 'codex', name: 'Codex', backend: 'codex', folderAccess: [], mcpServers: [] }],
    });
    expect(html).toContain('Ask for approval (default)');
    expect(html).toContain('Approve for me (Codex auto-review with a visible chat trail)');
    expect(html).toContain('Full access removes the sandbox');
    expect(html).toContain('Plan and host ceilings use read-only');
    expect(html).toContain('Codex CLI uses the native permission profile');
    expect(html).not.toContain('Commands decides shell requests');
  });

  it('renders model egress consent with its exact profile, destination, and revision', () => {
    const html = render({
      ...base,
      egressGrants: [{
        host: 'gateway.example.test',
        kind: 'model',
        profileId: 'custom:0123456789abcdef0123456789abcdef',
        destination: 'https://gateway.example.test:8443',
        profileRevision: 7,
        what: 'model prompts and responses',
      }],
    });

    expect(html).toContain('https://gateway.example.test:8443');
    expect(html).toContain('data-kind="model"');
    expect(html).toContain('data-profile-id="custom:0123456789abcdef0123456789abcdef"');
    expect(html).toContain('data-destination="https://gateway.example.test:8443"');
    expect(html).toContain('data-profile-revision="7"');
  });

  it('renders content-bound repository CLI grants with a precise revoke control', () => {
    const html = render({
      ...base,
      repositoryCliGrants: [{
        kind: 'codex',
        cwd: 'C:\\projects\\demo',
        digest: 'sha256:0123456789abcdef',
        mode: 'native',
        grantedAt: '2026-09-21T12:34:56.000Z',
      }],
    });

    expect(html).toContain('Repository CLI configuration');
    expect(html).toContain('C:\\projects\\demo');
    expect(html).toContain('Trust and load');
    expect(html).toContain('data-cli-kind="codex"');
    expect(html).toContain('data-cli-cwd="C:\\projects\\demo"');
    expect(html).toContain('data-cli-digest="sha256:0123456789abcdef"');
  });

  it('lists session local-read decisions with distinct grant and revoke controls', () => {
    const html = render({
      ...base,
      localReadScopes: [
        { absoluteRoot: 'C:\\projects', status: 'declined' },
        { absoluteRoot: 'D:\\shared', status: 'granted' },
      ],
    });

    expect(html).toContain('Local folder discovery');
    expect(html).toContain('data-local-root="C:\\projects"');
    expect(html).toContain('data-local-action="grantLocalReadScope"');
    expect(html).toContain('data-local-root="D:\\shared"');
    expect(html).toContain('data-local-action="revokeLocalReadScope"');
    expect(html).toContain('A decline blocks the current request');
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
