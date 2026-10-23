import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * v0.9.88 §5.11: `check:modal-safety` classifies every modal for the attention sound. These fixtures run the real
 * gate in its fixture mode on one planted source file.
 */
function runGate(
  source: string,
  allowlist: unknown[] = [],
  families: { spendAlerts?: unknown[]; silent?: unknown[] } = {},
): { ok: boolean; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'unode-modal-attention-'));
  try {
    writeFileSync(join(directory, 'fixture.ts'), source);
    const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'check-modal-safety.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        UNODE_MODAL_GATE_FIXTURE: '1',
        UNODE_MODAL_GATE_SOURCE_ROOT: directory,
        UNODE_MODAL_GATE_ALLOWLIST: JSON.stringify(allowlist),
        UNODE_MODAL_GATE_SPEND_ALERTS: JSON.stringify(families.spendAlerts ?? []),
        UNODE_MODAL_GATE_SILENT: JSON.stringify(families.silent ?? []),
      },
    });
    return { ok: result.status === 0, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const applyModal = (show: string) => `async function ask() {
  const choice = await ${show};
  if (choice !== 'Apply') return;
  await applyEffect();
}`;
const MODAL = "vscode.window.showWarningMessage('Apply it?', { modal: true }, 'Not now', 'Apply')";

describe('modal attention classification gate', () => {
  it('fails an unclassified modal', () => {
    const result = runGate(applyModal(MODAL));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('is neither a blocking prompt nor a user-opened dialog');
  });

  it('passes a modal routed through blockingPrompt', () => {
    expect(runGate(applyModal(`blockingPrompt('fixture:1', () => ${MODAL})`))).toMatchObject({ ok: true });
  });

  it('passes a user-opened modal listed with a reason, and fails one listed without a reason', () => {
    expect(runGate(applyModal(MODAL), [{ file: 'fixture.ts', prompt: 'Apply it?', reason: 'The user asked.' }]).ok).toBe(true);
    const unexplained = runGate(applyModal(MODAL), [{ file: 'fixture.ts', prompt: 'Apply it?', reason: ' ' }]);
    expect(unexplained.ok).toBe(false);
    expect(unexplained.output).toContain('has no reason');
  });

  it('fails a stale user-opened entry that matches no modal', () => {
    const stale = runGate(applyModal(`blockingPrompt('fixture:1', () => ${MODAL})`), [{ file: 'fixture.ts', prompt: 'Gone?', reason: 'Removed.' }]);
    expect(stale.ok).toBe(false);
    expect(stale.output).toContain('matches no modal');
  });

  it('accepts a broker modal only when every use of it goes through a broker route', () => {
    const brokerModal = `async function nativeChoice() {
  const choice = await ${MODAL};
  if (choice !== 'Apply') return { action: 'deny' };
  return { action: 'once' };
}`;
    expect(runGate(`${brokerModal}\nvoid brokeredApproval(request, 1000, () => nativeChoice());`).ok).toBe(true);
    const bypass = runGate(`${brokerModal}\nvoid brokeredApproval(request, 1000, () => nativeChoice());\nvoid nativeChoice();`);
    expect(bypass.ok).toBe(false);
    expect(bypass.output).toContain('is neither a blocking prompt nor a user-opened dialog');
  });

  // v0.9.89 §5.4/§7: two families that are neither approvals nor user-opened dialogs.
  const spendAlert = `async function showOverTargetModal() {
  const choice = await vscode.window.showWarningMessage('Over target', { modal: true }, 'Keep going', 'Stop this request');
  if (choice !== 'Stop this request') return;
  stop();
}`;
  const alerts = { spendAlerts: [{ file: 'fixture.ts', fn: 'showOverTargetModal', reason: 'Over-target reminder.' }] };

  it('passes a detached, sounding spend alert', () => {
    expect(runGate(`${spendAlert}
function onThreshold() { requireAttention('k'); void showOverTargetModal(); }`, [], alerts).ok).toBe(true);
  });

  it('fails a spend alert that a turn could await, or that opens without its chime', () => {
    const awaited = runGate(`${spendAlert}
async function onThreshold() { requireAttention('k'); await showOverTargetModal(); }`, [], alerts);
    expect(awaited.ok).toBe(false);
    expect(awaited.output).toContain('start it detached with `void`');
    const silent = runGate(`${spendAlert}
function onThreshold() { void showOverTargetModal(); }`, [], alerts);
    expect(silent.ok).toBe(false);
    expect(silent.output).toContain('opened without requireAttention');
  });

  it('keeps a silent post-turn decision silent', () => {
    const choice = (sound: string) => `async function offerChoice() {
  ${sound}
  const choice = await vscode.window.showInformationMessage('Choose', { modal: true }, 'Use token reminders only', 'Use Unode');
  if (choice !== 'Use Unode') return;
  apply();
}`;
    const silent = { silent: [{ file: 'fixture.ts', fn: 'offerChoice', reason: 'After a finished turn.' }] };
    expect(runGate(choice(''), [], silent).ok).toBe(true);
    const sounding = runGate(choice("requireAttention('k');"), [], silent);
    expect(sounding.ok).toBe(false);
    expect(sounding.output).toContain('is a silent post-turn decision but sounds');
  });
});
