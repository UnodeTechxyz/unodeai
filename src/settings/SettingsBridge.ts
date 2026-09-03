/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SettingsBridge (P1#4b / P1#8)
 *  One place that reads & writes everything "settings": VS Code config (roam.*), API keys
 *  (SecretStorage), and the MCP server registry. Centralizing this both powers the Settings panel
 *  AND pulls the scattered getConfiguration('unode') calls out of extension.ts (the GLM-flagged
 *  refactor). Dependencies are injected as small interfaces so the bridge is unit-testable without
 *  the vscode module.
 *
 *  SECURITY: the bridge NEVER returns API-key plaintext. Provider status is derived from
 *  SecretStorage.has() only — a boolean, never the secret itself — so nothing sensitive can reach
 *  the webview.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { AuthKind, ConnectionAvailability, ConnectionPresentation } from '../routes/RouteContracts';
import type { BillingKind, ConnectionProfile } from '../routes/RouteContracts';

/** Minimal SecretStorage surface (satisfied by SecretsManager). */
export interface SecretStore {
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<void>;
}

/** Minimal config surface (satisfied by a thin vscode.workspace.getConfiguration adapter). */
export interface ConfigStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
}

/** A connection the Settings panel knows how to show. Values come from the route registry. */
export interface ProviderDef {
  providerId: string;
  /** Immutable route identity. Built-ins may retain a legacy provider alias for compatibility. */
  connectionId?: string;
  /** Registry/profile revision at which this provider definition was resolved. */
  revision?: number;
  name: string;
  apiKeySecretName?: string;
  /** Generated custom-profile refs are intentionally not operable through the generic key controls. */
  canManageApiKey?: boolean;
  billingKind?: BillingKind;
  baseUrl?: string;
  authKind: AuthKind;
  /** Catalog protocol controls whether the card can offer an HTTP model-catalog test. */
  catalogKind?: ConnectionProfile['catalogKind'];
  /** Omitted only by legacy/test embedders; the registry always supplies it. */
  availability?: ConnectionAvailability;
  availabilityMessage?: string;
  presentation: ConnectionPresentation;
}

export interface ProviderStatus {
  providerId: string;
  connectionId?: string;
  revision?: number;
  name: string;
  apiKeySecretName?: string;
  canManageApiKey: boolean;
  billingKind?: BillingKind;
  /** True if a key is stored. The key VALUE is never included (security). */
  hasApiKey: boolean;
  baseUrl?: string;
  authKind: AuthKind;
  catalogKind?: ConnectionProfile['catalogKind'];
  availability: ConnectionAvailability;
  availabilityMessage?: string;
  presentation: ConnectionPresentation;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: MCPServerConfig['transport'];
  requiresApproval: boolean;
  /** Whether this server is currently connected in the in-process Hub (openai-compat agents). */
  connected: boolean;
  toolCount: number;
  /** Agent ids granted this server (default-deny visibility). */
  grantedTo: string[];
}

/** Live MCP state the bridge needs (injected from MCPHub + the team registry + grant resolver). */
export interface McpStateSource {
  registry: Map<string, MCPServerConfig>;
  connected(id: string): { ready: boolean; toolCount: number } | undefined;
  grantedTo(id: string): string[];
}

export interface SettingsSnapshot {
  registryRevision: number;
  providers: ProviderStatus[];
  mcpServers: McpServerStatus[];
}

export class SettingsBridge {
  private readonly registryRevision: () => number;
  private readonly mcp?: McpStateSource;

  constructor(
    private secrets: SecretStore,
    private config: ConfigStore,
    private providers: readonly ProviderDef[] | (() => readonly ProviderDef[]),
    registryRevisionOrMcp: (() => number) | McpStateSource = () => 0,
    mcp?: McpStateSource,
  ) {
    // Preserve the original fourth-argument MCP injection for existing embedders and tests while
    // allowing the extension host to supply a live registry revision before MCP state.
    if (typeof registryRevisionOrMcp === 'function') {
      this.registryRevision = registryRevisionOrMcp;
      this.mcp = mcp;
    } else {
      this.registryRevision = () => 0;
      this.mcp = registryRevisionOrMcp;
    }
  }

  /** Whole-panel snapshot. Contains NO secret values — only hasApiKey booleans. */
  async getSnapshot(): Promise<SettingsSnapshot> {
    return {
      registryRevision: this.registryRevision(),
      providers: await this.getProviderStatuses(),
      mcpServers: this.getMcpServers(),
    };
  }

  async getProviderStatuses(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.currentProviders().map(async (p) => ({
        providerId: p.providerId,
        connectionId: p.connectionId,
        revision: p.revision,
        name: p.name,
        ...(p.canManageApiKey === false ? {} : { apiKeySecretName: p.apiKeySecretName }),
        hasApiKey: p.authKind === 'api-key' && !!p.apiKeySecretName
          ? await this.secrets.has(p.apiKeySecretName)
          : false,
        canManageApiKey: p.canManageApiKey !== false,
        billingKind: p.billingKind,
        baseUrl: p.baseUrl,
        authKind: p.authKind,
        catalogKind: p.catalogKind,
        availability: p.availability ?? 'available',
        availabilityMessage: p.availabilityMessage,
        presentation: p.presentation,
      }))
    );
  }

  private currentProviders(): readonly ProviderDef[] {
    return typeof this.providers === 'function' ? this.providers() : this.providers;
  }

  getMcpServers(): McpServerStatus[] {
    if (!this.mcp) {
      return [];
    }
    return [...this.mcp.registry.values()].map((cfg) => {
      const conn = this.mcp!.connected(cfg.id);
      return {
        id: cfg.id,
        name: cfg.name,
        transport: cfg.transport,
        requiresApproval: cfg.requiresApproval ?? false,
        connected: !!conn?.ready,
        toolCount: conn?.toolCount ?? 0,
        grantedTo: this.mcp!.grantedTo(cfg.id),
      };
    });
  }

  async deleteApiKey(secretName: string): Promise<void> {
    await this.secrets.delete(secretName);
  }

  /** Pass-through config writes (single source of truth: the same roam.* config the native UI edits). */
  getConfig<T>(key: string, fallback: T): T {
    return this.config.get(key, fallback);
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    await this.config.update(key, value);
  }
}
