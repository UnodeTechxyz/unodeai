import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
  it('has no production path construction from a home directory, CODEX_HOME, auth.json, or config.toml', () => {
    const findings: string[] = [];
    for (const file of productionSources(path.resolve(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const relativeFile = path.relative(process.cwd(), file).split(path.sep).join('/');
      const visit = (node: ts.Node): void => {
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
  });
});
