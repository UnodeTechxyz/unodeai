import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';

/*
 * v0.9.102 R5 (design 8, 10 row T102-8, 10.1): one deterministic artifact fixture for each of the eight work families.
 *
 * WHAT THIS PROVES: wiring and artifact contracts. A shipped role, made by the preset factory the picker uses
 * (`dialogs.instantiateTeam`), runs as a session of the real SessionManager, which assembles its runtime prompt; its
 * backend is the real OpenAI-compatible backend; the production tools (write_file, write_document with the real
 * document renderer, run_command with the real direct executor and the Ask approval path) produce a real file in a
 * temporary folder; and each fixture checks that artifact by a means of its own (the product's own document reader,
 * an independent recomputation, a parse, the real cited file lines).
 *
 * WHAT THIS DOES NOT PROVE: professional quality. The model's replies are scripted here; nothing in this file says
 * whether any of the 52 roles reasons well, chooses the right method or writes a good artifact. That is model
 * dependent and is recorded separately (the five task cards and the Owner-run baseline). A PASS here is not
 * "every role passed in real use".
 *
 * What stands in: the model's replies (scripted), the person's approval of each command (yes), and a raw-checkpoint
 * host for file writes (the same test host the save-attachment flows use).
 */
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => '', update: vi.fn() }), isTrusted: true },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn(), showInputBox: vi.fn() },
}));
vi.mock('../CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn(async () => false) }));

import * as dialogs from '../../dialogs';
import { ROLE_TEMPLATES, TEAM_PRESETS } from '../../roles/RoleConfig';
import { MessageBus } from '../../bus/MessageBus';
import { runtimeSystemPrompt, SessionManager } from '../../session/SessionManager';
import { defaultBackendKind } from '../backendKind';
import { BUILTIN_CONNECTION_REGISTRY } from '../../routes/ConnectionRegistry';
import { extractWorkspaceDocument } from '../../content/ContentAssetStore';
import { CommandPolicy } from '../CommandPolicy';
import { createDirectExecutionProvider } from '../DirectCommandExecution';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import type { DocumentRenderer } from '../../content/document/DocumentRenderer';
import type { AgentConfig } from '../../types';
import { saveHost } from './attachmentSaveFixtures';
import { documentRouteRenderer } from './documentRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

const HEADING = '## How to work (shared by every agent)';
const DOER = 'Doing the work: focus on the deliverable and the smallest change that achieves it.';
// v0.9.105 (S1): the review and assessment roles get the reviewer addendum instead. Of the roles in this file, that is
// the GRC Analyst.
const REVIEWER = 'As a reviewer: first confirm what actually triggers a problem and what it does to the user.';
const REVIEW_ROLES_HERE = new Set(['grc-analyst']);

function call(name: string, args: Record<string, unknown>, id = `call-${name}`) {
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
}
const say = (text: string) => ({ choices: [{ message: { role: 'assistant', content: text } }] });
const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
/** The tool result the model was shown in request `index`: the last message of that request. */
const shown = (requests: any[], index: number) => textOf(requests[index].messages.at(-1).content);

function dialogDeps(created: AgentConfig[]) {
  return {
    sessionManager: { getAll: () => created.map(config => ({ config })), create: (config: AgentConfig) => { created.push(config); } },
    secrets: { has: async () => true, get: async () => undefined, promptAndStore: async () => {} },
    output: { info: () => {} }, commandPolicy: { approvalMode: 'none', reload: () => {} }, reloadCommandPolicy: () => {},
    defaultBackendKind: (config: AgentConfig) => defaultBackendKind(config, BUILTIN_CONNECTION_REGISTRY),
    defaultProvider: () => 'roam', suppressInteractivePostCreatePrompts: true,
  } as never;
}

/** The shipped role `roleKey` as the preset factory makes it for `presetKey` (Solo is added by the factory). */
async function presetMember(presetKey: string, roleKey: string): Promise<AgentConfig> {
  const preset = TEAM_PRESETS[presetKey];
  const members: AgentConfig[] = [];
  await dialogs.instantiateTeam(dialogDeps(members), preset.roles, preset.label);
  const member = members.find(config => config.roleTemplateKey === roleKey);
  if (!member) throw new Error(`${presetKey} has no ${roleKey}`);
  return member;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await removeTemporaryFolders();
});

/**
 * Run one task of `member` in a real SessionManager on the real OpenAI-compatible backend, in a fresh folder holding
 * `files`. `script` is the model's replies, one per request. Returns the folder, the requests the provider received
 * and the commands the person was asked to approve.
 */
async function work(member: AgentConfig, files: Record<string, string>, instruction: string, script: unknown[]) {
  const host = await saveHost();
  const root = host.root;
  // The real document renderer: an isolated worker built from the product source, with test-only fonts for PDF.
  const renderer: DocumentRenderer = await documentRouteRenderer();
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content, 'utf8');
  }
  const requests: any[] = [];
  const replies = [...script];
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const next = replies.shift();
    if (next === undefined) throw new Error('The scripted model has no reply left.');
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  const approvals: string[] = [];
  const bus = new MessageBus();
  const manager = new SessionManager(4, bus, {
    createBackend: (config) => new OpenAICompatBackend(
      config, fetchFn, undefined, undefined,
      // The person's Ask setting for commands: every command is put to them, and they say yes.
      new CommandPolicy('ask', []), { retryBaseMs: 0 }, undefined, undefined,
      async (command) => { approvals.push(command); return { allow: true }; },
      undefined, undefined,
      createDirectExecutionProvider(),
      undefined, undefined, undefined, undefined,
      { documentRenderer: renderer, fileWrites: host.fileWrites(config.id) },
    ),
    resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test' }),
    resolveWorkingDirectory: async () => root,
  });
  cleanups.push(async () => { await manager.stopAll(); bus.dispose(); });
  manager.create(member);
  await manager.start(member.id, { pin: 'take' });
  const ended = new Promise<void>((resolve) => {
    const listener = (event: { sessionId: string }) => {
      if (event.sessionId !== member.id) return;
      manager.off('session.turnEnded', listener);
      resolve();
    };
    manager.on('session.turnEnded', listener);
  });
  bus.send('user', member.id, 'ask.question', { instruction, mode: 'act' });
  await ended;
  expect(replies, 'every scripted reply was used').toEqual([]);
  // The provider received the shipped role's assembled runtime prompt, with the production tools.
  const system = textOf(requests[0].messages.find((message: { role: string }) => message.role === 'system')?.content);
  expect(system).toContain(runtimeSystemPrompt(member, undefined));
  expect(system).toContain(ROLE_TEMPLATES[member.roleTemplateKey!].systemPrompt);
  expect(system.split(HEADING)).toHaveLength(2);
  const review = REVIEW_ROLES_HERE.has(member.roleTemplateKey!);
  expect(system).toContain(review ? REVIEWER : DOER);
  expect(system).not.toContain(review ? DOER : REVIEWER);
  const tools = requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name);
  for (const tool of ['read_file', 'write_file', 'write_document', 'run_command']) expect(tools).toContain(tool);
  expect(tools).not.toContain('dispatch_task');
  return { root, requests, approvals, read: (file: string) => readFile(join(root, file), 'utf8') };
}

/** Run `node <args>` in `cwd` as an independent re-check; returns stdout, or throws with the exit. */
const node = (cwd: string, ...args: string[]) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** HTML structure: every non-void element closes, in order. Returns what is wrong. */
function htmlStructureErrors(html: string): string[] {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack: string[] = [];
  const errors: string[] = [];
  for (const match of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, rawName] = match;
    const name = rawName.toLowerCase();
    if (VOID.has(name)) continue;
    if (!closing) { stack.push(name); continue; }
    const open = stack.pop();
    if (open !== name) errors.push(`</${name}> closes <${open ?? 'nothing'}>`);
  }
  for (const open of stack) errors.push(`<${open}> is never closed`);
  return errors;
}

describe('v0.9.102 R5 T102-8: each work family delivers a real artifact through the production tools (wiring, not professional quality)', () => {
  it('engineering: the Bugfix Crew Senior Developer reproduces a failing test, fixes the code, and the test passes on an independent re-run', async () => {
    const member = await presetMember('bugfix-crew', 'senior-dev');
    const TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { withTax } from '../src/price.mjs';\n"
      + "test('adds tax to the net price', () => { assert.equal(withTax(100, 0.2), 120); });\n";
    const FIXED = 'export const withTax = (net, rate) => Math.round(net * (1 + rate) * 100) / 100;\n';
    const h = await work(member, { 'src/price.mjs': 'export const withTax = (net, rate) => net * rate;\n', 'test/price.test.mjs': TEST },
      'withTax(100, 0.2) returns 20 instead of 120. Fix it.', [
        call('read_file', { path: 'src/price.mjs' }),
        call('run_command', { command: 'node --test test/price.test.mjs' }),
        call('write_file', { path: 'src/price.mjs', content: FIXED }),
        call('run_command', { command: 'node --test test/price.test.mjs' }, 'call-run_command-again'),
        say('Fixed withTax: it now adds the rate to 1. node --test test/price.test.mjs passes.'),
      ]);
    // The real test failed before the fix and passed after it; each command was put to the person (Ask).
    expect(shown(h.requests, 2)).toMatch(/fail 1/);
    expect(shown(h.requests, 4)).toMatch(/pass 1/);
    expect(h.approvals).toEqual(['node --test test/price.test.mjs', 'node --test test/price.test.mjs']);
    // Artifact and its check: the fix is on disk, the test file is untouched, and an independent run passes.
    expect(await h.read('src/price.mjs')).toBe(FIXED);
    expect(await h.read('test/price.test.mjs')).toBe(TEST);
    expect(node(h.root, '--test', 'test/price.test.mjs')).toMatch(/pass 1/);
  }, 60_000);

  it('prototype: the Experience Design Product Designer builds an HTML prototype whose markup is well formed, whose script parses, and whose own check passes again', async () => {
    const member = await presetMember('experience-design', 'product-designer');
    const HTML = [
      '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<title>Sign-up prototype</title>', '</head>', '<body>',
      '<main>', '<form id="signup" novalidate>', '<label for="email">Email</label>', '<input id="email" name="email" type="email" required>',
      '<p id="email-error" role="alert" hidden></p>', '<button type="submit">Create account</button>', '</form>', '</main>',
      '<script type="module" src="./signup.mjs"></script>', '</body>', '</html>', '',
    ].join('\n');
    const SCRIPT = [
      'export function emailError(value) {',
      "  const text = String(value ?? '').trim();",
      "  if (text === '') return 'Enter your email address.';",
      "  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(text)) return 'Enter an email address like name@example.com.';",
      "  return '';",
      '}',
      "if (typeof document !== 'undefined') {",
      "  document.getElementById('signup').addEventListener('submit', (event) => {",
      "    const message = emailError(document.getElementById('email').value);",
      "    const error = document.getElementById('email-error');",
      "    error.textContent = message; error.hidden = message === '';",
      '    if (message) event.preventDefault();',
      '  });',
      '}', '',
    ].join('\n');
    const CHECK = [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import { emailError } from './signup.mjs';",
      "assert.equal(emailError(''), 'Enter your email address.');",
      "assert.equal(emailError('ana@example'), 'Enter an email address like name@example.com.');",
      "assert.equal(emailError(' ana@example.com '), '');",
      "const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');",
      'for (const [, id] of html.matchAll(/<label for="([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), `label for ${id} has a field`);',
      "console.log('prototype checks passed: 3 states, labels bound');", '',
    ].join('\n');
    const h = await work(member, {}, 'Prototype the sign-up form with an inline email error, and check it.', [
      call('write_file', { path: 'prototype/index.html', content: HTML }),
      call('write_file', { path: 'prototype/signup.mjs', content: SCRIPT }, 'call-write_file-script'),
      call('write_file', { path: 'prototype/check.mjs', content: CHECK }, 'call-write_file-check'),
      call('run_command', { command: 'node prototype/check.mjs' }),
      say('Prototype in prototype/index.html; node prototype/check.mjs passes. Not yet seen in a browser.'),
    ]);
    expect(shown(h.requests, 4)).toContain('prototype checks passed: 3 states, labels bound');
    // Artifact checks: the markup is well formed, every label names a field, the script it loads exists and parses.
    const html = await h.read('prototype/index.html');
    expect(htmlStructureErrors(html)).toEqual([]);
    for (const [, id] of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
    const src = /<script type="module" src="\.\/([^"]+)"/.exec(html)?.[1];
    expect(src).toBe('signup.mjs');
    const parsed = ts.transpileModule(await h.read(`prototype/${src}`), { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, allowJs: true } });
    expect(parsed.diagnostics ?? []).toEqual([]);
    expect(node(h.root, 'prototype/check.mjs')).toContain('prototype checks passed');
    // Mutation guard for the structure check itself.
    expect(htmlStructureErrors(html.replace('</form>', ''))).not.toEqual([]);
  }, 60_000);

  it('knowledge / i18n: the Localization Specialist finds the missing Chinese string with its own check, completes the locale, and both languages hold every key and placeholder', async () => {
    const member = await presetMember('enablement-localization', 'localization-i18n-specialist');
    const EN = `${JSON.stringify({ greeting: 'Hello, {name}!', items: '{count} items in your cart', checkout: 'Check out' }, null, 2)}\n`;
    const ZH_PARTIAL = `${JSON.stringify({ greeting: '你好，{name}！', items: '购物车中有 {count} 件商品' }, null, 2)}\n`;
    const ZH = `${JSON.stringify({ greeting: '你好，{name}！', items: '购物车中有 {count} 件商品', checkout: '去结算' }, null, 2)}\n`;
    const CHECK = [
      "import { readFileSync } from 'node:fs';",
      'const load = (name) => JSON.parse(readFileSync(new URL(`../locales/${name}.json`, import.meta.url), \'utf8\'));',
      "const en = load('en'); const zh = load('zh-CN');",
      "const placeholders = (text) => [...text.matchAll(/\\{(\\w+)\\}/g)].map((m) => m[1]).sort().join(',');",
      'const problems = [];',
      'for (const key of new Set([...Object.keys(en), ...Object.keys(zh)])) {',
      "  if (!(key in en) || !(key in zh)) problems.push(`${key}: missing in ${key in en ? 'zh-CN' : 'en'}`);",
      '  else if (!en[key] || !zh[key]) problems.push(`${key}: empty`);',
      '  else if (placeholders(en[key]) !== placeholders(zh[key])) problems.push(`${key}: placeholders differ`);',
      '}',
      "if (problems.length) { console.log(problems.join('\\n')); process.exit(1); }",
      'console.log(`locales match: ${Object.keys(en).length} keys in en and zh-CN`);', '',
    ].join('\n');
    const h = await work(member, { 'locales/en.json': EN, 'locales/zh-CN.json': ZH_PARTIAL },
      'Make sure the Chinese locale is complete.', [
        call('write_file', { path: 'scripts/check-locales.mjs', content: CHECK }),
        call('run_command', { command: 'node scripts/check-locales.mjs' }),
        call('write_file', { path: 'locales/zh-CN.json', content: ZH }, 'call-write_file-zh'),
        call('run_command', { command: 'node scripts/check-locales.mjs' }, 'call-run_command-again'),
        say('Added the missing "checkout" string to zh-CN; the locale check passes.'),
      ]);
    expect(shown(h.requests, 2)).toContain('checkout: missing in zh-CN');
    expect(shown(h.requests, 4)).toContain('locales match: 3 keys in en and zh-CN');
    // Artifact check, independent of the agent's script: same keys, same placeholders, Chinese text, English untouched.
    const en = JSON.parse(await h.read('locales/en.json')) as Record<string, string>;
    const zh = JSON.parse(await h.read('locales/zh-CN.json')) as Record<string, string>;
    expect(await h.read('locales/en.json')).toBe(EN);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const key of Object.keys(en)) {
      expect(holes(zh[key]), key).toEqual(holes(en[key]));
      expect(zh[key], key).toMatch(/[\u4e00-\u9fff]/);
    }
  }, 60_000);

  it('review / GRC: the Security Governance GRC Analyst maps each control to the policy line it quotes and to the evidence, and every citation is the real line', async () => {
    const member = await presetMember('security-governance', 'grc-analyst');
    const POLICY = [
      '# Access control policy', '',
      'Scope: every production system.',
      'AC-1: Access rights are reviewed every quarter by the system owner.',
      'AC-2: Administrators sign in with multi-factor authentication.',
      'AC-3: Leavers lose access within one day of leaving.', '',
    ].join('\n');
    const REVIEWS = 'system,owner,reviewed_on,result\nbilling,ana,2026-09-14,approved\ncrm,li,2026-09-20,approved\n';
    const LEAVERS = 'person,left_on,access_removed_on\njo,2026-08-01,2026-08-01\nsam,2026-08-15,2026-08-18\n';
    const MATRIX = [
      '# Control matrix: access control, Q3 2026', '',
      'A mapping of the policy to the evidence in this folder. Not a certification or an audit opinion.', '',
      '| Control | Requirement (quoted) | Source | Evidence | Status |',
      '| --- | --- | --- | --- | --- |',
      '| AC-1 | "Access rights are reviewed every quarter by the system owner." | policies/access-control.md:4 | evidence/access-reviews-q3.csv: 2 of 2 systems reviewed | Met |',
      '| AC-2 | "Administrators sign in with multi-factor authentication." | policies/access-control.md:5 | none in this folder | Gap: no evidence |',
      '| AC-3 | "Leavers lose access within one day of leaving." | policies/access-control.md:6 | evidence/leavers-q3.csv: sam removed after 3 days | Gap: 1 of 2 late |', '',
    ].join('\n');
    const h = await work(member, { 'policies/access-control.md': POLICY, 'evidence/access-reviews-q3.csv': REVIEWS, 'evidence/leavers-q3.csv': LEAVERS },
      'Map our access-control policy to the Q3 evidence and show the gaps.', [
        call('read_file', { path: 'policies/access-control.md', line_numbers: true }),
        call('read_file', { path: 'evidence/access-reviews-q3.csv' }, 'call-read_file-reviews'),
        call('read_file', { path: 'evidence/leavers-q3.csv' }, 'call-read_file-leavers'),
        call('write_file', { path: 'grc/control-matrix.md', content: MATRIX }),
        say('Control matrix in grc/control-matrix.md: AC-1 met; AC-2 has no evidence; AC-3 was late once.'),
      ]);
    // The policy was read with its line numbers, as the citations need.
    expect(shown(h.requests, 1)).toMatch(/4\D+AC-1: Access rights are reviewed/);
    // Artifact check: every row's quoted requirement is on the exact line it cites, and its evidence file exists.
    const matrix = await h.read('grc/control-matrix.md');
    const rows = [...matrix.matchAll(/^\| (AC-\d) \| "([^"]+)" \| ([^:|]+):(\d+) \| ([^|]+) \| ([^|]+) \|$/gm)];
    expect(rows.map(row => row[1])).toEqual(['AC-1', 'AC-2', 'AC-3']);
    for (const [, control, quote, file, line, evidence] of rows) {
      const lines = (await h.read(file.trim())).split('\n');
      expect(lines[Number(line) - 1], control).toContain(quote);
      expect(lines[Number(line) - 1], control).toContain(control);
      const evidenceFile = /^(evidence\/[\w.-]+)/.exec(evidence.trim())?.[1];
      if (evidenceFile) expect(existsSync(join(h.root, evidenceFile)), control).toBe(true);
    }
    // The stated gap is recomputed from the evidence: one leaver kept access for more than a day.
    const late = LEAVERS.trim().split('\n').slice(1).map(row => row.split(','))
      .filter(([, left, removed]) => (Date.parse(removed) - Date.parse(left)) / 86_400_000 > 1).map(([person]) => person);
    expect(late).toEqual(['sam']);
    expect(matrix).toContain('sam removed after 3 days');
  }, 60_000);

  it('contract / procurement: the Contract Compliance Contract Analyst compares two versions and writes a bilingual Word summary that the product\'s own document reader opens, naming exactly the clauses that changed', async () => {
    const member = await presetMember('contract-compliance', 'contract-analyst');
    const V1 = 'MASTER SERVICES AGREEMENT v1\n7.1 Liability is capped at the fees paid in the 12 months before the claim.\n'
      + '9.2 Either party may terminate with 60 days\' written notice.\n11.4 Governing law: England and Wales.\n';
    const V2 = 'MASTER SERVICES AGREEMENT v2\n7.1 Liability is capped at the fees paid in the 6 months before the claim.\n'
      + '9.2 Either party may terminate with 30 days\' written notice.\n11.4 Governing law: England and Wales.\n';
    const zh = (text: string) => ({ text, language: 'zh-CN' });
    const docx = {
      schema_version: 1, path: 'contracts/msa-v1-v2-changes.docx', format: 'docx', template: 'contract-v1',
      document: { title: 'MSA v1 to v2: changed clauses', language: 'en', blocks: [
        { type: 'heading', level: 1, content: [{ text: 'Changed clauses' }] },
        { type: 'paragraph', content: [{ text: '7.1 Liability cap: 12 months of fees -> 6 months of fees.' }] },
        { type: 'paragraph', content: [{ text: '9.2 Termination notice: 60 days -> 30 days.' }] },
        { type: 'paragraph', content: [{ text: '11.4 Governing law: unchanged.' }] },
        { type: 'heading', level: 1, content: [zh('变更条款')] },
        { type: 'paragraph', content: [zh('7.1 责任上限：12 个月费用 → 6 个月费用。')] },
        { type: 'paragraph', content: [zh('9.2 终止通知期：60 天 → 30 天。')] },
        { type: 'paragraph', content: [{ text: 'A draft for an authorised signatory to review. Not legal advice and not a signature.' }] },
      ] },
    };
    const h = await work(member, { 'contracts/msa-v1.txt': V1, 'contracts/msa-v2.txt': V2 },
      'What changed between MSA v1 and v2? Give me a Word summary in English and Chinese.', [
        call('read_file', { path: 'contracts/msa-v1.txt' }),
        call('read_file', { path: 'contracts/msa-v2.txt' }, 'call-read_file-v2'),
        call('write_document', docx),
        say('Summary in contracts/msa-v1-v2-changes.docx: 7.1 and 9.2 changed; 11.4 did not.'),
      ]);
    expect(shown(h.requests, 3)).toContain('contracts/msa-v1-v2-changes.docx');
    // Artifact check: a real Word file, opened by the product's own reader (the Office worker read_file uses).
    const bytes = await readFile(join(h.root, docx.path));
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    const opened = await extractWorkspaceDocument(bytes);
    expect(opened.error).toBeUndefined();
    for (const line of ['7.1 Liability cap: 12 months of fees -> 6 months of fees.', '9.2 Termination notice: 60 days -> 30 days.',
      '7.1 责任上限：12 个月费用 → 6 个月费用。', '9.2 终止通知期：60 天 → 30 天。', '11.4 Governing law: unchanged.']) expect(opened.text).toContain(line);
    // The clauses it names as changed are exactly the ones that differ between the two versions.
    const clauses = (text: string) => new Map(text.split('\n').filter(line => /^\d+\.\d+ /.test(line)).map(line => [line.split(' ')[0], line]));
    const [one, two] = [clauses(V1), clauses(V2)];
    const changed = [...one.keys()].filter(key => one.get(key) !== two.get(key));
    expect(changed).toEqual(['7.1', '9.2']);
    for (const key of changed) expect(opened.text).toMatch(new RegExp(`^${key.replace('.', '\\.')} [A-Z]`, 'm'));
  }, 60_000);

  it('data / finance: the Financial Analysis Financial Analyst writes and runs a calculation, and its totals match an independent recomputation to the cent', async () => {
    const member = await presetMember('financial-analysis', 'financial-analyst');
    const DATA = [
      'month,category,amount_usd',
      '2026-07,cloud,1200.50', '2026-07,payroll,8000.00', '2026-07,travel,310.25',
      '2026-08,cloud,1315.75', '2026-08,payroll,8000.00', '2026-08,travel,95.10',
      '2026-09,cloud,1402.00', '2026-09,payroll,8250.00', '',
    ].join('\n');
    const SCRIPT = [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const rows = readFileSync(new URL('../data/expenses.csv', import.meta.url), 'utf8').trim().split(/\\r?\\n/).slice(1).map((line) => line.split(','));",
      'const cents = new Map();',
      'for (const [, category, amount] of rows) cents.set(category, (cents.get(category) ?? 0) + Math.round(Number(amount) * 100));',
      "const lines = ['category,total_usd', ...[...cents].sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => `${c},${(v / 100).toFixed(2)}`)];",
      'const total = [...cents.values()].reduce((a, b) => a + b, 0);',
      'lines.push(`total,${(total / 100).toFixed(2)}`);',
      "writeFileSync(new URL('./by-category.csv', import.meta.url), lines.join('\\n') + '\\n');",
      'console.log(`total_usd=${(total / 100).toFixed(2)} rows=${rows.length}`);', '',
    ].join('\n');
    const NOTES = '# Q3 spend by category\n\nInputs: data/expenses.csv (USD, as given). Sums in whole cents. Output: analysis/by-category.csv.\n';
    const h = await work(member, { 'data/expenses.csv': DATA }, 'Total our Q3 spend by category.', [
      call('read_file', { path: 'data/expenses.csv' }),
      call('write_file', { path: 'analysis/budget.mjs', content: SCRIPT }),
      call('run_command', { command: 'node analysis/budget.mjs' }),
      call('write_file', { path: 'analysis/README.md', content: NOTES }, 'call-write_file-notes'),
      say('Q3 spend is 28573.60 USD; by category in analysis/by-category.csv.'),
    ]);
    expect(shown(h.requests, 3)).toContain('total_usd=28573.60 rows=8');
    // Independent recomputation from the input, in this test's own code.
    const sums = new Map<string, number>();
    for (const [, category, amount] of DATA.trim().split('\n').slice(1).map(line => line.split(','))) {
      sums.set(category, (sums.get(category) ?? 0) + Math.round(Number(amount) * 100));
    }
    const produced = new Map((await h.read('analysis/by-category.csv')).trim().split('\n').slice(1).map(line => line.split(',') as [string, string]));
    for (const [category, cents] of sums) expect(produced.get(category), category).toBe((cents / 100).toFixed(2));
    expect(produced.get('total')).toBe(([...sums.values()].reduce((a, b) => a + b, 0) / 100).toFixed(2));
    expect(produced.size).toBe(sums.size + 1);
    expect(await h.read('analysis/README.md')).toBe(NOTES);
  }, 60_000);

  it('marketing / support: the Customer Experience Support Agent counts the errors in a ticket log with a command and drafts a reply whose numbers and times are the log\'s; nothing is sent', async () => {
    const member = await presetMember('customer-experience', 'customer-support-agent');
    const LOG = [
      '2026-11-02T09:00:01Z INFO start',
      '2026-11-02T09:00:05Z ERROR E_TIMEOUT upstream=payments after=30s',
      '2026-11-02T09:01:10Z ERROR E_TIMEOUT upstream=payments after=30s',
      '2026-11-02T09:02:00Z WARN slow upstream=search',
      '2026-11-02T09:03:30Z ERROR E_AUTH token expired', '',
    ].join('\n');
    const COUNT = [
      "import { readFileSync } from 'node:fs';",
      'const counts = {};',
      "for (const line of readFileSync(process.argv[2], 'utf8').split(/\\r?\\n/)) {",
      '  const m = / ERROR (\\w+)/.exec(line); if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;',
      '}',
      'console.log(JSON.stringify(counts));', '',
    ].join('\n');
    const DRAFT = [
      'DRAFT (not sent): for the person handling ticket T-1042 to review and send.', '',
      'Hello,', '',
      'Thank you for the log. It shows 2 payment timeouts (at 09:00:05Z and 09:01:10Z, 30 s each) and 1 expired sign-in token (at 09:03:30Z).',
      'Signing in again clears the token error. We are looking into the payment timeouts with the payments team.', '',
      'Internal note: escalate E_TIMEOUT to payments on-call with both timestamps.', '',
    ].join('\n');
    const h = await work(member, { 'tickets/T-1042/app.log': LOG }, 'Ticket T-1042: what went wrong? Draft a reply.', [
      call('write_file', { path: 'support/count-errors.mjs', content: COUNT }),
      call('run_command', { command: 'node support/count-errors.mjs tickets/T-1042/app.log' }),
      call('write_file', { path: 'support/T-1042-reply-draft.md', content: DRAFT }, 'call-write_file-draft'),
      say('Draft reply in support/T-1042-reply-draft.md (not sent): 2 payment timeouts, 1 expired token.'),
    ]);
    expect(shown(h.requests, 2)).toContain('{"E_TIMEOUT":2,"E_AUTH":1}');
    // Artifact check: the counts and times in the draft are recomputed from the log.
    const errors = LOG.split('\n').filter(line => line.includes(' ERROR '));
    const draft = await h.read('support/T-1042-reply-draft.md');
    expect(Number(/(\d+) payment timeouts/.exec(draft)?.[1])).toBe(errors.filter(line => line.includes('E_TIMEOUT')).length);
    expect(Number(/(\d+) expired sign-in token/.exec(draft)?.[1])).toBe(errors.filter(line => line.includes('E_AUTH')).length);
    // Every time the draft names is the time of an error in the log, and together they are all of the log's errors.
    const times = [...draft.matchAll(/\d\d:\d\d:\d\dZ/g)].map(match => match[0]);
    expect(times.sort()).toEqual(errors.map(line => line.slice(11, 20)).sort());
    expect(draft.startsWith('DRAFT (not sent)')).toBe(true);
    // A draft is not a send: the one messaging tool offered reaches teammates only, never the customer.
    const tools = h.requests[0].tools.map((tool: { function: { name: string; description: string } }) => tool.function);
    expect(tools.filter((tool: { name: string }) => /mail|message|sms|webhook/i.test(tool.name)).map((tool: { name: string }) => tool.name)).toEqual(['send_message']);
    expect(tools.find((tool: { name: string }) => tool.name === 'send_message').description).toContain('it cannot contact external people or services');
  }, 60_000);

  it('PM / Solo: Solo, which the preset factory adds to every team, does a small task itself and writes a PDF that the product\'s own reader opens with the right count', async () => {
    const member = await presetMember('business-operations', 'solo');
    expect(member.allowedTools).not.toContain('delegate');
    const TODO = [
      '# Launch checklist',
      '- [x] Price list approved', '- [x] Support macros written', '- [ ] Status page linked from the app',
      '- [x] Refund policy published', '- [ ] Billing alerts tested', '',
    ].join('\n');
    const pdf = {
      schema_version: 1, path: 'STATUS.pdf', format: 'pdf', template: 'report-v1',
      document: { title: 'LAUNCH STATUS', language: 'en', blocks: [
        { type: 'heading', level: 1, content: [{ text: 'OPEN ITEMS: 2' }] },
        { type: 'paragraph', content: [{ text: 'STATUS PAGE LINKED FROM THE APP' }] },
        { type: 'paragraph', content: [{ text: 'BILLING ALERTS TESTED' }] },
        { type: 'paragraph', content: [{ text: 'DONE: 3 OF 5' }] },
      ] },
    };
    const h = await work(member, { 'TODO.md': TODO }, 'Make me a one-page PDF of where the launch checklist stands.', [
      call('read_file', { path: 'TODO.md' }),
      call('write_document', pdf),
      say('STATUS.pdf: 2 items open, 3 of 5 done.'),
    ]);
    // Solo had no one to hand the work to and did it itself.
    expect(h.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain('dispatch_task');
    const bytes = await readFile(join(h.root, 'STATUS.pdf'));
    expect(bytes.subarray(0, 4).toString('hex')).toBe('25504446');
    const opened = await extractWorkspaceDocument(bytes);
    expect(opened.error).toBeUndefined();
    const open = TODO.split('\n').filter(line => line.startsWith('- [ ] '));
    const done = TODO.split('\n').filter(line => line.startsWith('- [x] '));
    expect(opened.text).toContain(`OPEN ITEMS: ${open.length}`);
    expect(opened.text).toContain(`DONE: ${done.length} OF ${open.length + done.length}`);
    for (const item of open) expect(opened.text).toContain(item.slice(6).toUpperCase());
  }, 60_000);
});
