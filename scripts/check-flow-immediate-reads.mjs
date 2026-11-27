#!/usr/bin/env node
// v0.9.104 D0.5 (ROADMAP item 12, test efficiency B): an activation flow asserts what the PM strip shows only after
// waiting for that state. The strip is drawn by its own update after the action that changes it, and the reloaded strip
// by a later store write; read at once, a check passes on a quiet machine and fails under load (the G4 race of 0.9.103).
//
// The rule, for each src/__tests__/Activated*.flows*.test.ts: an `expect(` line that reads the strip
// (`screen.strip()`) or the reloaded strip (`reloadedStrip()`) must follow a wait for that same reader. Walking back
// over the assertions just before it (they check the same moment), the first other code line must be a wait whose
// condition reads the same reader: `await untilCurrent(` / `await waitFor(` / `await pumpWhile(` (v0.9.105, the
// wall-clock pump wait) with it inside, or a `for`/`while` loop that pumps and tests it in its
// condition. A loop that only counts pumps waits for nothing in particular.
//   node scripts/check-flow-immediate-reads.mjs [--self-test]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const READERS = [/screen\.strip\(\)/, /reloadedStrip\(\)/];
const IS_WAIT = /\bawait\s+(?:untilCurrent|waitFor|pumpWhile)\s*\(|\b(?:for|while)\s*\(.*\)\s*await\s+screen\.pump\(\)/;

/**
 * What an `expect(` line asserts: its first argument, up to the comma or parenthesis that closes it at depth one. A
 * strip named only in the failure message (`expect(x, JSON.stringify({ strip: screen.strip() }))`) is not asserted.
 */
function assertedPart(line) {
  const start = line.indexOf('expect(') + 'expect('.length;
  let depth = 1;
  let quote = '';
  for (let i = start; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) { depth -= 1; if (depth === 0) return line.slice(start, i); }
    else if (ch === ',' && depth === 1) return line.slice(start, i);
  }
  return line.slice(start);
}

/** The 1-based line numbers of strip assertions that read without first waiting for that reader. */
export function immediateReads(source) {
  const lines = source.split(/\r?\n/);
  const isCode = (line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  };
  const isAssertion = (line) => /^\s*expect\(/.test(line) || /^\s*[.)\]}]/.test(line);
  const findings = [];
  lines.forEach((line, index) => {
    if (!/^\s*expect\(/.test(line)) return;
    const asserted = assertedPart(line);
    for (const reader of READERS) {
      if (!reader.test(asserted)) continue;
      let i = index - 1;
      while (i >= 0 && (!isCode(lines[i]) || isAssertion(lines[i]))) i -= 1;
      const wait = i >= 0 ? lines[i] : '';
      // The wait's own condition (everything before its pump, or the helper's arguments) must read this reader.
      const condition = wait.split(/await\s+screen\.pump\(\)/)[0];
      if (!IS_WAIT.test(wait) || !reader.test(condition)) {
        findings.push(index + 1);
        break;
      }
    }
  });
  return findings;
}

function selfTest() {
  const planted = [
    'it("x", async () => {',
    '  await screen.send("go");',
    '  expect(screen.strip()).toEqual([]);', // 3: read straight after an action
    '  await untilCurrent(() => screen.strip(), (s) => s.length === 0, "empty");',
    '  expect(screen.strip()).toEqual([]);', // 5: after a wait for it
    '  expect(screen.strip().join(" ")).not.toContain("x");', // 6: the same moment as 5
    '  expect((await reloadedStrip()).lines).toEqual([]);', // 7: another reader, not waited for
    '  for (let i = 0; i < 9 && screen.strip().length; i++) await screen.pump();',
    '  expect(screen.strip()).toEqual([]);', // 9: after a conditioned pump loop
    '  for (let i = 0; i < 5; i++) await screen.pump();',
    '  expect(screen.strip()).toEqual([]);', // 11: after a loop that only counts
    '  for (let i = 0; i < 9 && !replies("pm").length; i++) await screen.pump();',
    '  expect(screen.strip()).toEqual([]);', // 13: after a wait for something else
    '  await untilCurrent(async () => (await reloadedStrip()).lines, (l) => l.length === 0, "stored");',
    '  expect((await reloadedStrip()).lines).toEqual([]);', // 15: after a wait for it
    '  await screen.send("next");',
    '  expect(replies("pm"), JSON.stringify({ strip: screen.strip() })).toEqual([]);', // 17: the strip only in the message
    '  await pumpWhile(() => screen.strip().length > 0, screen.pump);',
    '  expect(screen.strip()).toEqual([]);', // 19: after a wall-clock pump wait for it (v0.9.105)
    '  await pumpWhile(() => !replies("pm").length, screen.pump);',
    '  expect(screen.strip()).toEqual([]);', // 21: after a wall-clock pump wait for something else
    '});',
  ].join('\n');
  const found = immediateReads(planted);
  if (JSON.stringify(found) !== JSON.stringify([3, 7, 11, 13, 21])) throw new Error(`self-test: expected [3, 7, 11, 13, 21], got ${JSON.stringify(found)}`);
  console.log('check:flow-immediate-reads self-test passed (planted immediate reads fail; reads after a wait for the same reader pass).');
}

selfTest();
if (!process.argv.includes('--self-test')) {
  const dir = join(process.cwd(), 'src', '__tests__');
  const files = readdirSync(dir).filter((name) => /^Activated.*\.flows\.test\.ts$/.test(name)).sort();
  const problems = files.flatMap((name) => immediateReads(readFileSync(join(dir, name), 'utf8')).map((line) => `src/__tests__/${name}:${line}`));
  if (problems.length > 0) {
    console.error(`check:flow-immediate-reads failed: a PM strip assertion reads before waiting for that state (wait with untilCurrent):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`check:flow-immediate-reads passed (${files.length} activation flow files).`);
}
