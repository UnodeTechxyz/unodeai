import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = resolve(root, 'src/content/document/testdata/ucd17');
const output = resolve(root, 'src/content/document/DocumentUnicodeData.ts');
const manifestPath = resolve(dir, 'manifest.json');
const files = ['UnicodeData.txt', 'Scripts.txt', 'ScriptExtensions.txt', 'DerivedCoreProperties.txt', 'GraphemeBreakProperty.txt', 'LICENSE.txt'];
const sourceUrl = name => name === 'LICENSE.txt' ? 'https://www.unicode.org/license.txt'
  : `https://www.unicode.org/Public/17.0.0/ucd/${name === 'GraphemeBreakProperty.txt' ? 'auxiliary/' : ''}${name}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const flag = { letter: 1, mark: 2, format: 4, ignorable: 8, Latin: 16, Han: 32, Hiragana: 64,
  Katakana: 128, latinScx: 256, kanaScx: 512, Inherited: 1024, extend: 2048 };
const diagnostics = ['Arabic', 'Hebrew', 'Myanmar', 'Sinhala', 'Syriac', 'Thaana', 'Greek', 'Cyrillic', 'Devanagari', 'Thai', 'Khmer'];

function lines(text) {
  return text.split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean);
}
function range(text) {
  const [a, b] = text.trim().split('..').map(value => parseInt(value, 16));
  if (!Number.isInteger(a) || a < 0 || (b ?? a) > 0x10ffff || (b ?? a) < a) throw new Error('Invalid UCD range');
  return [a, b ?? a];
}

export function generateDocumentUnicode() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== '17.0.0' || manifest.generatorRevision !== 1 || manifest.files.length !== files.length) throw new Error('UCD manifest mismatch');
  const inputs = new Map(files.map(name => {
    const bytes = readFileSync(resolve(dir, name));
    const pinned = manifest.files.find(file => file.name === name);
    if (!pinned || pinned.url !== sourceUrl(name) || pinned.sha256 !== sha(bytes) || pinned.bytes !== bytes.length) throw new Error(`UCD pinned source changed: ${name}`);
    return [name, bytes.toString('utf8')];
  }));
  const flags = new Uint32Array(0x110000);
  let first;
  for (const line of lines(inputs.get('UnicodeData.txt'))) {
    const fields = line.split(';'); const cp = parseInt(fields[0], 16);
    const bits = fields[2][0] === 'L' ? flag.letter : fields[2][0] === 'M' ? flag.mark : fields[2] === 'Cf' ? flag.format : 0;
    if (fields[1].endsWith(', First>')) { first = cp; continue; }
    if (fields[1].endsWith(', Last>')) { flags.fill(bits, first, cp + 1); first = undefined; }
    else flags[cp] |= bits;
  }
  const each = (name, apply) => { for (const line of lines(inputs.get(name))) {
    const fields = line.split(';').map(field => field.trim()); const [a, b] = range(fields[0]);
    apply(a, b, fields[1]);
  } };
  each('Scripts.txt', (a, b, script) => {
    const bits = (flag[script] ?? 0) | ((diagnostics.indexOf(script) + 1) << 12);
    for (let cp = a; cp <= b; cp++) flags[cp] |= bits;
  });
  each('ScriptExtensions.txt', (a, b, scripts) => {
    const parts = scripts.split(/\s+/); const bits = (parts.includes('Latn') ? flag.latinScx : 0)
      | (parts.includes('Hira') || parts.includes('Kana') ? flag.kanaScx : 0);
    for (let cp = a; cp <= b; cp++) flags[cp] |= bits;
  });
  each('DerivedCoreProperties.txt', (a, b, prop) => {
    if (prop === 'Default_Ignorable_Code_Point') for (let cp = a; cp <= b; cp++) flags[cp] |= flag.ignorable;
  });
  each('GraphemeBreakProperty.txt', (a, b, prop) => {
    if (prop === 'Extend') for (let cp = a; cp <= b; cp++) flags[cp] |= flag.extend;
  });
  const ranges = [];
  for (let start = 0; start < flags.length;) {
    let end = start; while (end + 1 < flags.length && flags[end + 1] === flags[start]) end++;
    if (flags[start]) ranges.push([start, end, flags[start]]);
    start = end + 1;
  }
  const data = JSON.stringify(ranges);
  const digest = sha(JSON.stringify(manifest) + '\0' + data);
  return '// Generated from pinned UCD 17.0.0 by scripts/generate-document-unicode.mjs. Unicode License v3.\n'
    + `export const DOCUMENT_UNICODE_DIGEST = '${digest}';\n`
    + `export const DOCUMENT_UNICODE_FLAGS = ${JSON.stringify(flag)} as const;\n`
    + `export const DOCUMENT_UNICODE_DIAGNOSTICS = ${JSON.stringify(diagnostics)} as const;\n`
    + `export const DOCUMENT_UNICODE_RANGES: readonly (readonly [number, number, number])[] = ${data};\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--bootstrap')) {
    if (existsSync(manifestPath)) throw new Error('Refusing to replace an existing pinned UCD manifest');
    writeFileSync(manifestPath, JSON.stringify({ version: '17.0.0', generatorRevision: 1, license: 'Unicode License v3',
      files: files.map(name => { const bytes = readFileSync(resolve(dir, name)); return { name, url: sourceUrl(name), bytes: bytes.length, sha256: sha(bytes) }; }) }, null, 2) + '\n');
  }
  const source = generateDocumentUnicode();
  if (process.argv.includes('--write')) writeFileSync(output, source);
  else if (readFileSync(output, 'utf8') !== source) throw new Error('Generated document Unicode table differs');
  console.log(`Document UCD 17.0.0 verified (${Buffer.byteLength(source)} generated bytes).`);
}
