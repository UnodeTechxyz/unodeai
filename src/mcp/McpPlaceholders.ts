/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MCP placeholder substitution (args/url)
 *  `env` placeholders (${VAR}) are secrets, resolved from SecretStorage inside MCPHub (openai) or
 *  injected into the claude process env. ARGS/URL are different: they're visible in the process
 *  list, so they carry non-secret tokens like ${WORKDIR} (the filesystem server's allowed root).
 *  We substitute those here, before a server is mounted, on both backend paths.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';

/**
 * Return a copy of `cfg` with `${KEY}` placeholders in `args` and `url` replaced from `vars`.
 * Unknown placeholders are left untouched (so a typo is visible rather than silently blanked).
 * `env` is intentionally NOT touched — those are secrets resolved elsewhere.
 */
export function resolveServerPlaceholders(
  cfg: MCPServerConfig,
  vars: Record<string, string>
): MCPServerConfig {
  const sub = (s: string): string =>
    s.replace(/\$\{(\w+)\}/g, (whole, name: string) => (name in vars ? vars[name] : whole));

  const next: MCPServerConfig = { ...cfg };
  if (cfg.args) {
    next.args = cfg.args.map(sub);
  }
  if (cfg.url) {
    next.url = sub(cfg.url);
  }
  return next;
}
