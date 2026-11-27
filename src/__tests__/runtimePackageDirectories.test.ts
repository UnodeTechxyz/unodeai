import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runtimePackageDirectories, runtimePackageDirectory } from '../../scripts/runtime-package-directories.mjs';
import { runtimeLicenseText } from '../../scripts/runtime-license-text.mjs';
import path from 'node:path';

describe('actual runtime graph package identities', () => {
  it('collects every nested installed package and its own actual licence from a focused PPT graph', async () => {
    const graph = await build({ stdin: { contents: "import PptxGenJS from 'pptxgenjs'; globalThis.__ppt = new PptxGenJS();",
      resolveDir: process.cwd(), loader: 'js' }, bundle: true, platform: 'node', format: 'cjs', write: false,
      metafile: true, logLevel: 'silent' });
    const directories = runtimePackageDirectories(Object.keys(graph.metafile!.inputs));
    for (const name of ['readable-stream', 'safe-buffer', 'string_decoder']) {
      const key = `node_modules/jszip/node_modules/${name}`;
      expect(directories).toContain(key);
      const actual = runtimePackageDirectory(process.cwd(), key);
      expect(JSON.parse(readFileSync(path.join(actual, 'package.json'), 'utf8')).name).toBe(name);
      expect(runtimeLicenseText(name, actual).length).toBeGreaterThan(0);
    }
    for (const key of directories) {
      const dir = runtimePackageDirectory(process.cwd(), key);
      const name = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
      expect(runtimeLicenseText(name, dir).length).toBeGreaterThan(0);
    }
    expect(directories).not.toContain('node_modules/image-size');
    expect(directories).not.toContain('node_modules/https');
  });

  it('preserves scopes and relative Windows spellings, and accepts retained legacy root keys', () => {
    expect(runtimePackageDirectories(['src/index.ts', 'node_modules\\@scope\\outer\\node_modules\\@inner\\pkg\\index.js',
      'node_modules/@scope/outer/index.js'])).toEqual(['node_modules/@scope/outer', 'node_modules/@scope/outer/node_modules/@inner/pkg']);
    expect(runtimePackageDirectory(process.cwd(), '@scope/pkg')).toBe(path.resolve('node_modules/@scope/pkg'));
  });

  it.each(['../secrets', 'node_modules/a/../../secrets', '/outside', 'node_modules/a/extra'])('rejects a package manifest key outside the package root: %s', key => {
    expect(() => runtimePackageDirectory(process.cwd(), key)).toThrow();
  });

  it('keeps the build helper in the reproducible public source inputs', () => {
    expect(readFileSync('scripts/build-public-drop.mjs', 'utf8')).toContain("'runtime-package-directories.mjs'");
  });
});
