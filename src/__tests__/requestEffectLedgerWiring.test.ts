/*
 * v0.9.97 P5: how the extension wires the request effect ledger, held by its source because extension.ts needs a VS
 * Code host to run. Review resolution §2: "the effect ledger keeps the existing request authority" and takes host
 * facts only; file effects design §4: "one host effect ledger supplies ordinary, solo and coordinated request
 * closeout ... track successful commits and later observed restores/deletes ... never count attempts". What the
 * ledger, the session manager, the tools, the routes and the restore flow do with it runs in requestFileEffects,
 * WorkspaceToolsEffectLedger, nativeEffectGrades, CodexBackend (P5 block) and checkpointRestoreFlow.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('the extension feeds each request\'s closeout from the host\'s own observations only', () => {
  it('tells the session manager every effect the write policy observed, with the request the change was made for', () => {
    const policy = between('function makeFileWritePolicy(): FileWritePolicy {', '\n}\n');
    expect(policy).toMatch(/onEffect: \(effect\) => sessionManager\?\.noteFileEffect\(effect\.requestId, \{/);
    for (const field of ['key: effect.key,', 'operation: effect.operation,', 'grade: effect.grade,']) expect(policy, field).toContain(field);
  });

  it('names each agent\'s files relative to its own folder, and keeps its view of the policy for its recorded changes', () => {
    const view = between('const fileWrites = fileWritePolicy.forAgent({', 'const cliMayWrite');
    expect(view).toContain('base: agentCwd,');
    expect(view).toContain('agentFileWrites.set(scopedConfig.id, fileWrites);');
  });

  it('no longer counts a recorded checkpoint as a change of the request: an approval or a prepared diff is not an effect', () => {
    const recorder = between('function recordCheckpoint(entry: {', '\nfunction scheduleCheckpointSave');
    expect(recorder).not.toContain('noteWorkspaceChange');
    expect(recorder).not.toContain('noteFileEffect');
    // It names the request the change was made for, so a restore of it can be shown on that request's closeout.
    expect(recorder).toContain('const requestId = sessionManager.currentRequestId(entry.agentId);');
    expect(recorder).toContain('const requestPath = agentFileWrites.get(entry.agentId)?.effectPath(physicalTarget);');
    expect(recorder).toMatch(/request: \{ id: requestId, \.\.\.\(requestPath \? \{ path: requestPath \} : \{\}\) \}/);
  });

  it('revises the stored records of a request, and of no other, when its effects change', () => {
    expect(between("sessionManager.on('session.requestFileEffects', (e) => {", '});'))
      .toContain('showRequestFileEffects(e.data.requestId, e.data.changes);');
    const show = between('function showRequestFileEffects(', '\n}\n');
    expect(show).toContain('reviseForFileEffects(record, requestId, changes)');
    const revise = between('function reviseRequestCloseouts(', '\n}\n');
    expect(revise).toContain('for (const record of store.ofRequest(session.id, requestId)) {');
    expect(revise).toContain('if (record.requestId !== requestId) continue;');
    expect(revise).toContain('store.upsert(revised)');
  });

  it('shows a restore of the person on the requests whose changes it undid, as the restore ended', () => {
    const restore = between('async function restoreCheckpoint(c: Checkpoint)', '\n/**\n * v0.9.97: a restore undid');
    expect(restore).toMatch(/noteRestoreOnRequestCloseouts\(plan\.undoes, outcome\.status === 'restored'\s*\? \(content\.kind === 'absent' \? 'removed' : 'restored'\)\s*: outcome\.status === 'effect-uncertain' \? 'uncertain' : undefined\);/);
    const note = between('function noteRestoreOnRequestCloseouts(', '\n}\n');
    expect(note).toContain('if (sessionManager.noteFileRestored(request.id, request.path, outcome)) continue;');
    expect(note).toContain('reviseForRestore(record, request.id, request.path!, outcome)');
  });
});
