import * as path from 'node:path';
import { systemFontCandidates, type SystemFontCandidate } from '../../content/document/SystemFontCandidates';

/**
 * Platform adapter for installed system font locations (AGENTS.md platform rules 2, 5, 7). The Windows font folder
 * comes from the Windows system root in the environment; no drive letter is assumed. Where it is unknown, or on a
 * platform without verified candidates (macOS and Linux are not verified), no candidate is offered and the caller
 * reports font-unavailable with the language it needed.
 */
export function platformSystemFontCandidates(language: string, style: 'regular' | 'bold',
  platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SystemFontCandidate[] {
  if (platform !== 'win32') return [];
  const root = env.WINDIR ?? env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root)) return [];
  return systemFontCandidates(platform, path.win32.join(root, 'Fonts'), language, style);
}
