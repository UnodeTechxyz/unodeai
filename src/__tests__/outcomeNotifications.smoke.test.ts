import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner report, v0.9.79 a13: "Shared-memory attestation is disabled until you trust this workspace" appeared in
 * the bottom-right corner, where nobody saw it. The outcome of a dialog or picker the user has just answered
 * belongs where their attention already is.
 *
 * Structural on purpose: no unit test can observe where VS Code draws a message. This file pins the previously
 * reported flow and the dialog that shipped two Cancel buttons; check:outcome-notices exhaustively classifies
 * every production message call and kills a planted unclassified toast.
 */
const source = readFileSync(resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`could not locate ${signature}`);
  const ends = ['\nasync function ', '\nfunction ', '\nexport '].map((marker) => source.indexOf(marker, start + signature.length)).filter((i) => i > 0);
  return source.slice(start, Math.min(...ends));
}

describe('outcome notifications appear where the user is looking', () => {
  it('Review Shared Memory routes every itemless outcome through the user result-style policy', () => {
    const body = functionBody('async function reviewSharedMemory(');
    const resultCalls = [...body.matchAll(/showResultNotice\((['"](?:information|warning|error)['"])[\s\S]*?\);/g)];
    expect(resultCalls.length).toBeGreaterThanOrEqual(6);
    const decisions = [...body.matchAll(/window\.show(?:Information|Warning)Message\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(decisions).toHaveLength(2);
    for (const args of decisions) expect(args).toContain('modal: true');
    expect(body).toContain("showWorkspaceBindingRequired('review shared memory')");
    const missingWorkspace = functionBody('async function showWorkspaceBindingRequired(');
    // This surface has Reload/Open buttons, so the result-style toggle must never intercept it.
    expect(missingWorkspace).toContain('vscode.window.showWarningMessage(');
    expect(missingWorkspace).toContain('modal: true');
    expect(missingWorkspace).not.toContain('showResultNotice(');
  });

  it('the cross-provider brief dialog is modal and has exactly one Cancel', () => {
    const body = functionBody('async function approveCoordinatorBriefEgress(');
    expect(body).toContain('modal: true');
    // VS Code adds Cancel to every modal. Passing another one rendered two.
    expect(body).not.toMatch(/'Cancel'/);
  });

  /**
   * Owner report, v0.9.80: the native-subagent warning's three actions folded in the editor-owned
   * notification row. Extensions cannot style that row, so its labels must stay compact while the
   * pre-click copy carries the per-agent scope that the old long action label used to communicate.
   */
  it('keeps native-subagent warning actions compact enough for a notification row', () => {
    const labels = ['STOP_AGENT_ACTION', 'DISABLE_NATIVE_SUBAGENTS_ACTION', 'LEARN_MORE_ACTION'].map((name) => {
      const match = source.match(new RegExp(`const ${name} = '([^']+)';`));
      if (!match) throw new Error(`could not locate ${name}`);
      return match[1];
    });
    const preFixLabels = ['Stop agent', 'Disable native subagents for this agent', 'Learn more'];
    const handler = functionBody('function handleClaudeUnmediatedToolUse(');
    const scopeCopy = "You can disable Claude's native subagents for this agent only.";

    expect(labels).toEqual(['Stop agent', 'Disable subagents', 'Learn more']);
    // This is a regression comparison with the folded pre-fix row, not a claimed VS Code cutoff.
    expect(labels.join('').length).toBeLessThan(preFixLabels.join('').length);
    expect(handler).toContain(scopeCopy);
    expect(handler.indexOf(scopeCopy)).toBeLessThan(handler.indexOf('showWarningMessage'));
  });
});
