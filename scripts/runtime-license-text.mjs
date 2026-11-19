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
 * three archives that omit that file. Never skip a runtime dependency or silently treat unknown as MIT. */
export function runtimeLicenseText(name, packageDir) {
  const files = readdirSync(packageDir).sort();
  const license = files.find(file => /^licen[sc]e(?:\.|$)/i.test(file));
  if (license) return readFileSync(join(packageDir, license));
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
