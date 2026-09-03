import { v4 as uuidv4 } from 'uuid';
import { MCPServerConfig } from '../types';

export type GuidedMcpTransport = 'stdio' | 'streamable-http' | 'sse';

export function isValidMcpUrl(value: string): boolean {
  try {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateMcpEnvValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter a value, using a placeholder like ${MY_SECRET}.';
  }
  if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed)) {
    return 'Use a placeholder like ${MY_SECRET}; do not enter a literal secret.';
  }
  return null;
}

export function parseMcpEnvInput(raw: string | undefined): { ok: true; env?: Record<string, string> } | { ok: false; error: string } {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { ok: true };
  }
  const env: Record<string, string> = {};
  const parts = trimmed.split(/[\r\n,;]+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      return { ok: false, error: `Use KEY=\${VAR} for "${part}".` };
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, error: `Use a valid environment variable name for "${key}".` };
    }
    const valueError = validateMcpEnvValue(value);
    if (valueError) {
      return { ok: false, error: `${key}: ${valueError}` };
    }
    env[key] = value;
  }
  return { ok: true, env };
}

export function parseMcpArgs(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

export function buildMcpServerConfig(input: {
  name: string;
  transport: GuidedMcpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  requiresApproval: boolean;
}): MCPServerConfig {
  return {
    id: uuidv4(),
    name: input.name.trim(),
    transport: input.transport,
    command: input.command?.trim() || undefined,
    args: input.args,
    url: input.url?.trim() || undefined,
    env: input.env,
    requiresApproval: input.requiresApproval,
  };
}
