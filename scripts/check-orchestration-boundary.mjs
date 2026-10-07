#!/usr/bin/env node
/**
 * Stop orchestration policy from drifting back into the extension composition root.
 *
 * The host adapter is deliberately testable without VS Code activation. Keeping its policy factories
 * in extension.ts would recreate the old boundary even if the adapter remained in the tree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMPOSITION_ROOT = join(ROOT, 'src', 'extension.ts');
const POLICY_NAMES = [
  'makeCoordinatorTeamTools',
  'makeTeamView',
  'storeDelegationContentSources',
  'resolveDelegationTaskWorkspaceAccess',
  'openRecordedWorkspaceFile',
];

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Exported for the planted-violation self-test and future direct unit coverage. */
export function orchestrationBoundaryViolations(source) {
  const code = withoutComments(source);
  return POLICY_NAMES.filter((name) => {
    const declaration = new RegExp(
      String.raw`\b(?:async\s+)?function\s+${name}\s*\(|\b(?:const|let|var)\s+${name}\s*=`,
    );
    return declaration.test(code);
  });
}

function selfTest() {
  const planted = orchestrationBoundaryViolations(`
    function makeCoordinatorTeamTools() {}
    const openRecordedWorkspaceFile = async () => undefined;
  `);
  if (planted.length !== 2 || !planted.includes('makeCoordinatorTeamTools') || !planted.includes('openRecordedWorkspaceFile')) {
    throw new Error('orchestration-boundary self-test failed: planted policy declarations escaped');
  }
  const commentsOnly = orchestrationBoundaryViolations(`
    // function makeTeamView() {}
    /* const resolveDelegationTaskWorkspaceAccess = () => undefined; */
  `);
  if (commentsOnly.length !== 0) {
    throw new Error('orchestration-boundary self-test failed: a comment was treated as a declaration');
  }
}

selfTest();
const violations = orchestrationBoundaryViolations(readFileSync(COMPOSITION_ROOT, 'utf8'));
if (violations.length > 0) {
  throw new Error(
    `check:orchestration-boundary failed; orchestration policy belongs in src/host/orchestration, not extension.ts:\n- ${violations.join('\n- ')}`,
  );
}
console.log('check:orchestration-boundary passed (extension.ts declares no orchestration policy functions).');
