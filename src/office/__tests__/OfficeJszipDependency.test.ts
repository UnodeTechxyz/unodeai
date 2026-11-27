import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Office code imports JSZip directly, so the manifest must declare it at the locked version rather than rely on
// another package's range pulling it in.
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
  return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
});

describe('JSZip direct dependency declaration', () => {
  it('declares the locked 3.10.1 for the shipped source files that import it', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const installed = JSON.parse(readFileSync(path.join('node_modules', 'jszip', 'package.json'), 'utf8'));
    expect(pkg.dependencies.jszip).toBe('3.10.1');
    expect(pkg.devDependencies?.jszip).toBeUndefined();
    expect(lock.packages[''].dependencies.jszip).toBe('3.10.1');
    expect(lock.packages['node_modules/jszip'].version).toBe('3.10.1');
    expect(lock.packages['node_modules/jszip'].dev).toBeUndefined();
    expect(lock.packages['node_modules/jszip'].integrity).toBe('sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==');
    expect(installed.version).toBe('3.10.1');
    const importers = sourceFiles('src').filter(file => /from 'jszip'|require\('jszip'\)/.test(readFileSync(file, 'utf8')))
      .map(file => path.relative('src', file).split(path.sep).join('/'));
    expect(importers).toEqual(expect.arrayContaining(['office/OfficeEdits.ts', 'office/OfficeChartSheet.ts',
      'office/OfficeRenderCopy.ts', 'content/document/DocumentDataCheck.ts']));
  });

  it('third-party notices name JSZip and the license option used', () => {
    const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
    expect(notices).toMatch(/JSZip 3\.10\.1,\s+used under the MIT option/);
  });
});
