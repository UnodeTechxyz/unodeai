import type { SecretResolver } from './MCPHub';

/** Resolve configured placeholders against SecretStorage for both a live mount and a connection test. */
export async function resolveMcpSecretEnvironment(
  env: Record<string, string> | undefined,
  resolveSecret: SecretResolver,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const resolved = new Map<string, string>();
  for (const raw of Object.values(env ?? {})) {
    for (const [, name] of raw.matchAll(/\$\{(\w+)\}/g)) {
      if (resolved.has(name)) continue;
      const value = await resolveSecret(name);
      if (value === undefined) throw new Error(`Required secret ${name} is not configured.`);
      if (value.length === 0) throw new Error(`Configured secret ${name} is empty.`);
      resolved.set(name, value);
    }
  }
  return {
    env: Object.fromEntries(Object.entries(env ?? {}).map(([key, raw]) => [
      key, raw.replace(/\$\{(\w+)\}/g, (_match, name: string) => resolved.get(name)!),
    ])),
    secretValues: [...new Set(resolved.values())],
  };
}
