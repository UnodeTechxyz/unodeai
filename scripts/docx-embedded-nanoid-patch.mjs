import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
const pin = JSON.parse(readFileSync(new URL('./license-texts/docx-9.7.1-embedded.json', import.meta.url), 'utf8'));
/** docx 9.7.1 embeds nanoid 5.1.11: an npm override alone does not repair that published code. */
export function patchDocxEmbeddedNanoid(bytes, format) {
  const expected = format === 'cjs' ? pin.original_cjs_sha256 : format === 'mjs' ? pin.original_mjs_sha256 : undefined;
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Unreviewed docx bundle bytes; review the local nanoid patch before changing this dependency');
  let source = bytes.toString('utf8');
  // Exact upstream nanoid 5.1.16 non-secure fix: negative sizes no longer loop indefinitely.
  for (const expression of ['while (i--) id += alphabet[Math.random() * alphabet.length | 0];', 'while (i--) id += urlAlphabet[Math.random() * 64 | 0];']) {
    if (source.split(expression).length !== 2) throw Error('The reviewed embedded nanoid patch no longer matches');
    source = source.replace(expression, expression.replace('i--)', 'i-- > 0)'));
  }
  return source;
}
export const docxEmbeddedNanoidPatch = { name: 'docx-9.7.1-embedded-nanoid-5.1.16-fix', setup(builder) {
  builder.onLoad({ filter: /[\\/]node_modules[\\/]docx[\\/]dist[\\/]index\.(?:cjs|mjs)$/ }, async args => ({
    contents: patchDocxEmbeddedNanoid(await readFile(args.path), args.path.endsWith('.cjs') ? 'cjs' : 'mjs'), loader: 'js',
  }));
} };
