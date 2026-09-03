#!/usr/bin/env node
/**
 * Webviews inherit VS Code themes through CSS variables. Bare colour literals bypass that contract, so
 * this ratchet rejects new ones while recording the deliberate legacy baseline for panels not in scope.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VIEWS = join(ROOT, 'src', 'views');
const BASELINES = new Map([
  ['TeamViewProvider.ts', 89],
  ['SettingsPanel.ts', 15],
  ['ChatViewProvider.ts', 5],
  ['MessageLogProvider.ts', 5],
  ['AgentBuilderPanel.ts', 2],
  ['MarketplacePanel.ts', 1],
  ['DashboardProvider.ts', 0],
]);
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;

function lineForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function closingParen(text, openParen) {
  let quote;
  let depth = 1;
  for (let at = openParen + 1; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === '\\') { at++; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') { depth++; continue; }
    if (char === ')') {
      depth--;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** Ranges occupied by a var() fallback argument. Those literals are correct compatibility fallbacks. */
function varFallbackRanges(text) {
  const ranges = [];
  const calls = /\bvar\s*\(/g;
  for (let match; (match = calls.exec(text));) {
    const open = text.indexOf('(', match.index);
    const close = closingParen(text, open);
    if (close < 0) continue;
    let depth = 1;
    let comma = -1;
    let quote;
    for (let at = open + 1; at < close; at++) {
      const char = text[at];
      if (quote) {
        if (char === '\\') { at++; continue; }
        if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
      if (char === '(') { depth++; continue; }
      if (char === ')') { depth--; continue; }
      if (char === ',' && depth === 1) { comma = at; break; }
    }
    if (comma >= 0) ranges.push({ start: comma + 1, end: close });
    calls.lastIndex = close + 1;
  }
  return ranges;
}

/** Bare hex literals, with line numbers for a useful gate failure. */
export function bareThemeTokenLiterals(text) {
  const fallbackRanges = varFallbackRanges(text);
  return [...text.matchAll(HEX_LITERAL)]
    .filter((match) => !fallbackRanges.some((range) => (match.index ?? -1) >= range.start && (match.index ?? -1) < range.end))
    .map((match) => ({ literal: match[0], line: lineForOffset(text, match.index ?? 0) }));
}

export function evaluateThemeTokenRatchet(files, baselines = BASELINES) {
  const violations = [];
  const tightenings = [];
  for (const [file, text] of files) {
    const literals = bareThemeTokenLiterals(text);
    const baseline = baselines.get(file) ?? 0;
    if (literals.length > baseline) {
      violations.push({ file, count: literals.length, baseline, literals });
    } else if (literals.length < baseline) {
      tightenings.push(`ratchet can tighten: ${file} is now ${literals.length}, baseline ${baseline}`);
    }
  }
  return { violations, tightenings };
}

function printTightenings(tightenings, write = console.log) {
  for (const line of tightenings) write(line);
}

function selfTest() {
  const bare = evaluateThemeTokenRatchet(new Map([['Demo.ts', 'color: #abc;']]), new Map([['Demo.ts', 0]]));
  if (bare.violations.length !== 1 || bare.violations[0].literals[0].line !== 1) {
    throw new Error('webview theme-token gate self-test failed: planted bare literal was not rejected');
  }
  const fallback = evaluateThemeTokenRatchet(
    new Map([['Demo.ts', 'color: var(--vscode-foreground, #fff);']]),
    new Map([['Demo.ts', 0]]),
  );
  if (fallback.violations.length !== 0) {
    throw new Error('webview theme-token gate self-test failed: var() fallback was rejected');
  }
  const below = evaluateThemeTokenRatchet(new Map([['Demo.ts', 'color: #abc;']]), new Map([['Demo.ts', 2]]));
  const printed = [];
  printTightenings(below.tightenings, (line) => printed.push(line));
  if (below.violations.length !== 0 || printed[0] !== 'ratchet can tighten: Demo.ts is now 1, baseline 2') {
    throw new Error('webview theme-token gate self-test failed: lower count did not print the tightening instruction');
  }
}

selfTest();
const files = new Map(
  readdirSync(VIEWS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => [entry.name, readFileSync(join(VIEWS, entry.name), 'utf8')]),
);
const { violations, tightenings } = evaluateThemeTokenRatchet(files);
if (violations.length) {
  const detail = violations.map(({ file, count, baseline, literals }) =>
    `${file}: ${count} bare hex literal(s), baseline ${baseline}\n${literals.map(({ line, literal }) => `  line ${line}: ${literal}`).join('\n')}`,
  );
  throw new Error(`check:webview-theme-tokens failed:\n${detail.join('\n')}`);
}
printTightenings(tightenings);
console.log('check:webview-theme-tokens passed (no view exceeds its bare-literal baseline).');
