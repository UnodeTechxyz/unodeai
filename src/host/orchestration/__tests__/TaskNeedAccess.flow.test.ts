import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDocx, type DocumentZip } from '../../../content/document/DocxRenderer';
import type { CanonicalDocumentRequest } from '../../../content/document/DocumentContracts';
import { saveHost } from '../../../backend/__tests__/attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from '../../../backend/__tests__/pathSafetyFixtures';
import { SessionLocalReadScopeConsent } from '../../../backend/localReadScope';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig } from '../../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig, DelegationTaskScope } from '../../../types';

afterEach(removeTemporaryFolders);
/** What the host records: the physical path, whatever spelling (an 8.3 TEMP name) the call used. */
const physical = (target: string) => realpathSync.native(target);

const render = async (request: CanonicalDocumentRequest) => {
  const yazl = require('yazl') as { ZipFile: new () => DocumentZip };
  return renderDocx(request, () => new yazl.ZipFile());
};
const part = (target: string, text: string, final = false) => ({ schema_version: 1, path: target, format: 'docx', template: 'contract-v1',
  draft: 'summary', ...(final ? { final: true } : {}),
  document: { title: 'Summary', language: 'en', blocks: [{ type: 'clause', label: text, content: [{ text }] }] } });

/**
 * v0.9.101 (H1, the Owner 2026-11-07: "ask for access, never remove capability"). Field t2d: the contract was granted
 * and the output folder was not, so the task scope held no writable place and the teammate's whole write group,
 * write_document included, was removed. It never tried to save, nothing asked for the folder, and the job ended Partial.
 * Through the real adapter and the real file tools: the folder the task must write stays a pending need, the write
 * tools stay, a write there is refused `needs-access` and asks for the grant, the draft is prepared meanwhile, and a
 * grant made while the task runs is used by the same attempt.
 */
async function taskHost() {
  const h = await saveHost();
  const contractDir = await temporaryFolder('unode-need-contract-');
  const contract = path.join(contractDir, 'agreement.txt');
  await fs.writeFile(contract, 'The lessor leases GPUs.\n', 'utf8');
  const output = await temporaryFolder('unode-need-output-');
  const owner = new SessionLocalReadScopeConsent(async () => false);
  const config: AgentConfig = agentConfig('worker', { backend: 'openai-compat', workingDirectory: h.root });
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => h.root, roots: () => [h.root], additionalReadRoots: () => [], isTrusted: () => true }),
    fullFileAccess: () => false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    configForAgent: () => config,
    pathGrantsFor: (requestId) => (requestId ? owner.pathAccessFor(requestId) : []),
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const grant = (target: string, permission: 'read' | 'readwrite') => owner.requestPathAccess(target,
    { requestId: 'r1', isCurrent: () => true }, async () => ({ permission, lifetime: 'request' }));
  const tools = h.tools();
  const renderer = { render: vi.fn(render) };
  tools.setDocumentRenderer(renderer);
  tools.setLivePathAccess(() => owner.pathAccessFor('r1'));
  const offered: string[] = [];
  tools.setOutsideRootObserver((target) => { offered.push(target); });
  tools.beginTurn();
  const names = () => tools.specs().map((spec) => spec.function.name);
  return { h, contract, output, adapter, config, grant, tools, renderer, offered, names };
}

describe('a task keeps the tools its need calls for while a grant is missing (H1)', () => {
  it('t2d: contract granted, output not: write tools stay, the save asks for the folder, the draft waits, and a grant mid-task saves it once', async () => {
    const t = await taskHost();
    await t.grant(t.contract, 'read');
    const scope: DelegationTaskScope = { folderAccess: [{ path: t.contract, permission: 'read' }, { path: t.output, permission: 'readwrite' }] };
    const admitted = t.adapter.resolveTaskWorkspaceAccess(t.config, scope, 'r1');
    expect(admitted.reason).toBeUndefined();
    expect(admitted.access?.writeRoots).toEqual([]);
    expect(admitted.access?.pending?.writeRoots).toEqual([physical(t.output)]);
    expect(admitted.outOfReach).toEqual([physical(t.output)]);
    // What the coordinator is told was left out is exactly the pending need, so "asked for, usable once granted" holds.
    const pendingTargets = [...admitted.access!.pending!.writeRoots, ...admitted.access!.pending!.readRoots,
      ...admitted.access!.pending!.writeFiles.map((file) => file.realPath), ...admitted.access!.pending!.readFiles.map((file) => file.realPath)];
    expect([...new Set(pendingTargets)].sort()).toEqual([...admitted.outOfReach!].sort());
    t.tools.setTurnWorkspaceAccess(admitted.access);

    // The tools the task needs are declared although the folder is not granted yet.
    expect(t.names()).toEqual(expect.arrayContaining(['write_document', 'write_file', 'read_file']));
    expect(await t.tools.runText('read_file', { path: t.contract })).toContain('The lessor leases GPUs.');

    // A write there is refused for the grant it lacks, asks for it, and does nothing.
    const notes = path.join(t.output, 'notes.txt');
    const refused = await t.tools.run('write_file', { path: notes, content: 'x' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'needs-access' });
    expect(refused.output).toContain('UnodeAi has asked the user for access to it');
    expect(refused.output).toContain('The access it lacks is Read + Write.');
    expect(refused.output).toContain('Do not ask the user to open another window or to send the request again.');
    await expect(fs.stat(notes)).rejects.toThrow();
    expect(t.offered).toContain(notes);

    // The draft is prepared: each part is stored, and the destination gap is said once.
    const target = path.join(t.output, 'summary.docx');
    const first = await t.tools.run('write_document', part(target, 'Parties'));
    expect(first.status).toBe('success');
    expect(first.output).toContain('The destination cannot be saved yet');
    expect((await t.tools.run('write_document', part(target, 'Prices'))).status).toBe('success');
    const final = await t.tools.run('write_document', part(target, 'Risks', true));
    expect(final).toMatchObject({ status: 'refused', reason: 'needs-access' });
    // Audit H1-1: what the model actually reads names the missing access AND says the whole draft is kept and how to
    // save it without sending its blocks again.
    expect(final.output).toContain('The access it lacks is Read + Write.');
    expect(final.output).toContain('The document draft is kept with every part, including this call\'s blocks.');
    expect(final.output).toContain('final: true and no new blocks');
    expect(t.renderer.render).not.toHaveBeenCalled();
    await expect(fs.stat(target)).rejects.toThrow();

    // The grant arrives while the task runs: the same attempt saves the kept draft once, with every part once.
    await t.grant(t.output, 'readwrite');
    const saved = await t.tools.run('write_document', { schema_version: 1, path: target, format: 'docx', template: 'contract-v1',
      draft: 'summary', final: true, document: { title: 'Summary', language: 'en', blocks: [] } });
    expect(saved.status).toBe('success');
    expect(t.renderer.render).toHaveBeenCalledTimes(1);
    const rendered = t.renderer.render.mock.calls[0][0] as CanonicalDocumentRequest;
    expect(rendered.document.blocks.map((block) => JSON.stringify(block).match(/Parties|Prices|Risks/g)?.[0]))
      .toEqual(['Parties', 'Prices', 'Risks']);
    expect((await fs.readFile(target)).subarray(0, 2).toString()).toBe('PK');
    expect(await t.tools.run('write_file', { path: notes, content: 'now granted\n' })).toMatchObject({ status: 'success' });
    // A need met is no longer pending: the next admission holds it, and nothing is left out or offered.
    const met = t.adapter.resolveTaskWorkspaceAccess(t.config, scope, 'r1');
    expect(met.access?.writeRoots).toEqual([physical(t.output)]);
    expect(met.access?.pending).toBeUndefined();
    expect(met.outOfReach).toBeUndefined();
  });

  it('a task whose need holds no write keeps no write tools; a granted Read leaves a needed Write pending', async () => {
    const t = await taskHost();
    await t.grant(t.contract, 'read');
    const readOnly = t.adapter.resolveTaskWorkspaceAccess(t.config, { folderAccess: [{ path: t.contract, permission: 'read' }] }, 'r1');
    expect(readOnly.access?.pending).toBeUndefined();
    t.tools.setTurnWorkspaceAccess(readOnly.access);
    expect(t.names()).not.toContain('write_file');
    expect(t.names()).not.toContain('write_document');

    // Read on the folder does not meet a Write need: it stays pending, and the write is still refused for it.
    await t.grant(t.output, 'read');
    const both = t.adapter.resolveTaskWorkspaceAccess(t.config,
      { folderAccess: [{ path: t.contract, permission: 'read' }, { path: t.output, permission: 'readwrite' }] }, 'r1');
    expect(both.access?.readRoots).toEqual([physical(t.output)]);
    expect(both.access?.pending?.writeRoots).toEqual([physical(t.output)]);
    t.tools.setTurnWorkspaceAccess(both.access);
    expect(t.names()).toContain('write_file');
    expect(await t.tools.run('write_file', { path: path.join(t.output, 'a.txt'), content: 'x' }))
      .toMatchObject({ status: 'refused', reason: 'needs-access' });
  });

  it('hard limits stay: Folder Access and an untrusted workspace leave nothing pending', async () => {
    const t = await taskHost();
    const scope: DelegationTaskScope = { folderAccess: [{ path: t.output, permission: 'readwrite' }] };
    const confined: AgentConfig = { ...t.config, folderAccess: [{ path: t.h.root, permission: 'readwrite' }] };
    const limited = t.adapter.resolveTaskWorkspaceAccess(confined, scope, 'r1');
    expect(limited.access).toBeUndefined();
    expect(limited.outOfReach).toBeUndefined();
    const untrustedRuntime = (t.adapter as unknown as { runtime: CoordinatorRuntimePort }).runtime;
    const workspace = untrustedRuntime.workspace();
    untrustedRuntime.workspace = () => ({ ...workspace, isTrusted: () => false });
    // Outside folders and files are already rejected for an untrusted workspace; a share spelling, which is judged by its
    // spelling before any resolution, is refused too and offered nothing.
    expect(t.adapter.resolveTaskWorkspaceAccess(t.config, scope, 'r1').access).toBeUndefined();
    // A share spelling under this platform's grammar: a UNC path on Windows, `/net/<host>` under POSIX, where a
    // backslash is an ordinary file name character (Linux CI on af0686bf).
    const share = process.platform === 'win32' ? String.raw`\\fileserver.invalid\share\out` : '/net/fileserver.invalid/share/out';
    const remote = t.adapter.resolveTaskWorkspaceAccess(t.config, { folderAccess: [{ path: share, permission: 'readwrite' }] }, 'r1');
    expect(remote.access).toBeUndefined();
    // With trust, the same share spelling is a pending need a grant could open, still contacting no computer.
    untrustedRuntime.workspace = () => ({ ...workspace, isTrusted: () => true });
    const trusted = t.adapter.resolveTaskWorkspaceAccess(t.config, { folderAccess: [{ path: share, permission: 'readwrite' }] }, 'r1');
    expect(trusted.access).toMatchObject({ readRoots: [], writeRoots: [], pending: { writeRoots: [share] } });
  });

  it('a pending write is no command folder: commands keep the rule they had', async () => {
    const t = await taskHost();
    await t.grant(t.contract, 'read');
    const withNeed = t.adapter.resolveTaskWorkspaceAccess(t.config,
      { folderAccess: [{ path: t.contract, permission: 'read' }, { path: t.output, permission: 'readwrite' }] }, 'r1').access;
    const without = t.adapter.resolveTaskWorkspaceAccess(t.config, { folderAccess: [{ path: t.contract, permission: 'read' }] }, 'r1').access;
    t.tools.setTurnWorkspaceAccess(without);
    const commandsWithout = t.names().filter((name) => name.endsWith('_command'));
    t.tools.setTurnWorkspaceAccess(withNeed);
    expect(t.names().filter((name) => name.endsWith('_command'))).toEqual(commandsWithout);
    expect(withNeed?.commandCwd).toBeUndefined();
  });
});
