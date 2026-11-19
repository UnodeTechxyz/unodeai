/**
 * The extension's actual wiring, run in a test: a property of the object literal `src/extension.ts` passes to its one
 * construction of a class, transpiled from the source and evaluated over the names the test supplies. A test that
 * runs it exercises what the extension runs, not a copy written beside it.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);

function transpiled(expression: string): string {
  return ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

/** The transpiled initializer of `property` in argument `index` of the extension's one `new <className>(...)`. */
export function extensionWiring(className: string, index: number, property: string): string {
  const constructions: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === className) constructions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (constructions.length !== 1) throw new Error(`extension.ts constructs ${className} ${constructions.length} times`);
  const literal = constructions[0].arguments?.[index];
  if (!literal || !ts.isObjectLiteralExpression(literal)) throw new Error(`argument ${index} of new ${className} is not an object literal`);
  const found = literal.properties.filter((candidate) => candidate.name?.getText(source) === property);
  if (found.length !== 1) throw new Error(`new ${className} has ${found.length} ${property} properties`);
  const [entry] = found;
  if (ts.isPropertyAssignment(entry)) return transpiled(entry.initializer.getText(source));
  if (ts.isShorthandPropertyAssignment(entry)) return transpiled(entry.name.getText(source));
  if (ts.isMethodDeclaration(entry)) return transpiled(`function ${entry.getText(source)}`);
  throw new Error(`${property} of new ${className} is not a plain property`);
}

/** The value of a top-level `const <name> = <literal>` of the extension. */
export function extensionConstant(name: string): unknown {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(source) === name && declaration.initializer) {
        return new Function(transpiled(declaration.initializer.getText(source)))();
      }
    }
  }
  throw new Error(`extension.ts has no top-level ${name}`);
}

/** Runs transpiled wiring with `scope` as the names it reads. */
export function evaluateWiring<T>(wiring: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  return new Function(...names, wiring)(...names.map((name) => scope[name])) as T;
}
