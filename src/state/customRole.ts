/**
 * v0.9.100: the one rule for a typed ("Custom role") agent role. Agent Builder saves with it and the team-file
 * reader checks with it, so the name Builder stores is exactly the name the file loads.
 *
 * 1. Remove C0 and C1 control characters (NUL, tab, newline, ...) and DEL. Node refuses a NUL in a process
 *    environment value, and the role reaches the spawned CLI as `ROAM_AGENT_ROLE`.
 * 2. Trim.
 * 3. Cut to 80 UTF-16 units, the length Builder has always allowed, without splitting a surrogate pair.
 * 4. Trim again, so a cut that ends on a space cannot leave a value the next cleaning would change.
 *
 * The rule is idempotent: `cleanCustomRole(cleanCustomRole(x)) === cleanCustomRole(x)`. An empty result means
 * there is no usable name; the caller decides whether that is a refusal. A non-string cleans to ''.
 */
export const CUSTOM_ROLE_MAX_LENGTH = 80;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export function cleanCustomRole(value: unknown): string {
  if (typeof value !== 'string') return '';
  return cutWithoutSplittingPair(value.replace(CONTROL_CHARACTERS, '').trim(), CUSTOM_ROLE_MAX_LENGTH).trim();
}

function cutWithoutSplittingPair(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}
