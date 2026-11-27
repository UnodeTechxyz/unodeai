import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillRegistry, parseSkillMarkdown, copyNativeSkillProjection } from '../SkillRegistry';
import { snapshotSkillTree } from '../SkillResourceTree';
import { installedSkillFixture } from './skillResourceFixtures';
import { resourceText } from './skillResourceResultFixtures';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import type { AgentConfig } from '../../types';
const fixtures: Array<ReturnType<typeof installedSkillFixture>> = [];
const fixture = () => { const value = installedSkillFixture(); fixtures.push(value); return value; };
afterEach(() => { for (const value of fixtures.splice(0)) value.dispose(); });
const metadata = (text: string) => JSON.parse(text.split('\n')[0]);
it('S3 distinguishes obsolete saved grants from damaged installed resources through the actual registry tools', () => {
  const f = fixture();
  const registry = SkillRegistry.load(f.root);
  expect(registry.toolSpecs(['removed-skill'])).toEqual([]);
  expect(registry.promptBlock(['removed-skill'])).toBe('');
  const stale = registry.runTool('load_skill', { name: 'removed-skill' }, ['removed-skill'])!;
  expect(stale.output).toContain('not included in the installed version');
  expect(stale.output).not.toContain('Reinstall');
  fs.unlinkSync(path.join(f.skill, 'SKILL.md'));
  const damaged = SkillRegistry.load(f.root);
  expect(damaged.toolSpecs(['audit-skill'])).toHaveLength(2);
  expect(damaged.runTool('load_skill', { name: 'audit-skill' }, ['audit-skill'])!.output).toContain('Reinstalling UnodeAi');
  const missing = SkillRegistry.load(path.join(f.root, 'missing-installation'));
  expect(missing.toolSpecs(['audit-skill'])).toHaveLength(2);
  expect(missing.runTool('read_skill_file', { name: 'audit-skill', relpath: 'SKILL.md' }, ['audit-skill'])!.output).toContain('Reinstalling UnodeAi');
});
it('S3 fallback guidance names the actual host readers without depending on a native plugin command', () => {
  const f = fixture();
  const registry = SkillRegistry.load(f.root);
  const prompt = registry.promptBlock(['audit-skill'], { access: 'tools', loadTool: 'mcp__opaque__load_skill', readTool: 'mcp__opaque__read_skill_file' });
  expect(prompt).toContain('mcp__opaque__load_skill');
  expect(prompt).toContain('mcp__opaque__read_skill_file');
  expect(prompt).not.toContain('/unode');
});
// Split the exhaustive checks into independently timed cases; keep the same registry/tree captures and assertions.
const publishedCatalog = JSON.parse(fs.readFileSync(path.resolve('marketplace/skills.json'), 'utf8')) as Array<{ id: string }>;
let publishedRegistry: SkillRegistry | undefined;
const published = () => publishedRegistry ??= SkillRegistry.load(path.resolve('skills'));
const pinnedTrees = new Map<string, ReturnType<typeof snapshotSkillTree>>();
it('S3 published skill inventory has no installation issues', () => { expect(published().issues).toEqual([]); });
it.each(publishedCatalog)('S3 published skill $id loads with its original identity', entry => {
  const result = published().runTool('load_skill', { name: entry.id }, [entry.id])!;
  expect(result.status, entry.id + ': ' + result.output).toBe('success');
  expect(metadata(result.output).identity.status, entry.id).toBe('matches-bundled-record');
});
for (const [name, count] of [['docx', 61], ['pptx', 58]] as const) {
  const root = path.resolve('skills/documentation', name);
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'upstream-files.json'), 'utf8')) as {
    source_commit: string; files: Array<{ shipped_path: string; bytes: number; sha256: string }>;
  };
  it(`S3 pinned ${name} manifest retains its upstream commit and complete inventory`, () => {
    expect(provenance.source_commit).toBe('e4bb5d960d87126ff3b3a8af1a104b7db67560ba');
    expect(provenance.files).toHaveLength(count);
  });
  it.each(provenance.files)(`S3 pinned ${name} $shipped_path retains all original source bytes`, file => {
    let tree = pinnedTrees.get(name);
    if (!tree) { tree = snapshotSkillTree(root); pinnedTrees.set(name, tree); }
    expect(tree.inventory.find(item => item.path === file.shipped_path), file.shipped_path)
      .toMatchObject({ bytes: file.bytes, sha256: file.sha256 });
    const read = published().runTool('read_skill_file', { name, relpath: file.shipped_path }, [name])!;
    expect(read.status, file.shipped_path).toBe('success');
  });
}
it('a file changed during the actual load read makes only that skill unavailable without exposing a partial resource root', () => {
  const f = fixture();
  const good = path.join(f.root, 'rigor', 'good-skill');
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'SKILL.md'), '---\nname: good-skill\ndescription: Unaffected.\n---\nGood instructions.');
  const registry = SkillRegistry.load(f.root);
  const originalRead = fs.readSync;
  let changed = false;
  const spy = vi.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
    if (!changed) { changed = true; fs.appendFileSync(path.join(f.skill, 'SKILL.md'), '\nConcurrent change.'); }
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  try {
    const failed = registry.runTool('load_skill', { name: 'audit-skill' }, ['audit-skill', 'good-skill'])!;
    expect(changed).toBe(true);
    expect(failed.status).toBe('failed');
    expect(failed.output).toContain('Reinstalling UnodeAi');
    expect(failed.output).not.toContain('resource_root');
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect(registry.runTool('load_skill', { name: 'good-skill' }, ['good-skill'])!.status).toBe('success');
  expect(fs.existsSync(f.marker)).toBe(false);
});
it('real registry tool load returns the installed root, exact inventory and identity without imports, hooks or execution', () => { const f = fixture(); const registry = SkillRegistry.load(f.root); const result = registry.runTool('load_skill', { name: 'audit-skill' }, ['audit-skill'])!; expect(result.status, result.output).toBe('success'); const value = metadata(result.output); expect(value).toMatchObject({ resource_root: fs.realpathSync(f.skill), digest: snapshotSkillTree(f.skill).digest, identity: { status: 'matches-bundled-record', ignored_cache_present: false } }); expect(result.output).toContain('"path":"scripts/helper.cjs"'); expect(result.output).toContain('Original instruction body.'); expect(fs.existsSync(f.marker)).toBe(false); expect(registry.toolSpecs(['audit-skill']).map(spec => spec.function.name)).toEqual(['load_skill', 'read_skill_file']); });
it('reads ordinary helpers and binary metadata without executing or replacement decoding', () => { const f = fixture(); const registry = SkillRegistry.load(f.root); const source = registry.runTool('read_skill_file', { name: 'audit-skill', relpath: 'scripts/helper.cjs' }, ['audit-skill'])!; expect(resourceText(source.output)).toBe(fs.readFileSync(path.join(f.skill, 'scripts/helper.cjs'), 'utf8')); const binary = registry.runTool('read_skill_file', { name: 'audit-skill', relpath: 'asset.bin' }, ['audit-skill'])!; expect(JSON.parse(binary.output)).toMatchObject({ kind: 'binary', bytes: 3, resource_path: path.join(f.skill, 'asset.bin') }); expect(binary.output).not.toContain('\ufffd'); expect(binary.output).not.toContain('base64'); expect(fs.existsSync(f.marker)).toBe(false); expect(registry.runTool('load_skill', { name: 'audit-skill' }, []).status).toBe('refused'); });
it.each(['utf-16le', 'utf-16be'])('reports and actually decodes %s resource text', encoding => { const f = fixture(); const value = Buffer.from('Actual 中文', 'utf16le'); fs.writeFileSync(path.join(f.skill, 'encoded.txt'), Buffer.concat([Buffer.from(encoding === 'utf-16be' ? [254, 255] : [255, 254]), encoding === 'utf-16be' ? value.swap16() : value])); const registry = SkillRegistry.load(f.root); const result = registry.readFile('audit-skill', 'encoded.txt', ['audit-skill']); expect(metadata(result.output).encoding).toBe(encoding); expect(resourceText(result.output)).toBe('Actual 中文'); });
it('ignores runtime cache bytes above the tree limit while retaining honest cache presence and excluding cache reads', () => { const f = fixture(); const before = snapshotSkillTree(f.skill); fs.mkdirSync(path.join(f.skill, '__pycache__')); fs.writeFileSync(path.join(f.skill, '__pycache__', 'helper.pyc'), Buffer.alloc(5 * 1024 * 1024)); const after = snapshotSkillTree(f.skill); expect(after.digest).toBe(before.digest); expect(after.bytes).toBe(before.bytes); const registry = SkillRegistry.load(f.root); const result = registry.loadBody('audit-skill', ['audit-skill']); expect(metadata(result.output).identity).toMatchObject({ status: 'matches-bundled-record', ignored_cache_present: true }); expect(result.output).not.toContain('helper.pyc'); expect(registry.readFile('audit-skill', '__pycache__/helper.pyc', ['audit-skill']).status).toBe('failed'); });
it.each(['before-start', 'after-start'])('reports a valid modified installed file %s and uses current bytes without refusing other work', when => { const f = fixture(); const change = () => fs.writeFileSync(path.join(f.skill, 'scripts/helper.cjs'), 'Changed source data'); if (when === 'before-start') change(); const registry = SkillRegistry.load(f.root); if (when === 'after-start') change(); const result = registry.loadBody('audit-skill', ['audit-skill']); expect(result.status, result.output).toBe('success'); expect(metadata(result.output).identity.status).toBe('modified'); expect(result.output).toContain('Reinstalling UnodeAi'); expect(resourceText(registry.readFile('audit-skill', 'scripts/helper.cjs', ['audit-skill']).output)).toBe('Changed source data'); });
it.each(['missing', 'unreadable'])('missing or %s identity record never becomes a false published match or activation crash', mode => { const f = fixture(); if (mode === 'missing') fs.unlinkSync(path.join(f.root, 'resource-manifest.json')); else fs.writeFileSync(path.join(f.root, 'resource-manifest.json'), '{'); const registry = SkillRegistry.load(f.root); const result = registry.loadBody('audit-skill', ['audit-skill']); expect(result.status).toBe('success'); expect(metadata(result.output).identity.status).toBe('unknown'); expect(result.output).toContain('cannot be reported as published'); });
it.each(['over-limit', 'link', 'duplicate', 'category-link'])('confines an installed %s problem to the affected skill and keeps an unrelated skill usable', mode => { const f = fixture(); const good = path.join(f.root, 'rigor', 'good-skill'); fs.mkdirSync(good); fs.writeFileSync(path.join(good, 'SKILL.md'), '---\nname: good-skill\ndescription: Good.\n---\nUnaffected body.'); if (mode === 'over-limit') fs.writeFileSync(path.join(f.skill, 'large.bin'), Buffer.alloc(5 * 1024 * 1024)); if (mode === 'link') fs.symlinkSync(good, path.join(f.skill, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); if (mode === 'duplicate') { const duplicate = path.join(f.root, 'other', 'audit-skill'); fs.mkdirSync(duplicate, { recursive: true }); fs.writeFileSync(path.join(duplicate, 'SKILL.md'), f.markdown); } if (mode === 'category-link') fs.symlinkSync(path.join(f.root, 'rigor'), path.join(f.root, 'linked-category'), process.platform === 'win32' ? 'junction' : 'dir'); const registry = SkillRegistry.load(f.root); expect(registry.issues.length).toBeGreaterThan(0); expect(registry.loadBody('good-skill', ['good-skill']).status).toBe('success'); if (mode !== 'category-link') { const failed = registry.loadBody('audit-skill', ['audit-skill']); expect(failed.status).toBe('failed'); expect(failed.output).toContain('Reinstalling UnodeAi'); } });
it('generated native discovery omits original body/metadata/resources and retains only two scalar fields plus real host tool names', () => { const f = fixture(); const registry = SkillRegistry.load(f.root); const projected = path.join(f.root, 'projection'); copyNativeSkillProjection(registry.grantedDocuments(['audit-skill'])[0], projected, { load: 'mcp__own__load_skill', read: 'mcp__own__read_skill_file' }); const markdown = fs.readFileSync(path.join(projected, 'SKILL.md'), 'utf8'); const parsed = parseSkillMarkdown(markdown); expect(parsed.frontmatterKeys).toEqual(['name', 'description']); expect(parsed.body).toContain('mcp__own__load_skill'); expect(parsed.body).toContain('mcp__own__read_skill_file'); expect(parsed.body).not.toContain('Original instruction body'); expect(parsed.body).not.toContain('helper.cjs'); expect(markdown).not.toContain('allowed-tools:'); expect(markdown).not.toContain('hooks:'); expect(fs.readdirSync(projected).sort()).toEqual(['SKILL.md', 'projection-report.json']); const report = JSON.parse(fs.readFileSync(path.join(projected, 'projection-report.json'), 'utf8')); expect(report.omitted_frontmatter_fields).toEqual(['license', 'allowed-tools', 'hooks']); expect(report.omitted_resource_paths).toContain('scripts/helper.cjs'); expect(fs.existsSync(f.marker)).toBe(false); });
it('HTTP discovery and actual turn routing load/read source and binary with Commands/Write/Read Off, while outside inputs remain denied', async () => {
  const f = fixture(); const workspace = path.join(f.root, 'workspace'); fs.mkdirSync(workspace); fs.writeFileSync(path.join(f.root, 'outside.txt'), 'PRIVATE OUTSIDE'); const seen: string[] = [];
  const config: AgentConfig = { id: 'skill-agent', name: 'Reader', role: 'reviewer', skill: '', provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', systemPrompt: 'Read only.', autoApprove: true, allowedTools: [], workingDirectory: workspace, playbooks: ['audit-skill'] };
  const calls = [{ name: 'load_skill', args: { name: 'audit-skill' } }, { name: 'read_skill_file', args: { name: 'audit-skill', relpath: 'scripts/helper.cjs' } }, { name: 'read_skill_file', args: { name: 'audit-skill', relpath: 'asset.bin' } }, { name: 'read_skill_file', args: { name: 'audit-skill', relpath: '../../outside.txt' } }];
  const backend = new OpenAICompatBackend(config, async (_url, init) => { const request = JSON.parse(init.body); expect(request.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['load_skill', 'read_skill_file'])); const results = request.messages.filter((message: any) => message.role === 'tool'); if (results.length) { const message = results.at(-1); const text = typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text ?? '').join(''); if (seen.length < results.length) seen.push(text); } const call = calls[results.length]; const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: 'resource-' + results.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'Resources read.' }; return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) }; });
  (backend as any).skillRegistry = SkillRegistry.load(f.root); const events: any[] = []; const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
  try { await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Read the granted skill and its resources.'); await done; expect(metadata(seen[0]).resource_root).toBe(fs.realpathSync(f.skill)); expect(resourceText(seen[1])).toContain('writeFileSync'); expect(JSON.parse(seen[2]).kind).toBe('binary'); expect(seen[3]).toContain('outside'); expect(seen.join('')).not.toContain('PRIVATE OUTSIDE'); expect(fs.existsSync(f.marker)).toBe(false); expect(events.filter(event => event.kind === 'tool_result').map(event => event.outcome.status)).toEqual(['success', 'success', 'success', 'refused']); } finally { await backend.stop(); }
});
