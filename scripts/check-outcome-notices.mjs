import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = process.cwd();
const SOURCE_ROOT = process.env.UNODE_OUTCOME_NOTICE_SOURCE_ROOT
  ? resolve(process.env.UNODE_OUTCOME_NOTICE_SOURCE_ROOT)
  : join(ROOT, 'src');
const FIXTURE_MODE = process.env.UNODE_OUTCOME_NOTICE_FIXTURE === '1';
const REPORT = process.argv.includes('--report');

// F7-9: these are the only notices allowed to remain non-modal without actions. Each is caused by
// background/activation/file-watcher state, not by the user waiting for an answer to a click or command.
// The signature is file + API + nearest named scope + a message-source fragment. Copy changes and moved
// responsibilities therefore require an explicit reclassification without making harmless line shifts noisy.
const AMBIENT_TOASTS = [
  { file: 'src/extension.ts', api: 'showWarningMessage', scope: 'noticeIgnoredWorkspaceAuthoritySettings', messageIncludes: 'safety- or cost-sensitive project setting' },
  { file: 'src/extension.ts', api: 'showWarningMessage', scope: 'notifyVerifyCommandOutsideRoot', messageIncludes: 'message' },
  { file: 'src/extension.ts', api: 'showInformationMessage', scope: 'migrateToProviderSplit', messageIncludes: 'UnodeAi now defaults to the Unode gateway' },
  { file: 'src/extension.ts', api: 'showErrorMessage', scope: 'restoreRoster', messageIncludes: 'UnodeAi did not start this roster' },
  { file: 'src/extension.ts', api: 'showInformationMessage', scope: 'restoreRoster', messageIncludes: 'updated this roster to versioned connection routes' },
  { file: 'src/extension.ts', api: 'showErrorMessage', scope: 'showError', messageIncludes: 'message' },
  { file: 'src/extension.ts', api: 'showInformationMessage', scope: 'wireEvents', messageIncludes: 'queued — it will start when a slot frees' },
  { file: 'src/extension.ts', api: 'showWarningMessage', scope: 'migrateLegacySingletonCustomGateways', messageIncludes: 'different rosters in workspace state' },
  { file: 'src/extension.ts', api: 'showWarningMessage', scope: 'migrateLegacySingletonCustomGateways', messageIncludes: 'pending legacy Custom gateway migration for a different roster' },
  { file: 'src/extension.ts', api: 'showErrorMessage', scope: 'migrateLegacySingletonCustomGateways', messageIncludes: 'message' },
  { file: 'src/state/PersistenceManager.ts', api: 'showWarningMessage', scope: 'loadTeamConfig', messageIncludes: 'adjusted .unode/team.json' },
  { file: 'src/state/PersistenceManager.ts', api: 'showWarningMessage', scope: 'warnTeamFileIgnored', messageIncludes: 'ignored .unode/team.json' },
];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name === 'resultNotice.ts') return [];
    return [full];
  });
}

function fail(message) {
  console.error(`outcome notice check failed: ${message}`);
  process.exitCode = 1;
}

function compact(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function scopeName(node, source) {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return compact(current.name.getText(source));
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return compact(current.parent.name.getText(source));
    }
    current = current.parent;
  }
  return '<module>';
}

function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function objectHasTrueProperty(node, name, source) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => ts.isPropertyAssignment(property)
    && compact(property.name.getText(source)).replace(/["']/g, '') === name
    && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function normalizedRelative(file) {
  return relative(ROOT, file).replaceAll('\\', '/');
}

function signature(file, api, scope, messageSource) {
  return `${file} | ${api} | ${scope} | ${messageSource}`;
}

const observedAmbient = new Map(AMBIENT_TOASTS.map((_, index) => [index, 0]));
let modalWithoutItems = 0;
let nonModalNoticesWithButtons = 0;
let ambientToasts = 0;
let routedResultNotices = 0;

for (const file of sourceFiles(SOURCE_ROOT)) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'showResultNotice') {
      const kind = node.arguments[0];
      if (!kind || !ts.isStringLiteral(kind) || !['information', 'warning', 'error'].includes(kind.text)
          || node.arguments.length < 2 || node.arguments.length > 3) {
        fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} calls showResultNotice with an invalid kind or shape.`);
      }
      routedResultNotices++;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const api = propertyName(node);
      if (/^show(?:Information|Warning|Error)Message$/.test(api ?? '')) {
        const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!directCall) {
          fail(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} aliases ${api}; call the message API directly so its classification is auditable.`);
        }
      }
    }
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const api = propertyName(node.expression);
    if (!/^show(?:Information|Warning|Error)Message$/.test(api ?? '')) {
      ts.forEachChild(node, visit);
      return;
    }

    const second = node.arguments[1];
    const hasOptions = !!second && ts.isObjectLiteralExpression(second);
    const isModal = hasOptions && objectHasTrueProperty(second, 'modal', source);
    const itemCount = Math.max(0, node.arguments.length - (hasOptions ? 2 : 1));
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const scope = scopeName(node, source);
    const relativeFile = normalizedRelative(file);
    const messageSource = compact(node.arguments[0]?.getText(source) ?? '<missing>');
    const key = signature(relativeFile, api, scope, messageSource);

    if (itemCount > 0) {
      if (!isModal) {
        nonModalNoticesWithButtons++;
        if (REPORT) console.log(`HAS BUTTONS ${relative(ROOT, file)}:${line} ${key}`);
      } else if (REPORT) {
        console.log(`MODAL ITEMS ${relative(ROOT, file)}:${line} ${key}`);
      }
    } else if (isModal) {
      modalWithoutItems++;
      if (REPORT) console.log(`MODAL       ${relative(ROOT, file)}:${line} ${key}`);
      fail(`${relative(ROOT, file)}:${line} bypasses showResultNotice for an itemless modal result: ${key}`);
    } else {
      ambientToasts++;
      const ambientIndex = AMBIENT_TOASTS.findIndex((entry) => entry.file === relativeFile
        && entry.api === api && entry.scope === scope && messageSource.includes(entry.messageIncludes));
      if (ambientIndex >= 0) observedAmbient.set(ambientIndex, (observedAmbient.get(ambientIndex) ?? 0) + 1);
      if (REPORT) console.log(`NON-MODAL   ${relative(ROOT, file)}:${line} ${key}`);
      if (ambientIndex < 0) {
        fail(`${relative(ROOT, file)}:${line} is a non-modal notice with no actions and has not been classified as ambient: ${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (!FIXTURE_MODE) {
  for (const [index, entry] of AMBIENT_TOASTS.entries()) {
    const actualCount = observedAmbient.get(index) ?? 0;
    if (actualCount !== 1) {
      fail(`ambient classification expected 1 call, observed ${actualCount}: ${JSON.stringify(entry)}`);
    }
  }
}

if (!FIXTURE_MODE && process.exitCode !== 1) {
  const sandbox = mkdtempSync(join(tmpdir(), 'unode-outcome-notices-'));
  try {
    const fixture = join(sandbox, 'fixture.ts');
    mkdirSync(dirname(fixture), { recursive: true });
    writeFileSync(fixture, `function clicked() { vscode.window.showInformationMessage('A new user-action answer'); }`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        UNODE_OUTCOME_NOTICE_FIXTURE: '1',
        UNODE_OUTCOME_NOTICE_SOURCE_ROOT: sandbox,
      },
    });
    if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes('has not been classified as ambient')) {
      fail('planted non-modal user-action notice survived.');
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (!FIXTURE_MODE && process.exitCode !== 1) {
  const sandbox = mkdtempSync(join(tmpdir(), 'unode-outcome-modal-'));
  try {
    const fixture = join(sandbox, 'fixture.ts');
    writeFileSync(fixture, `function clicked() { vscode.window.showInformationMessage('A direct result dialog', { modal: true }); }`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        UNODE_OUTCOME_NOTICE_FIXTURE: '1',
        UNODE_OUTCOME_NOTICE_SOURCE_ROOT: sandbox,
      },
    });
    if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes('bypasses showResultNotice')) {
      fail('planted direct modal result notice survived.');
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (!FIXTURE_MODE && process.exitCode !== 1) {
  console.log(`outcome notice check passed (${routedResultNotices} result notices routed through the user-style helper; ${modalWithoutItems} direct itemless modals; ${ambientToasts} explicitly classified ambient toasts; ${nonModalNoticesWithButtons} non-modal notices with actions; 2 planted failures killed).`);
}
