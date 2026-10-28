/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Marketplace catalog (M0 contract)
 *  The frozen schema + loader the Marketplace browses. Three catalogs — Agents, MCP, Skills —
 *  are browsed GLOBALLY (extension-level) but APPLIED at a scope chosen on install
 *  (see MarketplaceInstallAction). Design: docs/V0.6.0_MARKETPLACE_AND_HEADER_IA.md.
 *
 *  This file is the contract M2 (webview renderer, Codex) and M3 (catalog content, DeepSeek)
 *  build against — keep it stable. Validation mirrors the house style of state/TeamFileSchema.ts
 *  (collect issues, throw once) so authored JSON fails loudly in CI/tests, not silently at runtime.
 *--------------------------------------------------------------------------------------------*/

import { AgentModelParams, AgentRole, ModelTier, SkillCategory } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog entry types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An installable agent preset. Essentially a `RoleTemplate` authored as data — M4 converts it to
 * an `AgentConfig` and adds it to a team (reusing the existing addAgent path). `skills` are ids
 * from RoleConfig's SKILL_LIBRARY; `tier` maps to a concrete model per provider.
 */
export interface AgentCatalogEntry {
  id: string;
  name: string;
  role: AgentRole;
  /** One-line pitch shown on the marketplace card. */
  summary: string;
  icon?: string;
  color?: string;
  /** Skill ids from SKILL_LIBRARY (RoleConfig). */
  skills: string[];
  /** Optional team MCP server ids this preset should be granted when those servers exist. */
  mcpServers?: string[];
  /** Claude model id (used when the agent runs on the anthropic/claude backend). */
  model: string;
  tier: ModelTier;
  systemPrompt: string;
  modelParams?: AgentModelParams;
  /** Stable key in ROLE_TEMPLATES when this is a shipped role definition. */
  roleTemplateKey?: string;
  /** Informational only. Adding the role never configures, approves, mounts, or grants these. */
  suggestedMcpServers?: string[];
}

export type McpMaintenanceState = 'maintained' | 'reference' | 'community';

export interface McpInstallIdentity {
  ecosystem: 'npm' | 'pypi' | 'docker' | 'endpoint';
  /** Exact package or image token executed by the catalog entry. */
  value: string;
}

/**
 * An installable MCP server. Maps to `MCPServerConfig` plus card metadata. `env` values may carry
 * ${VAR} placeholders resolved from SecretStorage at runtime — never authored with real secrets.
 * M4 generates the config and routes it through the existing MCP approval gate.
 */
export interface McpCatalogEntry {
  id: string;
  name: string;
  summary: string;
  icon?: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command?: string; // stdio
  args?: string[]; // stdio
  url?: string; // remote
  /** Optional install-time prompt for remote MCP servers whose URL is user/local-runtime specific. */
  urlPrompt?: {
    title: string;
    prompt: string;
    placeHolder?: string;
    value?: string;
  };
  env?: Record<string, string>;
  /** Display-only prerequisite hint shown before install (e.g. uv, Docker). */
  prerequisite?: string;
  /** Authoritative project or vendor documentation URL. Required for every active entry. */
  source: string;
  maintenanceState: McpMaintenanceState;
  /** ISO date on which source, maintenance, and install identity were last checked. */
  lastVerified: string;
  /** Exact package/image token, or fixed remote endpoint, used by the configuration above. */
  installIdentity: McpInstallIdentity;
}

/**
 * An installable skill package. `body` is the inline SKILL.md content; in Phase 3 it is loaded
 * on-demand (progressive disclosure) rather than always in context. `capabilities` are builtin
 * tool tokens it grants (e.g. 'read', 'write', 'search', 'execute').
 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  summary: string;
  category: SkillCategory;
  capabilities: string[];
  body?: string;
}

export interface MarketplaceCatalog {
  agents: AgentCatalogEntry[];
  mcp: McpCatalogEntry[];
  skills: SkillCatalogEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Install (scope) action contract
//   The message each tab's `Add ▾` posts from the webview. M4 implements the handlers.
//   Browse is global; this is where the chosen application scope is carried.
// ─────────────────────────────────────────────────────────────────────────────

export type MarketplaceInstallAction =
  | { kind: 'agent'; entryId: string; target: 'current-team' | 'new-team' }
  | { kind: 'mcp'; entryId: string; scope: 'extension' | 'current-team' }
  | { kind: 'skill'; entryId: string; scope: 'global' | 'project' };

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export class CatalogValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid marketplace catalog: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'CatalogValidationError';
  }
}

/**
 * Validation options. `knownSkillIds`, when supplied (the builtin SKILL_LIBRARY id set), turns an
 * agent's `skills[]` referencing a non-existent skill into a hard error instead of a silent runtime
 * no-op. This is a *structural backstop*: it makes the invented-id class fail loudly in CI/tests
 * rather than ship and break M4's getSkillsByIds — the only reliable guard against a weak content
 * author using ids that aren't in the library. DI'd (not imported) to keep this file decoupled.
 */
export interface ParseOptions {
  knownSkillIds?: ReadonlySet<string>;
}

// Keep in sync with the AgentRole union in types.ts. 'solo' and 'custom' are intentionally
// excluded — solo is a mode, custom has no preset identity worth shipping in a catalog.
const INSTALLABLE_ROLES = new Set<AgentRole>([
  'architect', 'developer', 'reviewer', 'qa', 'pm', 'product-manager', 'devops',
  'tech-writer', 'security', 'data-engineer', 'senior-dev', 'tester', 'solo', 'custom',
]);
const TIERS = new Set<ModelTier>(['premium', 'standard', 'economy']);
const CATEGORIES = new Set<SkillCategory>([
  'development', 'testing', 'design', 'documentation', 'management', 'security', 'infrastructure', 'data', 'external',
]);
const TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse']);

/** Parse + validate the agents catalog (the parsed contents of agents.json). Throws on any issue. */
export function parseAgentCatalog(raw: unknown, opts: ParseOptions = {}): AgentCatalogEntry[] {
  const issues: string[] = [];
  const entries = asArray(raw, 'agents', issues);
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const path = `agents[${i}]`;
    if (!isRecord(e)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    requireString(e, 'id', path, issues);
    flagDuplicateId(e.id, seen, path, issues);
    requireString(e, 'name', path, issues);
    requireString(e, 'summary', path, issues);
    requireString(e, 'model', path, issues);
    requireString(e, 'systemPrompt', path, issues);
    if (typeof e.role !== 'string' || !INSTALLABLE_ROLES.has(e.role as AgentRole)) {
      issues.push(`${path}.role has unsupported value "${String(e.role)}"`);
    }
    if (typeof e.tier !== 'string' || !TIERS.has(e.tier as ModelTier)) {
      issues.push(`${path}.tier must be one of premium|standard|economy`);
    }
    if (!isStringArray(e.skills)) {
      issues.push(`${path}.skills must be an array of skill ids`);
    } else if (e.skills.length === 0) {
      issues.push(`${path}.skills must include at least one skill id`);
    } else if (opts.knownSkillIds) {
      for (const s of e.skills) {
        if (!opts.knownSkillIds.has(s)) {
          issues.push(`${path}.skills references unknown id "${s}" — not in SKILL_LIBRARY`);
        }
      }
    }
    if (e.mcpServers !== undefined) {
      issues.push(`${path}.mcpServers is not allowed: role integrations are suggestions, never grants`);
    }
    if (e.suggestedMcpServers !== undefined && !isStringArray(e.suggestedMcpServers)) {
      issues.push(`${path}.suggestedMcpServers must be an array of MCP server ids`);
    }
    if (e.roleTemplateKey !== undefined && (typeof e.roleTemplateKey !== 'string' || e.roleTemplateKey === '')) {
      issues.push(`${path}.roleTemplateKey must be a non-empty string`);
    }
    if (e.icon !== undefined && typeof e.icon !== 'string') issues.push(`${path}.icon must be a string`);
    if (e.color !== undefined && typeof e.color !== 'string') issues.push(`${path}.color must be a string`);
    if (e.modelParams !== undefined && !isRecord(e.modelParams)) {
      issues.push(`${path}.modelParams must be an object`);
    }
  }
  if (issues.length > 0) throw new CatalogValidationError(issues);
  return entries as AgentCatalogEntry[];
}

/** Parse + validate the MCP catalog (the parsed contents of mcp.json). Throws on any issue. */
export function parseMcpCatalog(raw: unknown): McpCatalogEntry[] {
  const issues: string[] = [];
  const entries = asArray(raw, 'mcp', issues);
  const seen = new Set<string>();
  const allowed = new Set([
    'id', 'name', 'summary', 'icon', 'transport', 'command', 'args', 'url', 'urlPrompt', 'env',
    'prerequisite', 'source', 'maintenanceState', 'lastVerified', 'installIdentity',
  ]);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const path = `mcp[${i}]`;
    if (!isRecord(e)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    for (const key of Object.keys(e)) {
      if (!allowed.has(key)) issues.push(`${path}.${key} is not supported`);
    }
    requireString(e, 'id', path, issues);
    flagDuplicateId(e.id, seen, path, issues);
    requireString(e, 'name', path, issues);
    requireString(e, 'summary', path, issues);
    if (typeof e.transport !== 'string' || !TRANSPORTS.has(e.transport)) {
      issues.push(`${path}.transport must be one of stdio|streamable-http|sse`);
    }
    if (e.transport === 'stdio' && typeof e.command !== 'string') {
      issues.push(`${path}.command is required for stdio servers`);
    }
    if (e.transport === 'stdio' && (e.url !== undefined || e.urlPrompt !== undefined)) {
      issues.push(`${path} stdio servers cannot declare url or urlPrompt`);
    }
    if ((e.transport === 'streamable-http' || e.transport === 'sse') && (e.command !== undefined || e.args !== undefined)) {
      issues.push(`${path} remote servers cannot declare command or args`);
    }
    const hasUrl = typeof e.url === 'string';
    const hasUrlPrompt = isRecord(e.urlPrompt);
    if ((e.transport === 'streamable-http' || e.transport === 'sse') && !hasUrl && !hasUrlPrompt) {
      issues.push(`${path}.url or ${path}.urlPrompt is required for remote servers`);
    }
    if (e.urlPrompt !== undefined) {
      if (!isRecord(e.urlPrompt)) {
        issues.push(`${path}.urlPrompt must be an object`);
      } else {
        requireString(e.urlPrompt, 'title', `${path}.urlPrompt`, issues);
        requireString(e.urlPrompt, 'prompt', `${path}.urlPrompt`, issues);
        if (e.urlPrompt.placeHolder !== undefined && typeof e.urlPrompt.placeHolder !== 'string') {
          issues.push(`${path}.urlPrompt.placeHolder must be a string`);
        }
        if (e.urlPrompt.value !== undefined && typeof e.urlPrompt.value !== 'string') {
          issues.push(`${path}.urlPrompt.value must be a string`);
        }
      }
    }
    if (e.args !== undefined && !isStringArray(e.args)) issues.push(`${path}.args must be an array of strings`);
    if (e.env !== undefined && !isStringRecord(e.env)) {
      issues.push(`${path}.env must be an object whose values are strings`);
    }
    if (e.prerequisite !== undefined && (typeof e.prerequisite !== 'string' || e.prerequisite === '')) {
      issues.push(`${path}.prerequisite must be a non-empty string`);
    }
    requireHttpsUrl(e, 'source', path, issues);
    if (typeof e.source === 'string' && /github\.com\/modelcontextprotocol\/servers-archived(?:\/|$)/i.test(e.source)) {
      issues.push(`${path}.source points at the archived MCP servers repository`);
    }
    if (e.maintenanceState !== 'maintained' && e.maintenanceState !== 'reference' && e.maintenanceState !== 'community') {
      issues.push(`${path}.maintenanceState must be maintained|reference|community`);
    }
    validateLastVerified(e.lastVerified, path, issues);
    validateInstallIdentity(e, path, issues);
    validatePlaceholders(e, path, issues);
  }
  if (issues.length > 0) throw new CatalogValidationError(issues);
  return entries as McpCatalogEntry[];
}

/** Parse + validate the skills catalog (the parsed contents of skills.json). Throws on any issue. */
export function parseSkillCatalog(raw: unknown): SkillCatalogEntry[] {
  const issues: string[] = [];
  const entries = asArray(raw, 'skills', issues);
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const path = `skills[${i}]`;
    if (!isRecord(e)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    requireString(e, 'id', path, issues);
    flagDuplicateId(e.id, seen, path, issues);
    requireString(e, 'name', path, issues);
    requireString(e, 'summary', path, issues);
    if (typeof e.category !== 'string' || !CATEGORIES.has(e.category as SkillCategory)) {
      issues.push(`${path}.category has unsupported value "${String(e.category)}"`);
    }
    if (!isStringArray(e.capabilities)) {
      issues.push(`${path}.capabilities must be an array of strings`);
    }
    if (e.body !== undefined && typeof e.body !== 'string') issues.push(`${path}.body must be a string`);
  }
  if (issues.length > 0) throw new CatalogValidationError(issues);
  return entries as SkillCatalogEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly / loading
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogSourceName = 'agents' | 'mcp' | 'skills';

/** Pack already-parsed lists into a catalog. */
export function assembleCatalog(parts: MarketplaceCatalog): MarketplaceCatalog {
  return { agents: parts.agents, mcp: parts.mcp, skills: parts.skills };
}

/**
 * Merge catalogs (e.g. in-repo base + a fetched update). Later sources win on id collisions.
 * Fetched-source support is future work; this exists so M2's loader has a stable seam for it.
 */
export function mergeCatalogs(base: MarketplaceCatalog, override: MarketplaceCatalog): MarketplaceCatalog {
  return {
    agents: mergeById(base.agents, override.agents),
    mcp: mergeById(base.mcp, override.mcp),
    skills: mergeById(base.skills, override.skills),
  };
}

/**
 * Load the catalog from a JSON reader. `readJson(name)` returns the parsed contents of the
 * corresponding `marketplace/<name>.json`. Injecting the reader keeps this pure and unit-testable
 * (no fs / vscode coupling); M2 supplies a reader that reads the bundled files via the extension Uri.
 */
export function loadCatalog(
  readJson: (name: CatalogSourceName) => unknown,
  opts: ParseOptions = {},
): MarketplaceCatalog {
  return assembleCatalog({
    agents: parseAgentCatalog(readJson('agents'), opts),
    mcp: parseMcpCatalog(readJson('mcp')),
    skills: parseSkillCatalog(readJson('skills')),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers (local, mirroring state/TeamFileSchema.ts house style)
// ─────────────────────────────────────────────────────────────────────────────

function mergeById<T extends { id: string }>(base: T[], override: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of base) byId.set(item.id, item);
  for (const item of override) byId.set(item.id, item);
  return [...byId.values()];
}

function asArray(raw: unknown, name: string, issues: string[]): unknown[] {
  if (!Array.isArray(raw)) {
    issues.push(`${name} catalog must be a JSON array`);
    return [];
  }
  return raw;
}

function flagDuplicateId(id: unknown, seen: Set<string>, path: string, issues: string[]): void {
  if (typeof id === 'string' && id !== '') {
    if (seen.has(id)) issues.push(`${path}.id "${id}" is a duplicate`);
    seen.add(id);
  }
}

function requireString(obj: Record<string, unknown>, key: string, path: string, issues: string[]): void {
  if (typeof obj[key] !== 'string' || obj[key] === '') {
    issues.push(`${path}.${key} must be a non-empty string`);
  }
}

function requireHttpsUrl(obj: Record<string, unknown>, key: string, path: string, issues: string[]): void {
  const value = obj[key];
  if (typeof value !== 'string' || value === '') {
    issues.push(`${path}.${key} must be a non-empty authoritative URL`);
    return;
  }
  try {
    if (new URL(value).protocol !== 'https:') issues.push(`${path}.${key} must use https`);
  } catch {
    issues.push(`${path}.${key} must be a valid URL`);
  }
}

function validateLastVerified(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push(`${path}.lastVerified must be an ISO date (YYYY-MM-DD)`);
    return;
  }
  const verified = Date.parse(`${value}T00:00:00Z`);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (!Number.isFinite(verified) || verified > now + dayMs) {
    issues.push(`${path}.lastVerified must be a real date that is not in the future`);
  }
}

/** Staleness is visible at runtime, but never makes an otherwise valid catalog disappear. */
export function isCatalogVerificationOverdue(
  value: string,
  now = Date.now(),
  maxAgeDays = 180,
): boolean {
  const verified = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  return !Number.isFinite(verified) || now - verified > maxAgeDays * 24 * 60 * 60 * 1000;
}

function validateInstallIdentity(entry: Record<string, unknown>, path: string, issues: string[]): void {
  if (!isRecord(entry.installIdentity)) {
    issues.push(`${path}.installIdentity must name an exact package or image`);
    return;
  }
  const identity = entry.installIdentity;
  if (identity.ecosystem !== 'npm' && identity.ecosystem !== 'pypi' && identity.ecosystem !== 'docker' && identity.ecosystem !== 'endpoint') {
    issues.push(`${path}.installIdentity.ecosystem must be npm|pypi|docker|endpoint`);
  }
  if (typeof identity.value !== 'string' || identity.value === '') {
    issues.push(`${path}.installIdentity.value must be a non-empty string`);
    return;
  }
  if (identity.ecosystem === 'npm' && /@latest$/i.test(identity.value)) {
    issues.push(`${path}.installIdentity.value must not use the mutable @latest tag`);
  }
  if (entry.transport !== 'stdio') {
    if (identity.ecosystem !== 'endpoint') {
      issues.push(`${path}.installIdentity for a remote entry must use endpoint`);
    }
    const expectedEndpoint = typeof entry.url === 'string' ? entry.url : entry.source;
    if (identity.value !== expectedEndpoint) {
      issues.push(`${path}.installIdentity.value must exactly match the configured endpoint`);
    }
    return;
  }
  if (identity.ecosystem === 'endpoint') {
    issues.push(`${path}.installIdentity endpoint is not valid for a stdio entry`);
    return;
  }
  const expectedCommand = identity.ecosystem === 'npm' ? 'npx' : identity.ecosystem === 'pypi' ? 'uvx' : 'docker';
  if (entry.command !== expectedCommand) {
    issues.push(`${path}.installIdentity ecosystem does not match command "${String(entry.command)}"`);
  }
  if (!Array.isArray(entry.args) || !entry.args.includes(identity.value)) {
    issues.push(`${path}.installIdentity.value must exactly match an args token`);
  }
}

function validatePlaceholders(entry: Record<string, unknown>, path: string, issues: string[]): void {
  const values = [
    ...(Array.isArray(entry.args) ? entry.args : []),
    ...(isRecord(entry.env) ? Object.values(entry.env) : []),
    typeof entry.url === 'string' ? entry.url : '',
  ];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const withoutValid = value.replace(/\$\{[A-Z][A-Z0-9_]*\}/g, '');
    if (withoutValid.includes('${')) {
      issues.push(`${path} contains a malformed placeholder; use \${UPPER_SNAKE_CASE}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}
