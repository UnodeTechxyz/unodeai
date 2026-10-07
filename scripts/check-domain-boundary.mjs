#!/usr/bin/env node
/**
 * Keep the first pure-service seam honest.
 *
 * These directories make route, capability, parameter and metadata decisions.  They must not import the
 * VS Code host namespace: the host supplies values and side effects through narrow ports instead.  This is
 * intentionally a small ratchet, not a claim that all core extraction is complete (Milestone B owns that).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DOMAIN_DIRS = ['src/models', 'src/routes', 'src/capabilities', 'src/params'];
const VSCODE_IMPORT = /(?:from\s+['"]vscode['"]|import\s+\*\s+as\s+vscode)/;

function walk(dir, into = []) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) { walk(file, into); }
    else if (file.endsWith('.ts') && !file.split(/[\\/]/).includes('__tests__')) { into.push(file); }
  }
  return into;
}

export function domainBoundaryViolations(files) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (VSCODE_IMPORT.test(text)) {
      violations.push(relative(ROOT, file).replaceAll('\\', '/'));
    }
  }
  return violations;
}

function selfTest() {
  if (!VSCODE_IMPORT.test("import * as vscode from 'vscode';")) {
    throw new Error('domain boundary self-test failed: namespace import escaped');
  }
  if (!VSCODE_IMPORT.test("import { Uri } from 'vscode';")) {
    throw new Error('domain boundary self-test failed: named import escaped');
  }
  if (VSCODE_IMPORT.test('// vscode-free by design')) {
    throw new Error('domain boundary self-test failed: comment was treated as an import');
  }
}

selfTest();
const violations = domainBoundaryViolations(DOMAIN_DIRS.flatMap((dir) => walk(join(ROOT, dir))));
if (violations.length > 0) {
  throw new Error(
    `check:domain-boundary failed; domain code must use a host port, not VS Code:\n- ${violations.join('\n- ')}`,
  );
}
console.log(`check:domain-boundary passed (${DOMAIN_DIRS.join(', ')} contain no VS Code imports).`);
