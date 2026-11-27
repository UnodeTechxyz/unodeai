import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Exact package roots from actual esbuild inputs, including separately installed nested versions. */
export function runtimePackageDirectories(inputs, root = process.cwd()) {
  const packages = new Set();
  for (const input of inputs) {
    const normalized = (isAbsolute(input) ? relative(root, input) : input).split(sep).join('/').replaceAll('\\', '/');
    const parts = normalized.split('/');
    const first = parts.indexOf('node_modules');
    if (first < 0) continue;
    if (first !== 0 || parts.some(part => part === '..' || part === '.')) throw new Error('Runtime dependency is outside root node_modules.');
    let end = 0;
    for (let index = first; index < parts.length; index++) {
      if (parts[index] !== 'node_modules') continue;
      const scoped = parts[index + 1]?.startsWith('@');
      end = index + (scoped ? 3 : 2);
      if (end > parts.length || parts.slice(index + 1, end).some(part => !part)) throw new Error('Malformed runtime package path.');
    }
    packages.add(parts.slice(0, end).join('/'));
  }
  return [...packages].sort();
}

/** This format also accepts old root-package names from retained build manifests. */
export function runtimePackageDirectory(root, key) {
  if (typeof key !== 'string') throw new Error('Invalid runtime package key.');
  const normalized = key.replaceAll('\\', '/');
  const directory = normalized.startsWith('node_modules/') ? normalized : `node_modules/${normalized}`;
  if (runtimePackageDirectories([`${directory}/package.json`], root)[0] !== directory) throw new Error('Invalid runtime package directory.');
  return resolve(root, ...directory.split('/'));
}
