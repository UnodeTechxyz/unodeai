import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPROVAL_POLICY = JSON.parse(readFileSync(resolve('src/mcp/approvalPolicy.json'), 'utf8'));
const APPROVAL_TRANSPORTS = new Set(APPROVAL_POLICY.approvalTransports);

const ALLOWED = new Set([
  'id', 'name', 'summary', 'icon', 'transport', 'command', 'args', 'url', 'urlPrompt', 'env',
  'prerequisite', 'source', 'maintenanceState', 'lastVerified', 'installIdentity',
]);
const STATES = new Set(['maintained', 'reference', 'community']);
const TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse']);

export function hostRequiresApproval(entry) {
  return APPROVAL_TRANSPORTS.has(entry.transport)
    || (APPROVAL_POLICY.environmentRequiresApproval && Object.keys(entry.env ?? {}).length > 0);
}

export function validateIntegrationCatalog(entries, options = {}) {
  const issues = [];
  const seen = new Set();
  const now = options.now ?? Date.now();
  if (!Array.isArray(entries)) return ['catalog must be an array'];
  entries.forEach((entry, index) => {
    const at = `mcp[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) if (!ALLOWED.has(key)) issues.push(`${at}.${key} is not supported`);
    if (!entry.id || typeof entry.id !== 'string') issues.push(`${at}.id is required`);
    else if (seen.has(entry.id)) issues.push(`${at}.id is a duplicate`);
    else seen.add(entry.id);
    if (!TRANSPORTS.has(entry.transport)) issues.push(`${at}.transport is unsupported`);
    if (typeof entry.source !== 'string' || !entry.source.startsWith('https://')) issues.push(`${at}.source is required`);
    if (/github\.com\/modelcontextprotocol\/servers-archived(?:\/|$)/i.test(entry.source ?? '')) issues.push(`${at}.source is archived`);
    if (!STATES.has(entry.maintenanceState)) issues.push(`${at}.maintenanceState is required and active`);
    const verified = typeof entry.lastVerified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.lastVerified)
      ? Date.parse(`${entry.lastVerified}T00:00:00Z`) : NaN;
    const day = 24 * 60 * 60 * 1000;
    if (!Number.isFinite(verified) || verified > now + day || now - verified > 180 * day) issues.push(`${at}.lastVerified is stale or invalid`);
    const identity = entry.installIdentity;
    if (!identity || typeof identity !== 'object' || typeof identity.value !== 'string') {
      issues.push(`${at}.installIdentity is required`);
    } else if (entry.transport === 'stdio') {
      if (identity.ecosystem === 'npm' && /@latest$/i.test(identity.value)) {
        issues.push(`${at}.installIdentity must not use mutable @latest`);
      }
      const expected = identity.ecosystem === 'npm' ? 'npx' : identity.ecosystem === 'pypi' ? 'uvx' : identity.ecosystem === 'docker' ? 'docker' : '';
      if (!expected || entry.command !== expected || !Array.isArray(entry.args) || !entry.args.includes(identity.value)) {
        issues.push(`${at}.installIdentity does not match the exact launch token`);
      }
    } else if (identity.ecosystem !== 'endpoint'
      || identity.value !== (typeof entry.url === 'string' ? entry.url : entry.source)) {
      issues.push(`${at}.installIdentity does not match the exact configured endpoint`);
    }
    const placeholderValues = [...(entry.args ?? []), ...Object.values(entry.env ?? {}), entry.url ?? ''];
    if (placeholderValues.some((value) => typeof value === 'string' && value.replace(/\$\{[A-Z][A-Z0-9_]*\}/g, '').includes('${'))) {
      issues.push(`${at} contains a malformed placeholder`);
    }
  });
  return issues;
}

export function assertIntegrationCatalog(entries, label = 'integration catalog') {
  const issues = validateIntegrationCatalog(entries);
  if (issues.length) throw new Error(`${label} failed:\n${issues.join('\n')}`);
}

export function proveIntegrationCatalogPlantedFailures(valid) {
  const plants = [
    [{ ...valid, source: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/x' }, 'archived'],
    [{ ...valid, source: undefined }, 'source'],
    [{ ...valid, maintenanceState: undefined }, 'maintenance'],
    [{ ...valid, maintenanceState: 'deprecated' }, 'deprecated'],
    [{ ...valid, inventedAuthority: true }, 'unknown schema'],
    [{ ...valid, installIdentity: { ecosystem: 'npm', value: 'wrong-package' } }, 'identity'],
    [{ ...valid, args: ['-y', 'example@latest'], installIdentity: { ecosystem: 'npm', value: 'example@latest' } }, 'mutable tag'],
  ];
  for (const [entry, label] of plants) {
    if (validateIntegrationCatalog([entry]).length === 0) throw new Error(`planted ${label} failure survived`);
  }
}

function approvalWiringIssues(enforcement, panel) {
  const issues = [];
  if (!enforcement.includes("import approvalPolicy from './approvalPolicy.json'")) {
    issues.push('MCP enforcement is not consuming the shared approval policy');
  }
  if (!panel.includes('shouldRequireApproval(toMcpServerConfig(entry))') || panel.includes('entry.requiresApproval')) {
    issues.push('Marketplace approval label is not exclusively host-derived');
  }
  return issues;
}

function assertProductionApprovalWiring() {
  const enforcement = readFileSync(resolve('src/mcp/McpApproval.ts'), 'utf8');
  const panel = readFileSync(resolve('src/views/MarketplacePanel.ts'), 'utf8');
  const issues = approvalWiringIssues(enforcement, panel);
  if (issues.length) throw new Error(issues.join('; '));

  const plantedPanel = panel.replace('shouldRequireApproval(toMcpServerConfig(entry))', 'entry.requiresApproval === true');
  const plantedIssues = approvalWiringIssues(enforcement, plantedPanel);
  if (!plantedIssues.some((issue) => issue.includes('Marketplace approval label'))) {
    throw new Error('the production approval-wiring audit accepted a planted UI/enforcement divergence');
  }
}

function main() {
  const arg = process.argv.indexOf('--catalog');
  const file = resolve(arg >= 0 ? process.argv[arg + 1] : 'marketplace/mcp.json');
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  assertIntegrationCatalog(entries, file);
  if (!entries[0]) throw new Error('integration catalog is empty');
  proveIntegrationCatalogPlantedFailures(entries[0]);
  assertProductionApprovalWiring();
  console.log(`integration catalog gate passed (${entries.length} active entries; planted failures killed)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
