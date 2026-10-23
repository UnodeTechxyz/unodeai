/*
 * v0.9.97 P4: how the extension wires `save_attachment` for the CLI routes, held by its source because extension.ts
 * needs a VS Code host to run (review resolution §2: Claude and Codex reach the same host tool through the existing
 * tool channel; file effects design §3: the card shows destination, type, size and SHA-256 instead of a text diff).
 * What the tools and bridges do with it runs in WorkspaceToolsSaveAttachment, ClaudeSaveAttachment and
 * CodexSaveAttachment.
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

describe('the extension gives Claude and Codex agents the host file tools save_attachment runs on', () => {
  it('builds them for a CLI agent that may write, with the write approval, write policy, request limit and attachment store', () => {
    expect(source).toMatch(/const hostFileTools = kind !== 'openai-compat' && cliMayWrite\s*\? cliHostFileTools\(\{/);
    const built = between('cliHostFileTools({\n        root: agentCwd,', '})');
    for (const field of [
      'writeRoots: trustedWriteRoots,', 'approveWrite: approveWriteForAgent,', 'fileWrites,', 'requestBoundary,',
      'contentAssets: delegationContentAssets,',
    ]) {
      expect(built, field).toContain(field);
    }
    const helper = between('function cliHostFileTools(', '\n}\n');
    // Records its changes as every host write does, asks the writeApproval setting, and refuses when untrusted.
    expect(helper).toContain('    recordCheckpoint,');
    expect(helper).toContain("() => configuredSetting<'none' | 'ask'>('writeApproval', 'none') === 'ask',");
    expect(helper).toContain('() => vscode.workspace.isTrusted,');
    expect(helper).toContain('tools.setFileWrites(options.fileWrites);');
    expect(helper).toContain('tools.setRequestBoundary(options.requestBoundary);');
    expect(helper).toContain('tools.setTaskInputResolver(taskInputResolver);');
    // It can write and nothing else: no command, message or read tool of these tools is offered anywhere.
    expect(helper).toContain("new Set(['write'])");
  });

  it('hands them to both CLI routes', () => {
    expect(between('return new CodexBackend(scopedConfig,', 'prepareFileCheckpoint:')).toMatch(/^\s+hostFileTools,$/m);
    expect(source).toContain('claudeDeps.hostFileTools = hostFileTools;');
  });

  it('shows a save\'s own preview on the write card and on the decision card, not a diff of decoded bytes', () => {
    expect(between('async function requestWriteApproval(', 'async function requestOverwriteDecision('))
      .toContain('const preview = req.preview ?? writeDiffPreview(req);');
    expect(between('async function requestOverwriteDecision(', 'async function overwriteDecisionChoice('))
      .toContain('const preview = req.preview ?? writeDiffPreview(req);');
  });

  it('admits a text attachment from the attachment itself, with its bytes', () => {
    // The turn's sources are built in userTurnSources (moved there from extension.ts with ATTACH-CODEX).
    const adapter = readFileSync(path.join(__dirname, '..', 'host', 'orchestration', 'OrchestrationHostAdapter.ts'), 'utf8');
    expect(source).toContain('await userTurnSources(delegationContentAssets, {');
    const from = adapter.indexOf('const delegationContentSources = await admitDelegationContentSources(');
    expect(from).toBeGreaterThan(-1);
    expect(adapter.slice(from, adapter.indexOf(');', from)))
      .toMatch(/contextManifestSources,\s*attachmentParts\.textFiles,\s*attachmentParts\.pdfs,\s*attachmentParts\.images,/);
  });
});
