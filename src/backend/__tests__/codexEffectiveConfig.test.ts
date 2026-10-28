import { describe, expect, it } from 'vitest';
import { assertCodexEffectiveProcessConfig, codexEffectiveModelProvider, codexInitializeParams } from '../codexEffectiveConfig';
import { codexProtocolPermissionSettings } from '../CodexSpawnArgs';

// The design these tests realise: the assertions an agent start makes on App Server's own `config/read` answer, moved
// into one pure function that the start and the compatibility check share, unchanged in behaviour (CodexBackend.test.ts
// passes unchanged); and the `initialize` request both send.

function effective(profile: Parameters<typeof codexProtocolPermissionSettings>[0], overrides: Record<string, unknown> = {}, layers: unknown[] = []) {
  const settings = codexProtocolPermissionSettings(profile);
  return {
    config: {
      model_provider: 'openai',
      analytics: { enabled: false }, otel: { exporter: 'none' },
      approval_policy: settings.approvalPolicy, approvals_reviewer: settings.approvalsReviewer, sandbox_mode: settings.sandboxMode,
      sandbox_workspace_write: { network_access: settings.networkAccess },
      apps: { _default: { default_tools_approval_mode: settings.appApprovalMode, approvals_reviewer: settings.appApprovalsReviewer } },
      ...overrides,
    },
    layers,
  };
}

describe('the effective-config assertions', () => {
  it('accept every profile when its host-owned values are in effect', () => {
    for (const profile of ['ask-for-approval', 'read-only', 'approve-for-me', 'full-access'] as const) {
      expect(() => assertCodexEffectiveProcessConfig(effective(profile), { profile })).not.toThrow();
    }
  });

  it.each([
    ['analytics', { analytics: { enabled: true } }, 'Codex refused to start: analytics remained enabled despite the privacy override.'],
    ['analytics missing', { analytics: {} }, 'Codex refused to start: analytics remained enabled despite the privacy override.'],
    ['OTel', { otel: { exporter: 'otlp-http' } }, 'Codex refused to start: OTel export remained enabled despite the privacy override.'],
    ['the approval policy', { approval_policy: 'never' }, 'Codex refused to start: the host-owned approval policy did not win over local configuration.'],
    ['the sandbox', { sandbox_mode: 'danger-full-access' }, 'Codex refused to start: the host-owned sandbox profile did not win over local configuration.'],
    ['the network', { sandbox_workspace_write: { network_access: true } }, 'Codex refused to start: the host-owned sandbox network setting did not win over local configuration.'],
    ['the reviewer', { approvals_reviewer: 'auto_review' }, 'Codex refused to start: the host-owned approval reviewer did not win over local configuration.'],
    ['the MCP approval mode', { apps: { _default: { default_tools_approval_mode: 'approve', approvals_reviewer: 'user' } } }, 'Codex refused to start: MCP tool approval did not match the host-owned permission profile.'],
    ['the MCP reviewer', { apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'auto_review' } } }, 'Codex refused to start: MCP tool approval did not match the host-owned permission profile.'],
  ])('refuse when %s is not the host-owned value', (_name, overrides, message) => {
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', overrides), { profile: 'ask-for-approval', platform: 'linux' })).toThrow(message);
  });

  it('say how to fix a Windows downgrade of workspace-write to read-only, on Windows only', () => {
    const downgraded = effective('ask-for-approval', { sandbox_mode: 'read-only' });
    expect(() => assertCodexEffectiveProcessConfig(downgraded, { profile: 'ask-for-approval', platform: 'win32' })).toThrow(/Codex downgraded workspace-write to read-only/);
    expect(() => assertCodexEffectiveProcessConfig(downgraded, { profile: 'ask-for-approval', platform: 'linux' })).toThrow(/sandbox profile did not win/);
  });

  it('accept an absent network setting, as App Server may omit it', () => {
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', { sandbox_workspace_write: {} }), { profile: 'ask-for-approval' })).not.toThrow();
  });

  it('require the project layer disabled for user-only and enabled for native', () => {
    const disabled = [{ name: { type: 'project' }, disabledReason: 'untrusted' }];
    const enabled = [{ name: { type: 'project' } }];
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', {}, disabled), { profile: 'ask-for-approval', repositoryMode: 'user-only' })).not.toThrow();
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', {}, enabled), { profile: 'ask-for-approval', repositoryMode: 'user-only' }))
      .toThrow('Codex refused to start: Continue without project automation did not disable the project configuration layer.');
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', {}, enabled), { profile: 'ask-for-approval', repositoryMode: 'native' })).not.toThrow();
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', {}, disabled), { profile: 'ask-for-approval', repositoryMode: 'native' }))
      .toThrow('Codex refused to start: Trust and load did not enable the project configuration layer.');
    // Without a trust override, the project layer is not judged.
    expect(() => assertCodexEffectiveProcessConfig(effective('ask-for-approval', {}, enabled), { profile: 'ask-for-approval' })).not.toThrow();
  });

  it('refuse an answer that is not an object at all', () => {
    expect(() => assertCodexEffectiveProcessConfig(undefined, { profile: 'ask-for-approval' })).toThrow(/analytics remained enabled/);
  });
});

describe('the initialize request and the model provider', () => {
  it('names UnodeAi and its version, and the capabilities an agent start uses', () => {
    expect(codexInitializeParams('0.9.97')).toEqual({
      clientInfo: { name: 'unodeai', title: 'UnodeAi', version: '0.9.97' },
      capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false, extensions: {} },
    });
    expect(codexInitializeParams(undefined)).toMatchObject({ clientInfo: { version: 'dev' } });
  });

  it('reads the provider App Server names, and none for the account default', () => {
    expect(codexEffectiveModelProvider({ config: { model_provider: 'openai' } })).toBe('openai');
    expect(codexEffectiveModelProvider({ config: { model_provider: null } })).toBeUndefined();
    expect(codexEffectiveModelProvider({})).toBeUndefined();
  });
});
