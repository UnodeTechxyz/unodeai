import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandShellIdentity } from '../CommandShell';
import { prepareOutwardBinding, prepareOutwardCommand } from '../OutwardActionPreparation';

const roots: string[] = [];
const shell = commandShellIdentity('bash', 'direct-fallback');
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-outward-proposal-'))); roots.push(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'), HOME: root, USERPROFILE: root };
  const git = (args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args,
    { cwd: root, env, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  const prepare = (command: string, patch: object = {}) => prepareOutwardCommand({ command, cwd: root, shell, environment: env, ...patch });
  const init = async () => {
    await git(['init', '-b', 'main']); await git(['config', 'user.email', 'public-fixture@example.invalid']);
    await git(['config', 'user.name', 'Public fixture']); await fs.writeFile(path.join(root, 'source.txt'), 'one');
    await git(['add', 'source.txt']); await git(['commit', '-m', 'public fixture']);
    await git(['remote', 'add', 'origin', 'https://example.invalid/Owner/Project.git']);
    await git(['config', 'branch.main.remote', 'origin']); await git(['config', 'branch.main.merge', 'refs/heads/main']);
  };
  const manifest = async (patch: object = {}) => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-package', version: '1.2.3', publisher: 'fixture-publisher', ...patch }));
    await fs.writeFile(path.join(root, 'index.js'), 'export const publicFixture = 1;');
  };
  return { root, env, git, prepare, init, manifest };
}

describe('local preparation of exact outward command proposals', () => {
  it.each(['npm install', 'git fetch origin', 'git pull', 'npx eslint .', 'vsce package', 'echo "git push"', 'node deploy.js'])
  ('leaves %s outside this closed action preparation without reading a working folder', async command => {
    expect((await prepareOutwardCommand({ command, cwd: '/not-a-real-working-folder', shell })).status).toBe('none');
  });

  it.each(['git push --dry-run', 'git push -n origin main', 'git push --dry-run -u origin main', 'git push --set-upstream --dry-run origin main', 'npm publish --dry-run', 'pnpm publish --dry-run=true',
    'npm publish --dry-run --ignore-scripts=true', 'pnpm publish --dry-run --ignore-scripts=false', 'npm publish --dry-run --no-ignore-scripts'])
  ('recognizes %s as an executable-specific preview without probing content or destination', async command => {
    expect((await prepareOutwardCommand({ command, cwd: '/not-a-real-working-folder', shell })).status).toBe('preview');
  });

  it.each(['git push origin main --dry-run --no-dry-run', 'git push --push-option --dry-run origin main',
    'git push -- origin main --dry-run', 'npm publish --tag --dry-run', 'npm publish --dry-run --dry-run=false',
    'twine upload -n name artifact.whl', 'docker push --dry-run fixture/image:latest'])
  ('does not misread a negation, value or literal operand in %s as a preview', async command => {
    expect((await prepareOutwardCommand({ command, cwd: '/not-a-real-working-folder', shell })).status).not.toBe('preview');
  });

  it.each(['git pull && git push origin main', 'cd elsewhere; git push origin main',
    'git remote set-url origin https://changed.invalid/repo; git push origin main', 'git push origin main; git push mirror main'])
  ('does not bind a chain to the original cwd or state: %s', async command => {
    const h = await fixture(); await h.init(); const result = await h.prepare(command);
    expect(result).toMatchObject({ status: 'unresolved', effects: [] });
    expect(result.reason).toContain('chains operations');
  });

  it('uses the real Git config and local refs for default pushes, and revalidates destination and commit changes', async () => {
    const h = await fixture(); await h.init();
    const ready = await h.prepare('git push'); const sha = await h.git(['rev-parse', 'HEAD']);
    expect(ready.status).toBe('ready');
    expect(ready.effects).toEqual([expect.objectContaining({ destination: 'https://example.invalid/Owner/Project.git',
      content: expect.stringContaining(`${sha}) → refs/heads/main`) })]);
    expect(await ready.revalidate()).toBe(true);
    await h.git(['remote', 'set-url', 'origin', 'https://changed.invalid/Other.git']);
    expect(await ready.revalidate()).toBe(false);
    const changed = await h.prepare('git push origin HEAD:refs/heads/release');
    expect(changed.effects[0].destination).toContain('changed.invalid');
    await fs.writeFile(path.join(h.root, 'source.txt'), 'two'); await h.git(['add', 'source.txt']); await h.git(['commit', '-m', 'second fixture']);
    expect(await changed.revalidate()).toBe(false);
  }, 30_000);

  it('prepares -u and --set-upstream pushes with their actual remote and refs without changing tracking config', async () => {
    const h = await fixture(); await h.init(); const before = await h.git(['config', '--local', '--list']);
    for (const flag of ['-u', '--set-upstream']) {
      const ready = await h.prepare(`git push ${flag} origin HEAD:refs/heads/feature`);
      expect(ready.status, ready.reason).toBe('ready');
      expect(ready.effects[0]).toMatchObject({ destination: 'https://example.invalid/Owner/Project.git', content: expect.stringContaining('refs/heads/feature') });
      expect(ready.effects[0].content).toContain(flag);
    }
    expect(await h.git(['config', '--local', '--list'])).toBe(before);
  });

  it('binds an unknown action to its captured command cwd and shell without vetoing changing metadata', async () => {
    const h = await fixture(); const nested = path.join(h.root, 'nested'); await fs.mkdir(nested);
    const input = { command: 'npm publish --registry=https://registry.invalid', cwd: h.root, shell: { ...shell }, environment: h.env };
    const unknown = await prepareOutwardCommand(input); expect(unknown.status).toBe('unresolved');
    expect(unknown.fingerprint).not.toBe((await h.prepare(input.command, { cwd: nested })).fingerprint);
    expect(unknown.fingerprint).not.toBe((await h.prepare('cargo publish')).fingerprint);
    expect(unknown.fingerprint).not.toBe((await h.prepare(input.command, { shell: { ...shell, fingerprint: 'other-host-shell' } })).fingerprint);
    const chain = 'git add -A && git push';
    expect((await h.prepare(chain)).fingerprint).not.toBe((await h.prepare(chain, { cwd: nested })).fingerprint);
    input.command = 'cargo publish'; input.cwd = nested; input.shell.fingerprint = 'caller-mutated-shell';
    await h.manifest(); expect(await unknown.revalidate()).toBe(true);
    const abort = new AbortController(); const retired = await h.prepare('cargo publish', { signal: abort.signal });
    abort.abort(); expect(await retired.revalidate()).toBe(false);
  });

  it.each(['replaced directory', 'retargeted folder alias'])('retires unknown effects when their approved cwd is a %s without re-probing publication metadata', async change => {
    const h = await fixture(); const first = path.join(h.root, 'first'); const second = path.join(h.root, 'second');
    await fs.mkdir(first); await fs.mkdir(second); let cwd = first;
    if (change === 'retargeted folder alias') {
      cwd = path.join(h.root, 'alias'); await fs.symlink(first, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const unknown = await h.prepare('git status && cargo publish', { cwd });
    expect(unknown.status).toBe('unresolved'); expect(await unknown.revalidate()).toBe(true);
    await fs.writeFile(path.join(first, 'package.json'), JSON.stringify({ name: 'changed-metadata', version: '1.0.0' }));
    expect(await unknown.revalidate()).toBe(true);
    if (change === 'replaced directory') { await fs.rename(first, first + '-old'); await fs.mkdir(first); }
    else { await fs.unlink(cwd); await fs.symlink(second, cwd, process.platform === 'win32' ? 'junction' : 'dir'); }
    expect(await unknown.revalidate()).toBe(false);
  });

  it('re-captures an initially unavailable cwd: still missing is left to the shell, appearing later is a changed folder (S4.2)', async () => {
    const h = await fixture(); const cwd = path.join(h.root, 'not-yet-created');
    const unknown = await h.prepare('cargo publish', { cwd }); expect(unknown.status).toBe('unresolved');
    // Still missing: the command cannot start there and fails with the shell's own error, nothing is invented.
    expect(await unknown.revalidate()).toBe(true);
    // It now resolves: it appeared after the approval and is never approved on the old path binding.
    await fs.mkdir(cwd); expect(await unknown.revalidate()).toBe(false);
  });

  it('retires a binding-only unknown-environment lease when its execution is stopped', async () => {
    const h = await fixture(); const abort = new AbortController();
    const binding = await prepareOutwardBinding({ command: 'cargo publish', cwd: h.root, shell, signal: abort.signal });
    expect(await binding.revalidate()).toBe(true); abort.abort(); expect(await binding.revalidate()).toBe(false);
  });

  it('retains all real push URLs, their case and the actual branch-specific push remote', async () => {
    const h = await fixture(); await h.init();
    await h.git(['remote', 'add', 'Publish', 'https://example.invalid/Some/Other.git']);
    await h.git(['config', 'branch.main.pushRemote', 'Publish']);
    await h.git(['config', '--add', 'remote.Publish.pushurl', 'https://one.invalid/Case/One.git']);
    await h.git(['config', '--add', 'remote.Publish.pushurl', 'https://two.invalid/Case/Two.git']);
    const ready = await h.prepare('git push');
    expect(ready.status).toBe('ready');
    expect(ready.effects.map(effect => effect.destination)).toEqual(['https://one.invalid/Case/One.git', 'https://two.invalid/Case/Two.git']);
    await h.git(['config', '--unset', 'branch.main.pushRemote']); await h.git(['config', 'remote.pushDefault', 'Publish']);
    expect((await h.prepare('git push')).effects.map(effect => effect.destination))
      .toEqual(['https://one.invalid/Case/One.git', 'https://two.invalid/Case/Two.git']);
  });

  it('resolves literal direct URL rewrites without lowercasing a case-sensitive repository path', async () => {
    const h = await fixture(); await h.init();
    await h.git(['config', 'url.https://rewritten.invalid/Owner/Case/.pushInsteadOf', 'shortcut:']);
    const ready = await h.prepare('git push shortcut:Project.git main');
    expect(ready.status, ready.reason).toBe('ready');
    expect(ready.effects[0].destination).toBe('https://rewritten.invalid/Owner/Case/Project.git');
  });

  it('preserves Git global directory/config/pager forms and ignores tracing without writing a trace file before approval', async () => {
    const h = await fixture(); await h.init();
    const trace = path.join(h.root, 'unexpected.trace');
    const ready = await h.prepare('GIT_TRACE=1 git --no-pager -C "." -c push.default=current push origin main',
      { environment: { ...h.env, GIT_TRACE: trace } });
    expect(ready.status).toBe('ready'); expect(ready.effects[0].content).toContain('refs/heads/main');
    expect(await fs.stat(trace).then(() => true, () => false)).toBe(false);
    expect((await h.prepare('HOME=/different git push origin main')).status).toBe('unresolved');
    expect((await h.prepare('PATH=/different npm publish --registry=https://registry.invalid')).status).toBe('unresolved');
  });

  it('captures all/tag/delete proposals and refuses implicit matching or executable remote helpers', async () => {
    const h = await fixture(); await h.init(); await h.git(['branch', 'other']); await h.git(['tag', 'v1']);
    const all = await h.prepare('git push origin --all');
    expect(all.status).toBe('ready'); expect(all.effects[0].content).toContain('refs/heads/other');
    const tags = await h.prepare('git push origin --tags'); expect(tags.effects[0].content).toContain('refs/tags/v1');
    const deletion = await h.prepare('git push origin --delete refs/heads/obsolete');
    expect(deletion.effects[0].content).toBe('delete refs/heads/obsolete\nOptions: --delete');
    expect((await h.prepare('git push origin :')).status).toBe('unresolved');
    expect((await h.prepare('git push "ext::not-a-program" main')).status).toBe('unresolved');
    expect((await h.prepare('git push origin --prune')).status).toBe('unresolved');
    expect((await h.prepare('git push origin --delete')).status).toBe('unresolved');
  }, 30_000);

  it('does not omit configured follow-tag, mirror or submodule effects from a branch-only proposal', async () => {
    const h = await fixture(); await h.init();
    await h.git(['config', 'push.followTags', 'true']);
    expect((await h.prepare('git push origin main')).status).toBe('unresolved');
    expect((await h.prepare('git push origin main --no-follow-tags')).status).toBe('ready');
    await h.git(['config', 'push.followTags', 'false']); await h.git(['config', 'remote.origin.mirror', 'true']);
    expect((await h.prepare('git push origin main')).status).toBe('unresolved');
    await h.git(['config', 'remote.origin.mirror', 'false']); await h.git(['config', 'push.recurseSubmodules', 'on-demand']);
    expect((await h.prepare('git push origin main')).status).toBe('unresolved');
  });

  it('uses the sole remote as the Git fallback without inventing an upstream for simple pushes', async () => {
    const h = await fixture(); await h.init();
    await h.git(['remote', 'rename', 'origin', 'Publish']); await h.git(['config', '--unset', 'branch.main.remote']);
    await h.git(['config', '--unset', 'branch.main.merge']); await h.git(['config', 'push.default', 'current']);
    expect((await h.prepare('git push')).effects[0].destination).toBe('https://example.invalid/Owner/Project.git');
    await h.git(['config', 'push.default', 'simple']); expect((await h.prepare('git push')).status).toBe('unresolved');
  });

  it('keeps credentials out of human-facing effects while binding the raw private destination', async () => {
    const h = await fixture(); await h.init();
    await h.git(['remote', 'set-url', 'origin', 'https://fixture-user:public-secret@example.invalid/Owner/Repo?token=fixture-token']);
    const ready = await h.prepare('git push origin main');
    expect(ready.status).toBe('ready');
    expect(ready.effects[0].destination).toBe('https://example.invalid/Owner/Repo');
    expect(JSON.stringify(ready.effects)).not.toMatch(/public-secret|fixture-token|fixture-user/);
    await h.git(['remote', 'set-url', 'origin', 'https://fixture-user:different-secret@example.invalid/Owner/Repo?token=fixture-token']);
    expect(await ready.revalidate()).toBe(false);
  });

  it('binds a local push destination by real identity and refuses unresolved relative repositories', async () => {
    const h = await fixture(); await h.init(); const destination = path.join(h.root, 'local-destination');
    await fs.mkdir(destination);
    await h.git(['remote', 'set-url', 'origin', destination]);
    const ready = await h.prepare('git push origin main');
    expect(ready.status).toBe('ready'); expect(ready.effects[0].destination).toBe(await fs.realpath(destination));
    await fs.rename(destination, destination + '-old'); await fs.mkdir(destination);
    expect(await ready.revalidate()).toBe(false);
    expect((await h.prepare('git push ../relative-repository main')).status).toBe('unresolved');
  });

  it('binds package publication to an explicit registry, actual manifest and source bytes without running lifecycle scripts', async () => {
    const h = await fixture(); await h.manifest({ scripts: { prepublishOnly: 'never-run-this-fixture-script' } });
    expect((await h.prepare('npm publish --registry=https://registry.invalid/path --tag next')).status).toBe('unresolved');
    const ready = await h.prepare('npm publish --registry=https://registry.invalid/path --tag next --ignore-scripts');
    expect(ready.status).toBe('ready'); expect(ready.effects[0]).toMatchObject({ destination: 'https://registry.invalid/path',
      content: expect.stringContaining('fixture-package@1.2.3') });
    expect(ready.effects[0].content).toContain('source inputs, not a prebuilt package archive');
    expect(await ready.revalidate()).toBe(true);
    await fs.writeFile(path.join(h.root, 'index.js'), 'export const publicFixture = 2;');
    expect(await ready.revalidate()).toBe(false);
    expect((await h.prepare('npm publish --ignore-scripts')).status).toBe('unresolved');
  });

  it('requires publishing lifecycle scripts to be explicitly disabled without accepting false or negated ignore flags', async () => {
    const h = await fixture(); const marker = path.join(h.root, 'script-must-not-run');
    for (const tool of ['npm', 'pnpm']) for (const hook of ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish']) {
      await h.manifest({ scripts: { [hook]: 'node -e "require(\'fs\').writeFileSync(\'script-must-not-run\', \'bad\')"' } });
      const base = `${tool} publish --registry=https://registry.invalid`;
      for (const suffix of ['', ' --ignore-scripts=false', ' --no-ignore-scripts', ' --ignore-scripts --ignore-scripts=false',
        ' --ignore-scripts=true --no-ignore-scripts', ' --no-ignore-scripts --ignore-scripts']) {
        const unresolved = await h.prepare(base + suffix);
        expect(unresolved.status, `${tool} ${hook}${suffix}`).toBe('unresolved');
        expect(unresolved.reason).toContain('separate ordinary command');
      }
      expect((await h.prepare(base + ' --ignore-scripts=true')).status).toBe('ready');
      expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    }
    await h.manifest({ scripts: { build: 'never-run-build', test: 'never-run-test' } });
    expect((await h.prepare('npm publish --registry=https://registry.invalid')).status).toBe('ready');
  });

  it('keeps source packaging redirects and extension prepublish hooks unresolved but accepts prepared VSIX bytes', async () => {
    const h = await fixture();
    await h.manifest({ publishConfig: { directory: 'dist' } });
    const pnpm = await h.prepare('pnpm publish --registry=https://registry.invalid --ignore-scripts');
    expect(pnpm.status).toBe('unresolved'); expect(pnpm.reason).toContain('actual publication folder');
    await fs.writeFile(path.join(h.root, 'prepared.vsix'), 'public prepared artifact bytes');
    for (const patch of [{ scripts: { 'vscode:prepublish': 'never-run-extension-build' } },
      { vsce: { readmePath: '../external-readme.md' } }, { vsce: { dependencies: false } }]) {
      await h.manifest(patch);
      for (const tool of ['vsce', 'ovsx']) {
        const source = await h.prepare(`${tool} publish`);
        expect(source.status, `${tool} ${JSON.stringify(patch)}`).toBe('unresolved');
        expect(source.reason).toContain('prepared VSIX');
        const ready = await h.prepare(tool === 'vsce' ? 'vsce publish --packagePath prepared.vsix' : 'ovsx publish prepared.vsix');
        expect(ready.status).toBe('ready'); expect(ready.effects[0].content).toContain('SHA-256');
      }
    }
    expect((await fs.readdir(h.root)).sort()).toEqual(['index.js', 'package.json', 'prepared.vsix']);
    await h.manifest({ vsce: {} });
    expect((await h.prepare('vsce publish')).status).toBe('ready');
  });

  it('does not mistake a default registry or plain registry flag for the configured scoped destination', async () => {
    const h = await fixture(); await h.manifest({ name: '@fixture/package', publishConfig: { registry: 'https://assumed.invalid' } });
    expect((await h.prepare('npm publish --registry=https://wrong-for-scope.invalid')).status).toBe('unresolved');
    const ready = await h.prepare('npm publish --@fixture:registry=https://scope.invalid');
    expect(ready.status).toBe('ready'); expect(ready.effects[0].destination).toBe('https://scope.invalid/');
  });

  it('binds explicit npm publishConfig only for an unscoped source and does not guess an archive namespace', async () => {
    const h = await fixture(); await h.manifest({ publishConfig: { registry: 'https://configured.invalid' } });
    expect((await h.prepare('npm publish')).effects[0].destination).toBe('https://configured.invalid/');
    await fs.writeFile(path.join(h.root, 'payload.tgz'), 'public fixture tarball bytes');
    expect((await h.prepare('npm publish payload.tgz --registry=https://registry.invalid')).status).toBe('unresolved');
    await h.manifest({ bundleDependencies: ['public-fixture-dependency'] });
    expect((await h.prepare('npm publish --registry=https://registry.invalid')).status).toBe('unresolved');
  });

  it('prepares VSCE and Open VSX source/wrapper actions and binds existing VSIX bytes without building one', async () => {
    const h = await fixture(); await h.manifest();
    const source = await h.prepare('npx @vscode/vsce publish');
    expect(source.status).toBe('ready'); expect(source.effects[0]).toMatchObject({ destination: 'https://marketplace.visualstudio.com/',
      content: expect.stringContaining('fixture-publisher.fixture-package@1.2.3') });
    await fs.writeFile(path.join(h.root, 'public-fixture.vsix'), 'public fixture archive');
    const artifact = await h.prepare('bunx ovsx publish public-fixture.vsix --registryUrl=https://registry.invalid');
    expect(artifact.status).toBe('ready'); expect(artifact.effects[0].content).toContain('SHA-256');
    await fs.writeFile(path.join(h.root, 'public-fixture.vsix'), 'PUBLIC fixture archive');
    expect(await artifact.revalidate()).toBe(false);
    expect((await h.prepare('pnpm dlx ovsx publish', { environment: { ...h.env, OVSX_REGISTRY_URL: 'https://configured.invalid/' } })).effects[0].destination)
      .toBe('https://configured.invalid/');
  });

  it('prepares explicit artifact uploads, but leaves implicit account/deployment defaults unresolved', async () => {
    const h = await fixture(); await fs.writeFile(path.join(h.root, 'fixture.whl'), 'public wheel bytes');
    await fs.writeFile(path.join(h.root, 'fixture.nupkg'), 'public nuget bytes');
    expect((await h.prepare('twine upload --repository-url https://packages.invalid fixture.whl')).status).toBe('ready');
    expect((await h.prepare('dotnet nuget push fixture.nupkg --source https://packages.invalid --no-symbols')).status).toBe('ready');
    for (const command of ['twine upload --repository fixture fixture.whl', 'dotnet nuget push fixture.nupkg --source feed-name',
      'docker push fixture/image:latest', 'vercel deploy', 'gh issue create', 'cargo publish']) {
      const result = await h.prepare(command); expect(result).toMatchObject({ status: 'unresolved', effects: [] });
      expect(result.reason).not.toContain('public wheel bytes');
    }
  });

  it('does not permit a consumed proposal to survive cancellation or caller mutation of its command', async () => {
    const h = await fixture(); await h.manifest(); const abort = new AbortController();
    const input = { command: 'ovsx publish', cwd: h.root, shell, environment: h.env, signal: abort.signal };
    const ready = await prepareOutwardCommand(input); input.command = 'git push somewhere';
    expect(ready.status).toBe('ready'); expect(await ready.revalidate()).toBe(true);
    abort.abort(); expect(await ready.revalidate()).toBe(false);
  });

  it('refuses unknown publishing options rather than preparing one package for a workspace-wide publication', async () => {
    const h = await fixture(); await h.manifest();
    expect((await h.prepare('npm publish --registry=https://registry.invalid --workspaces')).status).toBe('unresolved');
  });

  it('frames source file hashes independently so delimiter-like file bytes cannot preserve another tree identity', async () => {
    const h = await fixture(); await h.manifest();
    await fs.writeFile(path.join(h.root, 'a'), 'x\0file:b\0y');
    const first = await h.prepare('ovsx publish');
    await fs.writeFile(path.join(h.root, 'a'), 'x'); await fs.writeFile(path.join(h.root, 'b'), 'y');
    expect(await first.revalidate()).toBe(false);
  });

  it('keeps internal source links usable and binds their actual referent bytes and file mode', async () => {
    const h = await fixture(); await h.manifest(); const shared = path.join(h.root, 'shared');
    await fs.mkdir(shared); const file = path.join(shared, 'source.txt'); await fs.writeFile(file, 'public source');
    await fs.symlink(shared, path.join(h.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = await h.prepare('ovsx publish'); expect(before.status).toBe('ready');
    await fs.writeFile(file, 'PUBLIC source'); expect(await before.revalidate()).toBe(false);
    const modeBefore = await h.prepare('ovsx publish'); const mode = (await fs.stat(file)).mode;
    try { await fs.chmod(file, 0o444); expect((await fs.stat(file)).mode & 0o222).toBe(0);
      expect(await modeBefore.revalidate()).toBe(false); }
    finally { await fs.chmod(file, mode); }
  });

  it('does not scan outside or cyclic source links while preparing an outward action', async () => {
    const h = await fixture(); const source = path.join(h.root, 'package'); const outside = path.join(h.root, 'outside');
    await fs.mkdir(source); await fs.mkdir(outside);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', publisher: 'fixture', version: '1.0.0' }));
    await fs.writeFile(path.join(outside, 'private-shaped-public-fixture.txt'), 'only public test data');
    const link = path.join(source, 'link');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await h.prepare('ovsx publish', { cwd: source });
    expect(result.status).toBe('unresolved'); expect(result.reason).toContain('outside this package');
    await fs.unlink(link);
    await fs.symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    const cyclic = await h.prepare('ovsx publish', { cwd: source });
    expect(cyclic.status).toBe('unresolved'); expect(cyclic.reason).toContain('cyclic source links');
  });
});
