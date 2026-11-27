import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// These published versions omit a LICENSE file but explicitly declare MIT in their fixed README.
// This is not a generic license inference from package.json. A new version/source needs review.
const reviewed = {
  fontkit: { version: '2.0.4', readme: '8a1cf12d8ae7277f047c3000af7677927f2da9243627223ba5715d40df4979d6',
    source: 'https://github.com/foliojs/fontkit/blob/v2.0.4/README.md#license' },
  dfa: { version: '1.2.0', readme: '30bd445925aa53205ff7f9afa6a43e21358fab656e471df6e028431aefc426c7',
    source: 'https://github.com/foliojs/dfa/blob/v1.2.0/README.md#license' },
  brotli: { version: '1.3.3', readme: '8a8bac543fccf52a64708ff3315ca2be90e3e4c270634df1e4e4b51f0ee9c5d7',
    source: 'https://github.com/foliojs/brotli.js/blob/v1.3.3/readme.md#license' },
};

/** Return exact upstream LICENSE bytes normally; use a reviewed, version-bound supplement only for
 * pinned archives that omit that file. Never skip a runtime dependency or silently treat unknown as MIT. */
export function runtimeLicenseText(name, packageDir) {
  if (name === 'docx') {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const pin = JSON.parse(readFileSync(new URL('./license-texts/docx-9.7.1-embedded.json', import.meta.url), 'utf8'));
    const embedded = readFileSync(new URL('./license-texts/docx-9.7.1-embedded.txt', import.meta.url));
    if (pkg.version !== '9.7.1' || pkg.name !== 'docx' || pkg.license !== 'MIT'
      || createHash('sha256').update(readFileSync(join(packageDir, 'dist/index.cjs'))).digest('hex') !== pin.original_cjs_sha256
      || createHash('sha256').update(readFileSync(join(packageDir, 'dist/index.mjs'))).digest('hex') !== pin.original_mjs_sha256
      || createHash('sha256').update(embedded).digest('hex') !== pin.aggregate_sha256) throw Error('Unreviewed docx runtime notices');
    return Buffer.concat([readFileSync(join(packageDir, 'LICENSE')), Buffer.from('\n\n'), embedded]);
  }
  const files = readdirSync(packageDir).sort();
  const license = files.find(file => /^licen[sc]e(?:\.|$)/i.test(file));
  if (license) return readFileSync(join(packageDir, license));
  // This fixed archive omitted LICENSE; preserve its exact upstream file, including inherited notices.
  if (name === 'saxes') {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const source = readFileSync(join(packageDir, 'saxes.js'));
    const text = readFileSync(new URL('./license-texts/saxes-6.0.0.txt', import.meta.url));
    if (pkg.name !== 'saxes' || pkg.version !== '6.0.0' || pkg.license !== 'ISC'
      || createHash('sha256').update(source).digest('hex') !== 'd00e2ba27ed7d6ac961d03ff14d6b8c0eb5bf063ed2c996c22c6df06ac121423'
      || createHash('sha256').update(text).digest('hex') !== '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e') {
      throw new Error('Bundled runtime dependency saxes has no reviewed package license text.');
    }
    return Buffer.concat([Buffer.from('saxes 6.0.0 upstream LICENSE source: https://github.com/lddubeau/saxes/blob/211fa0ebec9b628affc09219199639887174bfc3/LICENSE\nComplete original license follows:\n\n'), text]);
  }
  // This archive carries its complete MIT notice in README rather than a separate LICENSE file.
  if (name === 'isarray') {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const readme = readFileSync(join(packageDir, 'README.md'));
    if (pkg.name !== 'isarray' || pkg.version !== '1.0.0' || pkg.license !== 'MIT'
      || createHash('sha256').update(readme).digest('hex') !== 'ff138e683771b187f3629c383db72ee7d632009010a36d08e18e8d2a34222ec7') {
      throw new Error('Bundled runtime dependency isarray has no reviewed package license text.');
    }
    return Buffer.from(readme.toString('utf8').split('## License\n')[1].trimStart(), 'utf8');
  }
  const pin = Object.hasOwn(reviewed, name) ? reviewed[name] : undefined;
  const missing = () => new Error(`Bundled runtime dependency ${name} has no reviewed package license text.`);
  if (!pin) throw missing();
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const readmeFile = files.find(file => /^readme\.md$/i.test(file));
  if (!readmeFile || pkg.name !== name || pkg.version !== pin.version || pkg.license !== 'MIT'
    || pkg.author !== 'Devon Govett <devongovett@gmail.com>') throw missing();
  const readme = readFileSync(join(packageDir, readmeFile));
  if (createHash('sha256').update(readme).digest('hex') !== pin.readme
    || !/## License\s+MIT\s*$/.test(readme.toString('utf8'))) throw missing();
  const parts = [
    `${name}@${pkg.version}`, `Upstream author credit: ${pkg.author}`, `Upstream license declaration: ${pin.source}`,
    `Published README SHA-256: ${pin.readme}`,
    'The published package declares MIT but supplies no standalone license/copyright-year file. No copyright year is invented here.',
    'The standard MIT permission and warranty text follows; this supplement does not relicense upstream work.',
    readFileSync(new URL('./license-texts/MIT.txt', import.meta.url), 'utf8'),
  ];
  if (name === 'brotli') {
    // The decoder/dictionary actually bundled by fontkit carries Google Apache-2.0 source notices too.
    const notices = readdirSync(join(packageDir, 'dec')).sort().filter(file => file.endsWith('.js')).flatMap(file => {
      const header = readFileSync(join(packageDir, 'dec', file), 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0];
      return header?.includes('Copyright 2013 Google Inc.') && header.includes('Apache License, Version 2.0')
        ? [`Upstream source notice: dec/${file}\n${header}`] : [];
    });
    if (notices.length !== 7) throw missing();
    parts.push(...notices, 'Complete Apache-2.0 license (https://www.apache.org/licenses/LICENSE-2.0.txt):',
      readFileSync(new URL('./license-texts/Apache-2.0.txt', import.meta.url), 'utf8'));
  }
  return Buffer.from(parts.join('\n\n') + '\n', 'utf8');
}
