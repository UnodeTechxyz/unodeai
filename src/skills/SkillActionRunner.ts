/*---------------------------------------------------------------------------------------------
 * Fixed executable-Skill runner packaged inside the VSIX.
 *
 * Skill folders cannot add code to this process. Every callable handler must be compiled into this file
 * and listed in SkillRegistry.BUNDLED_SKILL_ACTION_HANDLER_IDS. Structured JSON arrives on stdin.
 *--------------------------------------------------------------------------------------------*/

import { resolveBundledSkillActionHandler } from './SkillActionHandlers';

const MAX_INPUT_BYTES = 64 * 1024;

async function main(): Promise<void> {
  const handlerId = process.argv[2] ?? '';
  const handler = resolveBundledSkillActionHandler(handlerId);
  if (!handler) throw new Error('Unknown compiled Skill action handler.');
  let encoded = '';
  for await (const chunk of process.stdin) {
    encoded += String(chunk);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_INPUT_BYTES) throw new Error('Skill action input exceeds 64 KiB.');
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Skill action input must be a JSON object.');
  const output = await handler(parsed as Record<string, unknown>);
  process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
