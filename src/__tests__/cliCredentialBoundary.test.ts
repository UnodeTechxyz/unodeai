import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { reviewedCredentialMetadata } from './cliCredentialMetadata';

// The boundary scan reads the whole source tree (about 2 s locally). On a CI runner it crossed the warm mutation
// worker's 5 s budget, so this file's baseline was not green there.
vi.setConfig({ testTimeout: 30_000 });

function productionSources(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') result.push(...productionSources(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      result.push(absolute);
    }
  }
  return result;
}

describe('CLI credential/configuration read boundary', () => {
  const backendFile = 'src/backend/CodexBackend.ts';
  const metadataSource = readFileSync(backendFile, 'utf8');
  const metadata = (text: string, file = backendFile) => reviewedCredentialMetadata(
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file);

  it('admits the exact reviewed metadata sites only in the designated backend', () => {
    expect(metadata(metadataSource).size).toBeGreaterThan(0);
    expect(metadata(metadataSource, 'src/backend/Other.ts').size).toBe(0);
  });

  it('invalidates the metadata exception if home is read or aliased', () => {
    const publish = 'this.publishCodexControlHome(path.resolve(this.workspaceRoot, home));';
    expect(metadataSource.split(publish)).toHaveLength(2);
    for (const extra of ['readFile(home);', 'const copy = home;']) {
      expect(metadata(metadataSource.replace(publish, `${publish} ${extra}`)).size).toBe(0);
    }
  });

  it('invalidates the metadata exception if its publisher starts reading credentials', () => {
    const original = "this.controlFiles = [{ kind: 'codex-config'";
    expect(metadataSource.split(original)).toHaveLength(2);
    const changed = metadataSource.replace(original, `readFile(path.join(home, 'auth.json')); ${original}`);
    expect(metadata(changed).size).toBe(0);
  });

  it('does not admit a different home initializer or publication target', () => {
    for (const [from, to] of [
      ["environment.CODEX_HOME || path.join(", "readSecret() || path.join("],
      ['this.publishCodexControlHome(path.resolve(this.workspaceRoot, home))', 'this.publishCodexControlHome(home)'],
    ]) {
      expect(metadataSource.split(from)).toHaveLength(2);
      expect(metadata(metadataSource.replace(from, to)).size).toBe(0);
    }
  });

  it('has no unreviewed credential-path construction beyond location-only security metadata', () => {
    const findings: string[] = [];
    for (const file of productionSources(path.resolve(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const relativeFile = path.relative(process.cwd(), file).split(path.sep).join('/');
      const allowedMetadata = reviewedCredentialMetadata(source, relativeFile);
      const visit = (node: ts.Node): void => {
        if (allowedMetadata.has(node)) return;
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'homedir'
        ) {
          findings.push(`${path.relative(process.cwd(), file)}: homedir()`);
        }
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'homedir'
          && relativeFile !== 'src/security/RepositoryCliConfig.ts'
        ) {
          findings.push(`${path.relative(process.cwd(), file)}: homedir()`);
        }
        if (
          ts.isPropertyAccessExpression(node)
          && node.name.text === 'CODEX_HOME'
        ) {
          findings.push(`${path.relative(process.cwd(), file)}: CODEX_HOME`);
        }
        if (ts.isStringLiteralLike(node) && /^(?:auth\.json|config\.toml)$/i.test(node.text.trim())) {
          findings.push(`${path.relative(process.cwd(), file)}: ${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(findings).toEqual([]);
  }, 30_000); // parses every production source: 3-4 s alone, over the 5 s default under parallel load
});
