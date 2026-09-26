import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = process.cwd();
const FIXTURE_MODE = process.env.UNODE_MODAL_GATE_FIXTURE === '1';
const SOURCE_ROOT = process.env.UNODE_MODAL_GATE_SOURCE_ROOT
  ? resolve(process.env.UNODE_MODAL_GATE_SOURCE_ROOT)
  : join(ROOT, 'src');

const REQUIRED_SAFE_DEFAULTS = [
  ['Apply the full execution-hook', 'Do not apply'],
  ["this agent's prompt", 'Do not allow'],
  ['let agents read and search', 'Deny'],
  ['about to upload', 'Do not allow'],
  ['coordinator-authored brief', 'Do not send'],
  ['This replaces your current', 'Keep current team'],
  ['Start a new team with', 'Keep current team'],
  ['agents are blocked from running shell commands', 'Keep Disabled'],
  ['wants to run a command', 'Deny'],
  ['wants to ${verb}', 'Deny'],
  ['wants to access the public web', 'Deny'],
  ['wants to use Claude', 'Deny'],
  ['can access resources beyond the file sandbox', 'Skip'],
];

const SAFE_DEFAULT_LABELS = new Set([
  'Deny',
  'Do not allow',
  'Do not apply',
  'Do not migrate',
  'Do not send',
  'Keep Disabled',
  'Keep Existing',
  'Keep approval',
  'Keep attestation',
  'Keep chat',
  'Keep current chat',
  'Keep current endpoint',
  'Keep current feed',
  'Keep current file',
  'Keep current instructions',
  'Keep current settings',
  'Keep current team',
  'Keep current workspace',
  'Keep gateway',
  'Keep key',
  'Keep messages',
  'Keep saved team',
  'Keep untrusted',
  'Load read-only',
  'Not now',
  'Continue without project automation',
  'Skip',
  'Stay on current team',
]);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function fail(message) {
  console.error(`modal safety check failed: ${message}`);
  process.exitCode = 1;
}

const observed = new Set();
let modalCount = 0;
let multiSelectQuickPickCount = 0;
for (const file of files(SOURCE_ROOT)) {
  const sourceText = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const constants = new Map();
  const declarations = new Map();
  const indexConstants = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
      if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
        constants.set(node.name.text, node.initializer.text);
      }
    }
    ts.forEachChild(node, indexConstants);
  };
  indexConstants(source);
  const unwrap = (node) => {
    while (node && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression?.(node))) node = node.expression;
    if (node && ts.isIdentifier(node) && declarations.has(node.text)) return unwrap(declarations.get(node.text));
    return node;
  };
  const value = (node) => {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isObjectLiteralExpression(node)) {
      const title = node.properties.find((property) => ts.isPropertyAssignment(property)
        && (property.name.getText(source) === 'title' || property.name.getText(source) === 'label'));
      return title && ts.isPropertyAssignment(title) ? value(title.initializer) : undefined;
    }
    return undefined;
  };
  const property = (node, name) => {
    node = unwrap(node);
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
    for (const item of node.properties) {
      if (ts.isPropertyAssignment(item) && item.name.getText(source).replace(/["']/g, '') === name) return unwrap(item.initializer);
      if (ts.isSpreadAssignment(item)) {
        const nested = property(item.expression, name);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  const booleanProperty = (node, name) => property(node, name)?.kind === ts.SyntaxKind.TrueKeyword;
  const callName = (expression) => {
    expression = unwrap(expression);
    if (!expression) return undefined;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression)) return value(expression.argumentExpression);
    return undefined;
  };
  const actionLabels = (nodes) => nodes.flatMap((argument) => {
    const expanded = unwrap(ts.isSpreadElement(argument) ? argument.expression : argument);
    if (ts.isArrayLiteralExpression(expanded)) return actionLabels([...expanded.elements]);
    if (ts.isConditionalExpression(expanded)) {
      return [...actionLabels([expanded.whenTrue]), ...actionLabels([expanded.whenFalse])];
    }
    return [value(expanded)];
  });
  const resultBinding = (call) => {
    let current = call;
    while (current.parent && !ts.isFunctionLike(current.parent)) {
      current = current.parent;
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(current.left)) return current.left.text;
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
          && current.expression.name.text === 'then') {
        const callback = current.arguments[0];
        if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
            && callback.parameters.length > 0 && ts.isIdentifier(callback.parameters[0].name)) {
          return callback.parameters[0].name.text;
        }
      }
    }
    return undefined;
  };
  const explicitlyChecksAction = (call, labels) => {
    const binding = resultBinding(call);
    if (!binding) return false;
    const isBinding = (candidate) => {
      while (candidate && (ts.isAsExpression(candidate) || ts.isTypeAssertionExpression(candidate)
        || ts.isParenthesizedExpression(candidate) || ts.isAwaitExpression(candidate)
        || ts.isSatisfiesExpression?.(candidate))) candidate = candidate.expression;
      return ts.isIdentifier(candidate) && candidate.text === binding;
    };
    const comparisons = (expression) => {
      expression = unwrap(expression);
      if (!expression || !ts.isBinaryExpression(expression)) return [];
      if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        return [...comparisons(expression.left), ...comparisons(expression.right)];
      }
      const operator = expression.operatorToken.kind;
      const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
      const notEqual = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
      if (!equal && !notEqual) return [];
      const label = isBinding(expression.left) ? value(expression.right)
        : isBinding(expression.right) ? value(expression.left)
        : undefined;
      return label && labels.has(label) ? [{ label, equal }] : [];
    };
    const directExit = (statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
      || (ts.isBlock(statement) && statement.statements.length > 0
        && (ts.isReturnStatement(statement.statements.at(-1)) || ts.isThrowStatement(statement.statements.at(-1))));
    const matchesEveryLabel = (matches, equal) => matches.length > 0
      && matches.every((match) => match.equal === equal)
      && new Set(matches.map((match) => match.label)).size === labels.size;
    const returnDecoder = (statements) => {
      if (statements.length < 2 || !directExit(statements.at(-1))) return false;
      return statements.slice(0, -1).every((statement) => {
        if (!ts.isIfStatement(statement) || !directExit(statement.thenStatement) || statement.elseStatement) return false;
        const matches = comparisons(statement.expression);
        return matches.length > 0 && matches.every((match) => match.equal);
      });
    };
    const safeDecision = (statement, followers) => {
      if (ts.isIfStatement(statement)) {
        const matches = comparisons(statement.expression);
        if (matchesEveryLabel(matches, false) && directExit(statement.thenStatement)) return true;
        if (matchesEveryLabel(matches, true)
            && followers.every((item) => ts.isReturnStatement(item) || ts.isThrowStatement(item))) return true;
      }
      if (ts.isSwitchStatement(statement) && isBinding(statement.expression)) {
        const cases = statement.caseBlock.clauses
          .filter((clause) => ts.isCaseClause(clause))
          .map((clause) => value(clause.expression));
        return cases.length > 0 && cases.every((label) => !!label && labels.has(label))
          && followers.every((item) => ts.isReturnStatement(item) || ts.isThrowStatement(item));
      }
      if (ts.isReturnStatement(statement) && statement.expression) {
        const expression = unwrap(statement.expression);
        const condition = expression && ts.isConditionalExpression(expression) ? expression.condition : expression;
        return matchesEveryLabel(comparisons(condition), true);
      }
      return false;
    };
    let statement = call;
    while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
    const parent = statement.parent;
    if (!ts.isStatement(statement) || (!ts.isBlock(parent) && !ts.isSourceFile(parent))) return false;
    const statements = [...parent.statements];
    const index = statements.indexOf(statement);
    const following = statements.slice(index + 1);
    const firstDecision = following.find((candidate) => candidate.getText(source).includes(binding));
    if (!firstDecision) return false;
    const decisionIndex = following.indexOf(firstDecision);
    const decisionSequence = following.slice(decisionIndex);
    return safeDecision(firstDecision, decisionSequence.slice(1)) || returnDecoder(decisionSequence);
  };
  const visit = (node) => {
    const name = ts.isCallExpression(node) ? callName(node.expression) : undefined;
    if (ts.isCallExpression(node) && /^show(?:Information|Warning|Error)Message$/.test(name ?? '')) {
      const options = node.arguments[1];
      const isModal = booleanProperty(options, 'modal');
      if (isModal) {
        modalCount++;
        const labels = actionLabels([...node.arguments.slice(2)]);
        if (labels.some((label) => label === undefined)) {
          fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} `
            + 'contains an action label the gate cannot resolve to a string literal.');
        }
        const prompt = node.arguments[0]?.getText(source) ?? '';
        // The save-scope modal is a user-initiated two-way choice of where to write; both buttons are the
        // user's own destination, so neither is a consent default. VS Code still supplies its single Cancel.
        const saveScopeChoice = prompt.includes('Where should this team be saved?')
          && labels.length === 2
          && labels[0] === 'Save to This project'
          && labels[1] === 'Save to All projects';
        if (labels.includes('Cancel')) {
          fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} supplies a second Cancel button.`);
        }
        // VS Code supplies the modal Cancel affordance. Full access deliberately has one named action,
        // so the visible buttons stay exactly "Enable full access" / "Cancel" without adding a second
        // synthetic Cancel. Escape/close are still checked below as non-affirmative results.
        const nativeCancelFullAccess = prompt.includes('Enable Full access (unsafe)')
          && labels.length === 1 && labels[0] === 'Enable full access';
        if (labels.length > 0 && !SAFE_DEFAULT_LABELS.has(labels[0]) && !nativeCancelFullAccess && !saveScopeChoice) {
          fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} `
            + `must put a registered non-consent action first; found "${labels[0] ?? 'unresolved'}".`);
        }
        const affirmativeLabels = new Set(labels.filter((label) => label && label !== 'Cancel' && !SAFE_DEFAULT_LABELS.has(label)));
        if (affirmativeLabels.size > 0 && !explicitlyChecksAction(node, affirmativeLabels)) {
          fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} `
            + 'must gate its effect on an explicit affirmative result; Escape/undefined must follow the non-consent path.');
        }
        for (const [fragment, safeDefault] of REQUIRED_SAFE_DEFAULTS) {
          if (!prompt.includes(fragment)) continue;
          observed.add(fragment);
          if (labels[0] !== safeDefault) {
            fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} must put "${safeDefault}" first; found "${labels[0] ?? 'no action'}".`);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && name === 'showQuickPick' && booleanProperty(node.arguments[1], 'canPickMany')) {
      multiSelectQuickPickCount++;
      const title = value(property(node.arguments[1], 'title'));
      const enclosing = node.parent?.getFullText(source) ?? node.getFullText(source);
      if (title === 'Allow model metadata requests?') {
        observed.add(title);
        const fn = findContainingFunction(node)?.getFullText(source) ?? enclosing;
        if (!/picked\s*:\s*false/.test(fn) || /picked\s*:\s*true/.test(fn)) {
          fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} metadata consent must start with every host unselected.`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function findContainingFunction(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

for (const [fragment] of REQUIRED_SAFE_DEFAULTS) {
  if (!observed.has(fragment)) fail(`required guarded modal "${fragment}" is missing.`);
}
if (!FIXTURE_MODE) {
  if (!observed.has('Allow model metadata requests?')) fail('metadata-consent QuickPick is missing from the safety audit.');
  if (modalCount < 36) fail(`only ${modalCount} action modals were audited; expected at least 36.`);
  if (multiSelectQuickPickCount < 1) fail('no multi-select QuickPick was audited.');
}

if (!FIXTURE_MODE && process.exitCode !== 1) {
  const sandbox = mkdtempSync(join(tmpdir(), 'unode-modal-gate-'));
  try {
    const plants = [
      {
        name: 'unresolved action label',
        source: `async function unresolved(dynamicLabel) {
          const choice = await vscode.window.showWarningMessage('Apply it?', { modal: true }, 'Not now', dynamicLabel);
          if (choice !== dynamicLabel) return;
          await applyEffect();
        }`,
        expected: 'cannot resolve to a string literal',
      },
      {
        name: 'non-dominating comparison',
        source: `async function nonDominating() {
          const choice = await vscode.window.showWarningMessage('Apply it?', { modal: true }, 'Not now', 'Apply');
          if (choice === 'Apply') observeChoice();
          await applyEffect();
        }`,
        expected: 'must gate its effect on an explicit affirmative result',
      },
    ];
    for (const [index, plant] of plants.entries()) {
      const directory = join(sandbox, String(index));
      const file = join(directory, 'fixture.ts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, plant.source);
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, UNODE_MODAL_GATE_FIXTURE: '1', UNODE_MODAL_GATE_SOURCE_ROOT: directory },
      });
      if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes(plant.expected)) {
        fail(`planted ${plant.name} defect survived.`);
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (!FIXTURE_MODE && process.exitCode !== 1) {
  console.log(`modal safety check passed (${modalCount} action modals default to a registered non-consent outcome; `
    + `the first result-dependent branch must dominate continuation; unresolved action labels fail; `
    + `${multiSelectQuickPickCount} multi-select QuickPick starts unselected; ${REQUIRED_SAFE_DEFAULTS.length} release-critical decisions present; `
    + `no duplicate Cancel actions; 2 planted failures killed).`);
}
