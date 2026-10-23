/*---------------------------------------------------------------------------------------------
 *  UnodeAi - what a Codex App Server must report before anything runs in it (v0.9.97)
 *  The `initialize` request every App Server receives, and the checks of its own merged configuration that a start
 *  makes before it uses the process. The agent start and the no-model compatibility check share them, so the check
 *  proves exactly what a start requires.
 *--------------------------------------------------------------------------------------------*/

import { codexProtocolPermissionSettings } from './CodexSpawnArgs';
import type { ResolvedCodexPermissionProfile } from './CodexPermissionProfile';
import type { RepositoryAutomationMode } from '../security/RepositoryCliConfig';

type JsonObject = Record<string, unknown>;

/** The `initialize` params: UnodeAi's client identity and the capabilities it uses. */
export function codexInitializeParams(clientVersion: string | undefined): JsonObject {
  return {
    clientInfo: { name: 'unodeai', title: 'UnodeAi', version: clientVersion || 'dev' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: false,
      extensions: {},
    },
  };
}

/** What the process was started with, which its reported configuration must show in effect. */
export interface CodexEffectiveConfigExpectation {
  profile: ResolvedCodexPermissionProfile;
  /** The project trust override the argv carried; undefined when it carried none. */
  repositoryMode?: RepositoryAutomationMode;
  platform?: NodeJS.Platform;
}

/** The model provider `config/read` names, or undefined when the account's own default is in use. */
export function codexEffectiveModelProvider(response: unknown): string | undefined {
  // 0.155.1 reports `model_provider: null` when the authenticated account default is in use. Preserve
  // that native default by omitting the thread override; pin only a provider the CLI actually names.
  return stringValue(asObject(asObject(response).config).model_provider) || undefined;
}

/**
 * Throws unless the `config/read` answer shows the host-owned settings in effect: analytics off, no OTel export, the
 * profile's approval policy, sandbox, network setting, reviewer and MCP tool approval, and the project layer enabled
 * or disabled as the trust override asked. The extension never opens CODEX_HOME or ~/.codex itself.
 */
export function assertCodexEffectiveProcessConfig(response: unknown, expectation: CodexEffectiveConfigExpectation): void {
  const answer = asObject(response);
  const config = asObject(answer.config);
  const analytics = asObject(config.analytics);
  if (analytics.enabled !== false) {
    throw new Error('Codex refused to start: analytics remained enabled despite the privacy override.');
  }
  const otel = asObject(config.otel);
  if (otel.exporter !== 'none') {
    throw new Error('Codex refused to start: OTel export remained enabled despite the privacy override.');
  }
  const expected = codexProtocolPermissionSettings(expectation.profile);
  if (config.approval_policy !== expected.approvalPolicy) {
    throw new Error('Codex refused to start: the host-owned approval policy did not win over local configuration.');
  }
  if (
    expected.sandboxMode === 'workspace-write'
    && (expectation.platform ?? process.platform) === 'win32'
    && config.sandbox_mode === 'read-only'
  ) {
    throw new Error(
      'Codex downgraded workspace-write to read-only. Configure `[windows] sandbox = "unelevated"` '
      + '(or `"elevated"`) in your Codex configuration, then restart the agent.',
    );
  }
  if (config.sandbox_mode !== expected.sandboxMode) {
    throw new Error('Codex refused to start: the host-owned sandbox profile did not win over local configuration.');
  }
  const effectiveNetwork = asObject(config.sandbox_workspace_write).network_access;
  if (effectiveNetwork !== undefined && effectiveNetwork !== expected.networkAccess) {
    throw new Error('Codex refused to start: the host-owned sandbox network setting did not win over local configuration.');
  }
  if (config.approvals_reviewer !== expected.approvalsReviewer) {
    throw new Error('Codex refused to start: the host-owned approval reviewer did not win over local configuration.');
  }
  const appDefaults = asObject(asObject(config.apps)._default);
  if (
    appDefaults.default_tools_approval_mode !== expected.appApprovalMode
    || appDefaults.approvals_reviewer !== expected.appApprovalsReviewer
  ) {
    throw new Error('Codex refused to start: MCP tool approval did not match the host-owned permission profile.');
  }
  const projectLayers = Array.isArray(answer.layers)
    ? answer.layers.map(asObject).filter((layer) => asObject(layer.name).type === 'project')
    : [];
  if (expectation.repositoryMode === 'native' && projectLayers.some((layer) => typeof layer.disabledReason === 'string')) {
    throw new Error('Codex refused to start: Trust and load did not enable the project configuration layer.');
  }
  if (expectation.repositoryMode === 'user-only' && projectLayers.some((layer) => typeof layer.disabledReason !== 'string')) {
    throw new Error('Codex refused to start: Continue without project automation did not disable the project configuration layer.');
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
