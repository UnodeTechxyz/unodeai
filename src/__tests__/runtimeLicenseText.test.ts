import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeLicenseText } from '../../scripts/runtime-license-text.mjs';

const base = path.join(process.cwd(), '.audit-repro', 'license-notice-tests');
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base || !path.basename(dir).startsWith('case-')) throw new Error('Bad fixture cleanup');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function fixture(name = 'fontkit') {
  await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-')); dirs.push(dir);
  const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'));
  const readme = readFileSync(`node_modules/${name}/${name === 'brotli' ? 'readme.md' : 'README.md'}`);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg)); await fs.writeFile(path.join(dir, 'README.md'), readme);
  return { dir, pkg, readme };
}

describe('runtime license collection without an upstream standalone LICENSE file', () => {
  it.each([
    ['MIT.txt', '508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1'],
    ['Apache-2.0.txt', '50e6751797c50dedd75ef1b8a0d9e42f5f8472e9fbce91f34718e9f97b0c780a'],
  ])('pins complete reviewed license text: %s', (file, digest) => {
    expect(createHash('sha256').update(readFileSync(`scripts/license-texts/${file}`)).digest('hex')).toBe(digest);
  });
  it('preserves a supplied license byte-for-byte instead of replacing its holder with UnodeAi', async () => {
    const h = await fixture(); const license = Buffer.from('Upstream holder\r\nExact permission notice\r\n');
    await fs.writeFile(path.join(h.dir, 'LICENSE.txt'), license);
    expect(runtimeLicenseText('fontkit', h.dir)).toEqual(license);
  });
  it.each(['fontkit', 'dfa', 'brotli'])('collects a complete, attributed, version-bound %s notice from the actual installed package', name => {
    const notice = runtimeLicenseText(name, path.join('node_modules', name)).toString('utf8');
    expect(notice).toContain('Upstream author credit: Devon Govett');
    expect(notice).toContain('Published README SHA-256:'); expect(notice).toContain('/blob/v');
    expect(notice).toContain(readFileSync('scripts/license-texts/MIT.txt', 'utf8'));
    expect(notice).not.toContain('Copyright (c) 2026 UnodeAi');
  });
  it('keeps every Google decoder/dictionary notice and the complete Apache license as well as MIT', () => {
    const notice = runtimeLicenseText('brotli', 'node_modules/brotli').toString('utf8');
    let count = 0;
    for (const file of readdirSync('node_modules/brotli/dec').filter(file => file.endsWith('.js'))) {
      const header = readFileSync(`node_modules/brotli/dec/${file}`, 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0];
      if (header?.includes('Copyright 2013 Google Inc.')) { expect(notice).toContain(header); count++; }
    }
    expect(count).toBe(7); expect(notice).toContain(readFileSync('scripts/license-texts/Apache-2.0.txt', 'utf8'));
  });
  it.each(['unknown-package', '__proto__'])('does not guess MIT for a missing license on %s', async name => {
    const h = await fixture(); expect(() => runtimeLicenseText(name, h.dir)).toThrow('no reviewed package license text');
  });
  it.each(['version', 'license', 'author', 'name', 'readme'])('requires new review if the pinned %s changes', async field => {
    const h = await fixture();
    if (field === 'readme') await fs.writeFile(path.join(h.dir, 'README.md'), h.readme + '\nChanged\n');
    else { h.pkg[field] = field === 'version' ? '2.0.5' : 'different'; await fs.writeFile(path.join(h.dir, 'package.json'), JSON.stringify(h.pkg)); }
    expect(() => runtimeLicenseText('fontkit', h.dir)).toThrow('no reviewed package license text');
  });
  it('does not omit a changed Brotli decoder notice set', async () => {
    const h = await fixture('brotli'); await fs.mkdir(path.join(h.dir, 'dec'));
    expect(() => runtimeLicenseText('brotli', h.dir)).toThrow('no reviewed package license text');
  });
  it('the packager writes the derived notice for each runtime package rather than skipping missing files', () => {
    const script = readFileSync('scripts/package-bundle.mjs', 'utf8');
    expect(script).toContain("import { runtimeLicenseText } from './runtime-license-text.mjs'");
    expect(script).toContain('writeFileSync(target, runtimeLicenseText(name, packageDir))');
    const drop = readFileSync('scripts/build-public-drop.mjs', 'utf8');
    expect(drop).toContain("'runtime-license-text.mjs'"); expect(drop).toContain("'scripts/license-texts'");
  });
});
