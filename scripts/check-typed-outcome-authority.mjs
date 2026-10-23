import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// v0.9.91: a tool result's outcome comes only from a typed host decision or a typed provider signal. This gate reads
// the TypeScript syntax tree of every production source file, so a comment, a string or a different spelling cannot
// hide a text classifier from it, and it keeps the turn outcome receipt from reading tool prose.
//
// It is a regression check, not a proof. It folds string constants: literals, `const` bindings in the same file,
// named imports of exported `const` strings from project files, concatenation of those, and the fixed prefix of a
// template. A marker reached any other way (an object property, a function's return value, a value computed at run
// time) is outside what it reads. The typed contracts, their tests and review carry that part.

const root = process.cwd();

/**
 * Text tests for an "Error" marker that are not a tool outcome, each scoped to one expression in one function. A
 * new test of that kind anywhere else, even in the same file or function, fails the gate until it is listed with its
 * own reason, and an entry that no longer matches its expression fails too.
 */
export const ERROR_MARKER_EXCEPTIONS = [
  {
    file: 'src/extension.ts',
    within: 'fetchMentionUrl',
    expression: "text.startsWith('Error:')",
    reason: 'An @url mention is attached only when the fetch did not return an error text; it is not a tool outcome.',
  },
];

/** The receipt's accumulator: it may read a call id and a typed fact, never presentation text. */
const ACCUMULATOR = 'src/session/turnOutcomeReceipt.ts';
const SESSION = 'src/session/SessionManager.ts';
const PROSE = new Set(['summary', 'detail', 'diff', 'output', 'text']);
/** Methods that test or search text, so a marker passed to one of them is a classifier. */
const TEXT_TESTS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search', 'test', 'exec', 'localeCompare']);
/**
 * What an outcome text marker looks like. In a regular expression: "error" anchored at the start, in any letter case,
 * before a colon or a word boundary, or "error:" anywhere. In a string tested against text: "error:" in any letter
 * case, or a capitalised "Error" prefix. A bare lowercase 'error' is how typed enums spell a state, not a marker.
 */
const REGEX_MARKER = /^\^\s*(?:\(\?:)?\s*error(?:\s*:|\\b|\b)|error\s*:/i;
const STRING_MARKER = /^\s*\^?\s*error\s*:|^\s*\^?\s*Error\b/i;
const CAPITALISED_PREFIX = /^\s*\^?\s*Error\b/;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(file);
    return entry.isFile() && file.endsWith('.ts') && !file.endsWith('.test.ts') ? [file] : [];
  });
}

function parse(text, file) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(node) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression?.(current))) {
    current = current.expression;
  }
  return current;
}

/** `const NAME = <string>` bindings anywhere in a file, by name; `exported` keeps only the module's exports. */
function constantBindings(sourceFile, exportedOnly = false) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const)) {
      const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
      if (!exportedOnly || exported) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/** Named imports from project files, as local name to the exporting file and its exported name. */
function namedImports(sourceFile, file) {
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const base = resolve(root, dirname(file), specifier);
    const target = [`${base}.ts`, resolve(base, 'index.ts')].find((candidate) => existsSync(candidate));
    const bindings = statement.importClause?.namedBindings;
    if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imports.set(element.name.text, { file: relative(root, target).split(sep).join('/'), name: (element.propertyName ?? element.name).text });
    }
  }
  return imports;
}

/**
 * The string an expression always evaluates to, when its parts are fixed text: literals, `const` bindings, imported
 * exported constants, `+` of those, and a template's text up to its first substitution (a prefix, flagged as one).
 */
function constantText(node, context, seen = new Set()) {
  const expression = unwrap(node);
  if (!expression) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) return expression.head.text || undefined;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(expression.left, context, seen);
    const right = constantText(expression.right, context, seen);
    return left !== undefined && right !== undefined ? left + right : left;
  }
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const nextSeen = new Set(seen).add(expression.text);
    const local = context.locals.get(expression.text);
    if (local) return constantText(local, context, nextSeen);
    const imported = context.imports.get(expression.text);
    const exported = imported ? context.exportedConstants.get(imported.file)?.get(imported.name) : undefined;
    if (exported) return constantText(exported.node, { ...exported.context, exportedConstants: context.exportedConstants }, nextSeen);
  }
  return undefined;
}

/** A value that, tested against text, reads as an outcome marker. */
function isMarkerString(node, context) {
  const text = constantText(node, context);
  if (text === undefined) return false;
  return /error\s*:/i.test(text) ? STRING_MARKER.test(text) : CAPITALISED_PREFIX.test(text);
}

/** A value passed to RegExp, read as the regular expression it builds. */
function isMarkerPattern(node, context) {
  const text = constantText(node, context);
  return text !== undefined && REGEX_MARKER.test(text);
}

function regexSource(node) {
  const text = node.getText();
  return text.slice(1, text.lastIndexOf('/'));
}

/** The name of the function, method or variable-bound function a node sits in; '<module>' at the top level. */
function enclosingName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.getText();
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))) {
      const holder = current.parent;
      if (holder && (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) && holder.name) {
        return holder.name.getText();
      }
    }
  }
  return '<module>';
}

/** Every place a source tests text for an "Error" marker, as the expression that does the test. */
export function errorMarkerSites(sourceFile, context) {
  const sites = [];
  const add = (node) => sites.push({ node, within: enclosingName(node), expression: node.getText().replace(/\s+/g, ' ') });
  const visit = (node) => {
    if (ts.isRegularExpressionLiteral(node) && REGEX_MARKER.test(regexSource(node))) {
      // `/^Error:/.test(x)` reads as the call; a regex held elsewhere reads as itself.
      const call = node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.parent && ts.isCallExpression(node.parent.parent)
        ? node.parent.parent
        : node;
      add(call);
    } else if ((ts.isNewExpression(node) || ts.isCallExpression(node))
        && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp'
        && node.arguments?.length && isMarkerPattern(node.arguments[0], context)) {
      add(node);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && TEXT_TESTS.has(node.expression.name.text) && node.arguments.some((argument) => isMarkerString(argument, context))) {
      add(node);
    } else if (ts.isBinaryExpression(node)
        && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)
        && (isMarkerString(node.left, context) || isMarkerString(node.right, context))) {
      add(node);
    } else if (ts.isCaseClause(node) && isMarkerString(node.expression, context)) {
      add(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Identifier and property names a node reads, so a renamed local cannot carry prose past the check. */
function namesIn(node) {
  const names = [];
  const visit = (current) => {
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) names.push(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/** Exported string constants of every given file, so an imported marker resolves to its text. */
export function exportedConstantsOf(files) {
  const all = new Map();
  for (const [file, text] of files) {
    const source = parse(text, file);
    const context = { locals: constantBindings(source), imports: namedImports(source, file) };
    const exports = new Map();
    for (const [name, node] of constantBindings(source, true)) exports.set(name, { node, context });
    all.set(file, exports);
  }
  return all;
}

export function typedOutcomeAuthorityViolations(text, file, options = {}) {
  const exceptions = options.exceptions ?? ERROR_MARKER_EXCEPTIONS;
  const source = parse(text, file);
  const context = {
    locals: constantBindings(source),
    imports: options.imports ?? namedImports(source, file),
    exportedConstants: options.exportedConstants ?? new Map(),
  };
  const violations = [];
  const used = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'classifyToolFailure') {
      violations.push(`${file}: classifyToolFailure is retired; a tool outcome comes from its typed fact, never its text`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const site of errorMarkerSites(source, context)) {
    const exception = exceptions.find((entry) =>
      entry.file === file && entry.within === site.within && entry.expression === site.expression);
    if (exception) {
      used.add(exception);
      continue;
    }
    violations.push(`${file}: ${site.within}: \`${site.expression}\` decides an outcome from an "Error" text marker; use the typed fact`);
  }
  for (const exception of exceptions) {
    if (exception.file === file && !used.has(exception)) {
      violations.push(`${file}: the exception for \`${exception.expression}\` in ${exception.within} no longer matches; remove it`);
    }
  }
  if (file === ACCUMULATOR) {
    const prose = namesIn(source).find((name) => PROSE.has(name));
    if (prose) violations.push(`${file}: the receipt accumulator reads tool prose ("${prose}")`);
  }
  if (file === SESSION) {
    const visitCalls = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText().includes('turnOutcomes')) {
        const prose = node.arguments.flatMap(namesIn).find((name) => PROSE.has(name));
        if (prose) violations.push(`${file}: a turn receipt is fed tool prose ("${prose}"): ${node.getText()}`);
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(source);
  }
  return violations;
}

function selfTest() {
  const planted = [
    ['src/backend/A.ts', "import { classifyToolFailure } from './toolSummary';"],
    ['src/backend/B.ts', 'const failed = /^Error:/.test(output);'],
    ['src/backend/C.ts', 'const failed = /^error:/i.test(output);'],
    ['src/backend/D.ts', "const failed = output.toLowerCase().startsWith('error:');"],
    ['src/backend/E.ts', "const failed = new RegExp('^Error:').test(output);"],
    ['src/backend/F.ts', "const failed = output.slice(0, 6) === 'Error:';"],
    ['src/backend/G.ts', 'const failed = output.includes(`Error:`);'],
    ['src/backend/H.ts', 'function isTaskFailure(text: string) { return /^Error\\b/i.test(text.trim()); }'],
    // A marker moved into a constant, a concatenation, a template prefix or a RegExp argument is still a marker.
    ['src/backend/J.ts', "const ERROR_PREFIX = 'Error:';\nconst failed = output.startsWith(ERROR_PREFIX);"],
    ['src/backend/K.ts', "const MARK = 'Err' + 'or:' as const;\nfunction failed(output: string) { return output.indexOf(MARK) === 0; }"],
    ['src/backend/L.ts', 'const failed = output.startsWith(`Error: ${tool}`);'],
    ['src/backend/M.ts', "const PATTERN = '^error:';\nconst failed = new RegExp(PATTERN, 'i').test(output);"],
    // In an excepted file and function, only the excepted expression passes.
    ['src/extension.ts', "async function fetchMentionUrl() { return { ok: !text.startsWith('Error:'), failed: /^Error:/.test(text) }; }"],
    ['src/extension.ts', "async function other() { return text.startsWith('Error:'); }\nasync function fetchMentionUrl() { return text.startsWith('Error:'); }"],
    [ACCUMULATOR, 'class A { result(callId: string, fact: ToolResultFact, summary: string) {} }'],
    [ACCUMULATOR, 'class A { result(callId: string, event: { detail: string }) { return event.detail; } }'],
    [SESSION, 'this.turnOutcomes.get(info.id)?.result(evt.callId, evt.outcome, evt.detail);'],
    [SESSION, 'const words = evt.summary; this.turnOutcomes.get(info.id)?.result(evt.callId, { ...evt.outcome, summary: words });'],
  ];
  for (const [file, text] of planted) {
    if (typedOutcomeAuthorityViolations(text, file).length === 0) {
      throw new Error(`check:typed-outcome-authority self-test failed: a planted violation in ${file} passed:\n${text}`);
    }
  }
  // A marker imported from another project file resolves to its text as well.
  const exporter = ['src/backend/markers.ts', "export const FAILURE_MARK = 'Error:';"];
  const importer = "import { FAILURE_MARK as MARK } from './markers';\nconst failed = output.startsWith(MARK);";
  const imported = typedOutcomeAuthorityViolations(importer, 'src/backend/N.ts', {
    imports: new Map([['MARK', { file: exporter[0], name: 'FAILURE_MARK' }]]),
    exportedConstants: exportedConstantsOf([exporter]),
  });
  if (imported.length === 0) throw new Error('check:typed-outcome-authority self-test failed: an imported marker passed');
  const stale = typedOutcomeAuthorityViolations('async function fetchMentionUrl() { return true; }', 'src/extension.ts');
  if (!stale.some((violation) => violation.includes('no longer matches'))) {
    throw new Error('check:typed-outcome-authority self-test failed: a stale exception passed');
  }
  const clean = [
    [ACCUMULATOR, '// A summary or detail never enters.\nconst label = "summary";\nclass A { result(callId: string, fact: ToolResultFact) {} }'],
    [SESSION, 'this.turnOutcomes.get(info.id)?.result(evt.callId, evt.outcome);'],
    ['src/extension.ts', "async function fetchMentionUrl() { return { ok: !text.startsWith('Error:'), text }; }"],
    ['src/backend/I.ts', "return hostToolFailed('Error: requested skill file does not exist.');\n// startsWith('Error:') in a comment"],
    ['src/backend/O.ts', "const STATE = 'error';\nif (session.status === STATE) stop();"],
  ];
  for (const [file, text] of clean) {
    const violations = typedOutcomeAuthorityViolations(text, file);
    if (violations.length > 0) {
      throw new Error(`check:typed-outcome-authority self-test failed: clean source was rejected: ${violations[0]}`);
    }
  }
  return planted.length + 2;
}

const killed = selfTest();
const files = sourceFiles(resolve(root, 'src')).map((file) => [relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8')]);
const exportedConstants = exportedConstantsOf(files);
const violations = files.flatMap(([file, text]) => typedOutcomeAuthorityViolations(text, file, { exportedConstants }));
if (violations.length) {
  throw new Error(`check:typed-outcome-authority failed:\n- ${violations.join('\n- ')}`);
}
console.log(`check:typed-outcome-authority passed (no text outcome classifier; the turn receipt reads no tool prose; ${killed} planted failures killed). A regression check over string constants, not a proof.`);
