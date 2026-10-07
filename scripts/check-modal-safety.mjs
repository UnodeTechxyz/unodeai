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

/**
 * v0.9.88 attention signal (§5.11): every modal is classified, so a new blocking prompt cannot silently miss its
 * sound. A modal is either shown through `blockingPrompt(key, () => …)`, which sounds as it appears; or a broker
 * approval modal, shown only as the `showModal` argument of the routes below (the broker sounds when it opens);
 * or listed here as a dialog the user opened, with a one-line reason. Entries name the file under src/ and
 * either a fragment of the prompt's source text or the enclosing function.
 */
const BROKER_MODAL_ROUTES = new Set(['brokeredApproval', 'openBrokeredApproval']);
const USER_OPENED = 'The user opened this dialog; no agent is waiting on it.';
const USER_INITIATED_MODALS = process.env.UNODE_MODAL_GATE_ALLOWLIST && FIXTURE_MODE
  ? JSON.parse(process.env.UNODE_MODAL_GATE_ALLOWLIST)
  : [
    { file: 'backend/CommandApprovalPrompter.ts', prompt: 'agents are blocked from running shell commands', reason: 'Offered after the user creates a team, or from Enable Commands; no agent is waiting.' },
    { file: 'dialogs.ts', prompt: 'works best with a verification command', reason: 'Part of the team setup the user started.' },
    { file: 'dialogs.ts', prompt: 'unode.verifyCommand is already', reason: 'Part of the team setup the user started.' },
    { file: 'dialogs.ts', prompt: 'This replaces your current', reason: 'The user chose a preset.' },
    { file: 'extension.ts', prompt: 'Apply the full execution-hook declaration', reason: USER_OPENED },
    { file: 'extension.ts', prompt: 'Enable Full access (unsafe)', reason: 'The user changes an agent\'s permission profile.' },
    { file: 'extension.ts', prompt: 'The first workspace folder changed', reason: 'Answers an action the user just took.' },
    { file: 'extension.ts', prompt: 'Open a workspace folder before you', reason: 'Answers an action the user just took.' },
    { file: 'extension.ts', prompt: 'It didn\'t exist before', reason: 'The user restores a checkpoint.' },
    { file: 'extension.ts', fn: 'addCustomGateway', reason: 'The user adds a gateway.' },
    { file: 'extension.ts', fn: 'editCustomGateway', reason: 'The user edits a gateway.' },
    { file: 'extension.ts', fn: 'updateCustomGatewayEndpoint', reason: 'The user edits a gateway.' },
    { file: 'extension.ts', prompt: 'Clear the stored API key for', reason: 'The user clears a key.' },
    { file: 'extension.ts', prompt: 'from your gateways?', reason: 'The user removes a gateway.' },
    { file: 'extension.ts', prompt: 'Reset UnodeAi in this workspace?', reason: USER_OPENED },
    { file: 'extension.ts', prompt: 'Revoke local attestation for this exact row?', reason: 'The user reviews shared memory.' },
    { file: 'extension.ts', prompt: 'Attest this exact row as reviewed team guidance?', reason: 'The user reviews shared memory.' },
    { file: 'extension.ts', prompt: 'runAcceptanceEvidence(run)', reason: 'The user reviews a run for acceptance.' },
    { file: 'extension.ts', prompt: 'Importing this chat will replace', reason: 'The user imports a chat.' },
    { file: 'extension.ts', prompt: 'Importing messages will replace', reason: 'The user imports messages.' },
    { file: 'extension.ts', prompt: 'Clear the chat with', reason: 'The user clears a chat.' },
    { file: 'extension.ts', prompt: 'Restore this archived chat into', reason: 'The user restores an archived chat.' },
    { file: 'extension.ts', prompt: 'Clear all team messages?', reason: 'The user clears the activity feed.' },
    { file: 'extension.ts', prompt: 'Could not save a snapshot of the current', reason: 'Part of a team switch the user started.' },
    { file: 'extension.ts', prompt: 'Where should this team be saved?', reason: 'The user saves a team.' },
    { file: 'extension.ts', prompt: 'Overwrite it?', reason: 'The user saves a team.' },
    { file: 'extension.ts', prompt: 'savedTeamDeleteConfirmation(item.ref, label)', reason: 'The user deletes a saved team.' },
    { file: 'extension.ts', prompt: 'Delete the automatic snapshot', reason: 'The user deletes a snapshot.' },
    { file: 'extension.ts', fn: 'offerAgentBuilderForUnrestorablePermissions', reason: 'Part of a team load the user started.' },
    { file: 'extension.ts', prompt: 'setting(s) this version does not recognise', reason: 'Part of a team load the user started.' },
    { file: 'extension.ts', prompt: 'recognises the exact project team file it saved', reason: 'Part of a team load the user started.' },
    { file: 'extension.ts', prompt: 'Disable command execution for this project', reason: USER_OPENED },
    { file: 'extension.ts', prompt: 'Revoke the project command approval', reason: USER_OPENED },
    { file: 'extension.ts', prompt: 'customized instructions with the current', reason: 'The user applies a prompt template.' },
    { file: 'extension.ts', prompt: 'Start a new team with', reason: 'The user installs a marketplace team.' },
    { file: 'extension.ts', prompt: 'Remove integration', reason: 'The user removes an integration.' },
    { file: 'extension.ts', prompt: 'legacyCustomGatewayMigrationPreview(plan)', reason: 'A one-time settings migration shown as the editor starts; no agent is waiting.' },
    { file: 'extension.ts', prompt: 'for the unfinished work?', reason: 'The user chose Continue unfinished work on a Job outcome card; the job is closed and no agent is waiting.' },
    { file: 'resultNotice.ts', prompt: 'message', reason: 'A result notice reports an outcome and owes no decision.' },
    { file: 'host/SpendHost.ts', prompt: 'Reset the spend counter for', reason: 'The user chose Reset counter; no agent is waiting and work is not touched.' },
    { file: 'host/SpendHost.ts', prompt: 'Repair spend tracking for this project?', reason: 'The user ran Repair spend tracking.' },
  ];

/**
 * v0.9.89 (§5.4, §7): two modal families that are neither approvals nor user-opened dialogs.
 *
 * SPEND_ALERT_MODALS: an over-target spend reminder. It sounds through requireAttention before it opens, and no
 * caller awaits it: every reference to its function is a `void` call, so no provider turn can wait on it.
 * SILENT_POST_TURN_DECISION_MODALS: a choice offered after a turn has already finished. Nothing waits on it and
 * it never sounds. Entries name the file under src/ and the enclosing function.
 */
const SPEND_ALERT_MODALS = process.env.UNODE_MODAL_GATE_SPEND_ALERTS && FIXTURE_MODE
  ? JSON.parse(process.env.UNODE_MODAL_GATE_SPEND_ALERTS)
  : [
    { file: 'host/SpendHost.ts', fn: 'showOverTargetModal', reason: 'Over-target spend reminder; it chimes before it opens and no turn awaits it.' },
  ];
const SILENT_POST_TURN_DECISION_MODALS = process.env.UNODE_MODAL_GATE_SILENT && FIXTURE_MODE
  ? JSON.parse(process.env.UNODE_MODAL_GATE_SILENT)
  : [
    { file: 'host/SpendHost.ts', fn: 'offerReferencePriceChoice', reason: 'First-run reference-price choice after a finished gateway turn; nothing waits and it does not chime.' },
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
  'Keep going',
  'Keep key',
  'Keep messages',
  'Keep saved team',
  'Keep untrusted',
  'Load read-only',
  'Not now',
  'Continue without project automation',
  'Skip',
  'Stay on current team',
  'Use token reminders only',
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
const allowlistUses = new Map();
const classified = { blocking: 0, broker: 0, userOpened: 0, spendAlert: 0, silentPostTurn: 0 };
const familyUses = new Map();
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
  const sourcePath = relative(SOURCE_ROOT, file).replace(/\\/g, '/');
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // `blockingPrompt(key, () => vscode.window.showXxxMessage(…))`: the concise arrow body is the modal itself.
  const blockingPromptCall = (modal) => {
    const arrow = modal.parent;
    if (!arrow || !ts.isArrowFunction(arrow) || arrow.body !== modal) return undefined;
    const call = arrow.parent;
    return call && ts.isCallExpression(call) && ts.isIdentifier(call.expression)
      && call.expression.text === 'blockingPrompt' && call.arguments[1] === arrow ? call : undefined;
  };
  const enclosingFunctionNode = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current;
      if (ts.isFunctionLike(current)) return undefined;
    }
    return undefined;
  };
  // A spend alert may never be awaited: each reference to its function must be the operand of `void`, inside a
  // function that sounds it with requireAttention first.
  const spendAlertProblem = (name) => {
    const references = [];
    const collect = (node) => {
      if (ts.isIdentifier(node) && node.text === name
        && !((ts.isFunctionDeclaration(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node)) {
        references.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    if (references.length === 0) return 'is a spend alert that nothing opens.';
    for (const reference of references) {
      let call = reference.parent;
      while (call && (ts.isPropertyAccessExpression(call) || ts.isParenthesizedExpression(call))) call = call.parent;
      if (!call || !ts.isCallExpression(call) || !call.parent || !ts.isVoidExpression(call.parent)) {
        return 'is a spend alert whose opening is awaited or returned; start it detached with `void` so no turn can wait on it.';
      }
      const caller = enclosingFunctionNode(call)?.getText(source) ?? '';
      if (!/\brequireAttention\s*\(/.test(caller)) {
        return 'is a spend alert opened without requireAttention; an over-target reminder must sound as it appears.';
      }
    }
    return undefined;
  };
  const enclosingFunctionName = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.getText(source);
      if (ts.isFunctionLike(current)) return undefined;
    }
    return undefined;
  };
  // A broker modal's function is referenced only as an argument of a broker route, so the broker opens it.
  const onlyBrokerRouted = (name) => {
    const references = [];
    const collect = (node) => {
      if (ts.isIdentifier(node) && node.text === name && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
        references.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    return references.length > 0 && references.every((reference) => {
      for (let current = reference.parent; current; current = current.parent) {
        if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)
            && BROKER_MODAL_ROUTES.has(current.expression.text)
            && current.arguments.some((argument) => argument.pos <= reference.pos && reference.end <= argument.end)) {
          return true;
        }
      }
      return false;
    });
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
        const decisionCall = blockingPromptCall(node) ?? node;
        if (!/\.test\.ts$/.test(file)) {
          const promptSource = node.arguments[0]?.getText(source) ?? '';
          const functionName = enclosingFunctionName(node);
          const entry = USER_INITIATED_MODALS.find((candidate) => candidate.file === sourcePath
            && (candidate.prompt ? promptSource.includes(candidate.prompt) : candidate.fn === functionName));
          const spendAlert = SPEND_ALERT_MODALS.find((candidate) => candidate.file === sourcePath && candidate.fn === functionName);
          const silent = SILENT_POST_TURN_DECISION_MODALS.find((candidate) => candidate.file === sourcePath && candidate.fn === functionName);
          if (decisionCall !== node) {
            classified.blocking++;
          } else if (functionName && onlyBrokerRouted(functionName)) {
            classified.broker++;
          } else if (spendAlert) {
            classified.spendAlert++;
            familyUses.set(spendAlert, true);
            const problem = spendAlertProblem(functionName);
            if (problem) fail(`${relative(ROOT, file)}:${lineOf(node)} ${problem}`);
          } else if (silent) {
            classified.silentPostTurn++;
            familyUses.set(silent, true);
            const body = enclosingFunctionNode(node)?.getText(source) ?? '';
            if (/\b(?:requireAttention|blockingPrompt)\s*\(/.test(body)) {
              fail(`${relative(ROOT, file)}:${lineOf(node)} is a silent post-turn decision but sounds; it must not call requireAttention or blockingPrompt.`);
            }
          } else if (entry) {
            classified.userOpened++;
            allowlistUses.set(entry, (allowlistUses.get(entry) ?? 0) + 1);
          } else {
            fail(`${relative(ROOT, file)}:${lineOf(node)} is neither a blocking prompt nor a user-opened dialog: show it `
              + 'through blockingPrompt(key, () => …) so it sounds when it appears, or add it to USER_INITIATED_MODALS with a reason.');
          }
        }
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
        if (affirmativeLabels.size > 0 && !explicitlyChecksAction(decisionCall, affirmativeLabels)) {
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

for (const entry of [...SPEND_ALERT_MODALS, ...SILENT_POST_TURN_DECISION_MODALS]) {
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) fail(`modal family entry "${entry.fn}" in ${entry.file} has no reason.`);
  if (!FIXTURE_MODE && !familyUses.has(entry)) fail(`modal family entry "${entry.fn}" in ${entry.file} matches no modal; remove the stale entry.`);
}
for (const entry of USER_INITIATED_MODALS) {
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
    fail(`user-opened modal "${entry.prompt ?? entry.fn}" in ${entry.file} has no reason.`);
  }
  if (!allowlistUses.has(entry)) fail(`user-opened modal "${entry.prompt ?? entry.fn}" in ${entry.file} matches no modal; remove the stale entry.`);
}
if (!FIXTURE_MODE) {
  for (const [fragment] of REQUIRED_SAFE_DEFAULTS) {
    if (!observed.has(fragment)) fail(`required guarded modal "${fragment}" is missing.`);
  }
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
        name: 'unclassified modal',
        source: `async function unclassified() {
          const choice = await vscode.window.showWarningMessage('Apply it?', { modal: true }, 'Not now', 'Apply');
          if (choice !== 'Apply') return;
          await applyEffect();
        }`,
        expected: 'is neither a blocking prompt nor a user-opened dialog',
      },
      {
        name: 'user-opened modal without a reason',
        source: `async function unexplained() {
          const choice = await vscode.window.showWarningMessage('Apply it?', { modal: true }, 'Not now', 'Apply');
          if (choice !== 'Apply') return;
          await applyEffect();
        }`,
        allowlist: [{ file: 'fixture.ts', prompt: 'Apply it?', reason: '' }],
        expected: 'has no reason',
      },
      {
        name: 'blocking prompt that sounds',
        source: `async function blocking() {
          const choice = await blockingPrompt('fixture:1', () => vscode.window.showWarningMessage('Apply it?', { modal: true }, 'Not now', 'Apply'));
          if (choice !== 'Apply') return;
          await applyEffect();
        }`,
        passes: true,
      },
      {
        name: 'spend alert awaited on a turn path',
        source: `async function showOverTargetModal() {
          const choice = await vscode.window.showWarningMessage('Over target', { modal: true }, 'Keep going', 'Stop this request');
          if (choice !== 'Stop this request') return;
          stop();
        }
        async function onThreshold() { requireAttention('k'); await showOverTargetModal(); }`,
        spendAlerts: [{ file: 'fixture.ts', fn: 'showOverTargetModal', reason: 'test' }],
        expected: 'start it detached with `void`',
      },
      {
        name: 'spend alert that does not sound',
        source: `async function showOverTargetModal() {
          const choice = await vscode.window.showWarningMessage('Over target', { modal: true }, 'Keep going', 'Stop this request');
          if (choice !== 'Stop this request') return;
          stop();
        }
        function onThreshold() { void showOverTargetModal(); }`,
        spendAlerts: [{ file: 'fixture.ts', fn: 'showOverTargetModal', reason: 'test' }],
        expected: 'opened without requireAttention',
      },
      {
        name: 'silent post-turn decision that sounds',
        source: `async function offerChoice() {
          requireAttention('k');
          const choice = await vscode.window.showInformationMessage('Choose', { modal: true }, 'Use token reminders only', 'Use Unode');
          if (choice !== 'Use Unode') return;
          apply();
        }`,
        silent: [{ file: 'fixture.ts', fn: 'offerChoice', reason: 'test' }],
        expected: 'is a silent post-turn decision but sounds',
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
        env: {
          ...process.env,
          UNODE_MODAL_GATE_FIXTURE: '1',
          UNODE_MODAL_GATE_SOURCE_ROOT: directory,
          UNODE_MODAL_GATE_ALLOWLIST: JSON.stringify(plant.allowlist ?? []),
          UNODE_MODAL_GATE_SPEND_ALERTS: JSON.stringify(plant.spendAlerts ?? []),
          UNODE_MODAL_GATE_SILENT: JSON.stringify(plant.silent ?? []),
        },
      });
      if (plant.passes) {
        if (result.status !== 0) fail(`planted ${plant.name} was refused: ${result.stderr.trim()}`);
      } else if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes(plant.expected)) {
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
    + `no duplicate Cancel actions; every modal classified for the attention sound: ${classified.blocking} blocking prompts, `
    + `${classified.broker} broker approval modals, ${classified.userOpened} user-opened, ${classified.spendAlert} detached spend alert, `
    + `${classified.silentPostTurn} silent post-turn choice; 7 planted failures killed, 1 planted pass).`);
}
