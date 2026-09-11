import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = process.cwd();

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && file.endsWith('.ts') ? [file] : [];
  });
}

function firstArgument(text, openParen) {
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
      if (depth === 0) return text.slice(openParen + 1, at).trim();
      continue;
    }
    if (char === ',' && depth === 1) return text.slice(openParen + 1, at).trim();
  }
  return undefined;
}

function isSubstitutionFreeLiteral(value) {
  return /^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`$\\])*`)$/.test(value);
}

/** Every branded detail must be a literal, not an interpolated host or user value. */
export function refusalDetailLiteralViolations(text, file = '<inline>') {
  const violations = [];
  const calls = /\bhostToolRefusalDetail\s*\(/g;
  for (let match; (match = calls.exec(text));) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (/\bfunction\s*$/.test(before)) continue;
    const openParen = text.indexOf('(', match.index);
    const argument = firstArgument(text, openParen);
    if (argument === undefined || !isSubstitutionFreeLiteral(argument)) {
      violations.push(`${file}:${match.index}: hostToolRefusalDetail requires a substitution-free string literal`);
    }
  }
  return violations;
}

function selfTest() {
  if (refusalDetailLiteralViolations("hostToolRefusalDetail('safe')").length !== 0) {
    throw new Error('refusal-detail literal gate self-test failed: a string literal was rejected');
  }
  if (!refusalDetailLiteralViolations('hostToolRefusalDetail(`unsafe ${path}`)').length) {
    throw new Error('refusal-detail literal gate self-test failed: an interpolated detail was accepted');
  }
}

selfTest();
const violations = sourceFiles(resolve(root, 'src'))
  .flatMap((file) => refusalDetailLiteralViolations(readFileSync(file, 'utf8'), relative(root, file)));
if (violations.length) {
  throw new Error(`check:refusal-detail-literals failed:\n- ${violations.join('\n- ')}`);
}
console.log('check:refusal-detail-literals passed (all refusal details are substitution-free literals).');
