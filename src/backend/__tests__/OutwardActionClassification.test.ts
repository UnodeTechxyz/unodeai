import { describe, expect, it } from 'vitest';
import { commandShellIdentity } from '../CommandShell';
import { classifyOutwardCommand } from '../OutwardActionClassification';
import { CommandPolicy } from '../CommandPolicy';

const posix = commandShellIdentity('bash', 'direct-fallback');
const powershell = commandShellIdentity('windows-powershell', 'direct-fallback');
const cmd = commandShellIdentity('cmd', 'direct-fallback');

describe('finite outward command classification', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('retains exact environment assignments from normalized wrappers on %s', platform => {
    const command = platform === 'linux' ? 'env HOME=/x git push' : 'ENV HOME=/x GIT push';
    for (const text of [command, '/usr/bin/env HOME=/x git push', 'CI=1 env.exe -- HOME=/x npx ovsx publish']) {
      expect(classifyOutwardCommand(text, posix, platform).operations[0]?.assignments)
        .toEqual(text.startsWith('CI=1') ? [['CI', '1'], ['HOME', '/x']] : [['HOME', '/x']]);
    }
  });
  it.each(['win32', 'darwin'] as const)('recognizes host-insensitive executable names under POSIX grammar on %s', platform => {
    for (const command of ['GIT push', 'Git push', 'NPM publish', '/opt/homebrew/bin/Gh pr create', 'env X=1 GIT push', 'ENV X=1 GIT.EXE push']) {
      const result = classifyOutwardCommand(command, posix, platform); expect(result.operations, command).toHaveLength(1);
      expect(result.operations[0].argv.join(' ')).toBe(command);
    }
  });
  it('retains case-sensitive POSIX names on Linux without weakening existing lowercase recognition', () => {
    expect(classifyOutwardCommand('GIT push', posix, 'linux').operations).toEqual([]);
    expect(classifyOutwardCommand('env X=1 git.exe push', posix, 'linux').operations[0]?.kind).toBe('push');
    expect(classifyOutwardCommand('git push', posix, 'linux').operations[0]?.executable).toBe('git');
  });
  it('retains upstream flags and the entire literal chain for a one-use action without expanding variable forms', () => {
    for (const flag of ['-u', '--set-upstream']) expect(classifyOutwardCommand(`git push ${flag} origin feature`, posix).operations)
      .toEqual([expect.objectContaining({ arguments: [flag, 'origin', 'feature'] })]);
    const command = 'git add -A && git commit -m fixture && git push -u origin feature';
    expect(classifyOutwardCommand(command, posix).operations).toEqual([expect.objectContaining({ segmentIndex: 2, arguments: ['-u', 'origin', 'feature'] })]);
    expect(classifyOutwardCommand('ovsx publish fixture.vsix -p $OVSX_PAT', posix).operations).toEqual([]);
  });
  it.each([
    ['git push', 'push'], ['npm publish', 'publish'], ['pnpm publish', 'publish'],
    ['yarn publish', 'publish'], ['yarn npm publish', 'publish'], ['vsce publish', 'publish'],
    ['ovsx publish', 'publish'], ['cargo publish', 'publish'], ['twine upload', 'publish'],
    ['dotnet nuget push', 'publish'], ['docker push', 'push'], ['podman push', 'push'],
    ['vercel deploy', 'deploy'], ['netlify deploy', 'deploy'], ['firebase deploy', 'deploy'],
    ['wrangler deploy', 'deploy'], ['gh release create', 'publish'], ['gh release upload', 'publish'],
    ['gh pr create', 'post'], ['gh pr comment', 'post'], ['gh pr review', 'post'],
    ['gh pr merge', 'publish'], ['gh issue create', 'post'], ['gh issue comment', 'post'],
  ])('recognizes %s as %s without executing it', (command, kind) => {
    const [executable, ...words] = command.split(' ');
    const result = classifyOutwardCommand(`${command} fixture-target`, posix);
    expect(result.literal).toBe(true);
    expect(result.operations).toEqual([expect.objectContaining({ executable,
      operation: words, kind, arguments: ['fixture-target'] })]);
  });

  it('keeps git destination, refs and global options intact behind literal env assignments', () => {
    const result = classifyOutwardCommand('env CI=1 TOKEN=fake-public -C nope', posix);
    expect(result.operations).toEqual([]);
    const command = 'env CI=1 TOKEN=fake-public git -C "/project with spaces" -c push.default=current --git-dir=.git --work-tree /work push origin HEAD:refs/heads/main';
    expect(classifyOutwardCommand(command, posix).operations).toEqual([{
      kind: 'push', executable: 'git', operation: ['push'],
      assignments: [['CI', '1'], ['TOKEN', 'fake-public']],
      argv: ['env', 'CI=1', 'TOKEN=fake-public', 'git', '-C', '/project with spaces', '-c', 'push.default=current',
        '--git-dir=.git', '--work-tree', '/work', 'push', 'origin', 'HEAD:refs/heads/main'],
      globalOptions: ['-C', '/project with spaces', '-c', 'push.default=current', '--git-dir=.git', '--work-tree', '/work'],
      arguments: ['origin', 'HEAD:refs/heads/main'], segmentIndex: 0,
    }]);
    expect(classifyOutwardCommand('env -- CI=1 git push origin main', posix).operations).toHaveLength(1);
  });

  it('retains separate outward effects in a literal chain after irrelevant newer segments', () => {
    const result = classifyOutwardCommand('echo latest; git status; npm install; git fetch; git push origin one && npm publish --registry https://registry.example', posix);
    expect(result.operations.map((operation) => [operation.segmentIndex, operation.executable, operation.arguments]))
      .toEqual([[4, 'git', ['origin', 'one']], [5, 'npm', ['--registry', 'https://registry.example']]]);
  });

  it('recognizes bare POSIX assignment prefixes and preserves them before env or a direct command', () => {
    const command = 'GIT_TRACE=1 EMPTY= git push origin HEAD:refs/heads/main';
    expect(classifyOutwardCommand(command, posix).operations).toEqual([expect.objectContaining({
      executable: 'git', argv: ['GIT_TRACE=1', 'EMPTY=', 'git', 'push', 'origin', 'HEAD:refs/heads/main'],
      arguments: ['origin', 'HEAD:refs/heads/main'],
    })]);
    expect(classifyOutwardCommand('CI=1 env TRACE=1 git push upstream topic', posix).operations)
      .toEqual([expect.objectContaining({ argv: ['CI=1', 'env', 'TRACE=1', 'git', 'push', 'upstream', 'topic'] })]);
    expect(classifyOutwardCommand('CI=1 EMPTY=', posix).operations).toEqual([]);
    expect(classifyOutwardCommand('7INVALID=1 git push', posix).operations).toEqual([]);
  });

  it('does not infer POSIX assignment-prefix semantics under PowerShell or cmd', () => {
    expect(classifyOutwardCommand('GIT_TRACE=1 git push', powershell).operations).toEqual([]);
    expect(classifyOutwardCommand('GIT_TRACE=1 git push', cmd).operations).toEqual([]);
  });

  it.each(['npx', 'npx -y', 'npx --yes', 'pnpm dlx', 'yarn dlx', 'bunx'])
    ('recognizes the finite package runner %s for listed executable and published package names', (runner) => {
      expect(classifyOutwardCommand(`${runner} ovsx publish extension.vsix`, posix).operations)
        .toEqual([expect.objectContaining({ executable: 'ovsx', arguments: ['extension.vsix'] })]);
      expect(classifyOutwardCommand(`${runner} @vscode/vsce publish --packagePath extension.vsix`, posix).operations)
        .toEqual([expect.objectContaining({ executable: 'vsce', arguments: ['--packagePath', 'extension.vsix'] })]);
    });

  it('maps only the written published package aliases to listed executable identities', () => {
    expect(classifyOutwardCommand('npx @vscode/vsce publish', posix).operations[0]?.executable).toBe('vsce');
    expect(classifyOutwardCommand('pnpm dlx firebase-tools deploy', posix).operations[0]?.executable).toBe('firebase');
    expect(classifyOutwardCommand('yarn dlx netlify-cli deploy', posix).operations[0]?.executable).toBe('netlify');
    expect(classifyOutwardCommand('bunx @yarnpkg/cli-dist npm publish', posix).operations[0]?.executable).toBe('yarn');
  });

  it('preserves assignments, runner flags and bounded package versions or tags in the complete argv', () => {
    const command = 'CI=1 env MODE=fixture npx --yes @vscode/vsce@latest publish --packagePath extension.vsix';
    expect(classifyOutwardCommand(command, posix).operations).toEqual([expect.objectContaining({
      executable: 'vsce', operation: ['publish'],
      argv: ['CI=1', 'env', 'MODE=fixture', 'npx', '--yes', '@vscode/vsce@latest', 'publish', '--packagePath', 'extension.vsix'],
      arguments: ['--packagePath', 'extension.vsix'], globalOptions: [],
    })]);
    expect(classifyOutwardCommand('npx ovsx@1.2.3-beta.1+fixture publish', posix).operations[0]?.executable).toBe('ovsx');
    expect(classifyOutwardCommand('bunx @yarnpkg/cli-dist@4.0.0 npm publish', posix).operations[0]?.executable).toBe('yarn');
    expect(classifyOutwardCommand('npx.cmd -y "@vscode/vsce@next" publish', powershell).operations[0]?.executable).toBe('vsce');
    expect(classifyOutwardCommand('npx.cmd -y @vscode/vsce@next publish', cmd).operations[0]?.executable).toBe('vsce');
  });

  it('accepts only the three written no-value git flags before push without consuming refs', () => {
    for (const flag of ['--no-pager', '-p', '--paginate']) {
      expect(classifyOutwardCommand(`git ${flag} -C repo push origin main`, posix).operations)
        .toEqual([expect.objectContaining({ globalOptions: [flag, '-C', 'repo'], arguments: ['origin', 'main'] })]);
    }
    expect(classifyOutwardCommand('GIT_TRACE=1 git --no-pager -p --paginate push origin main', posix).operations)
      .toEqual([expect.objectContaining({ globalOptions: ['--no-pager', '-p', '--paginate'], arguments: ['origin', 'main'] })]);
    expect(classifyOutwardCommand('npx git@latest --no-pager push origin main', posix).operations[0]?.executable).toBe('git');
  });

  it.each([
    'npx --package=@vscode/vsce vsce publish', 'npx -y --yes vsce publish', 'npx -p vsce publish',
    'pnpm exec vsce publish', 'yarn exec vsce publish', 'bun x vsce publish', 'bunx -y vsce publish',
    'npx npm run publish', 'npx pnpm dlx vsce publish', 'npx node -e "git push"', 'npx publish.sh',
    'npx ./vsce publish', 'npx tools/vsce publish', 'npx https://example.invalid/vsce publish',
    'npx @unlisted/vsce publish', 'npx @vscode/vsce/child publish', 'npx npm:vsce publish',
    'npx vsce@ publish', 'npx @vscode/vsce@ publish', 'npx vsce@https://example.invalid/pkg publish',
    'npx @vscode/vsce@npm:other publish', 'npx @vscode/vsce@@latest publish', 'npx vsce@latest/child publish',
    'git --no-pager=value push', 'git -P push',
  ])('does not guess unlisted runner, package or git forms: %s', (command) => {
    expect(classifyOutwardCommand(command, posix).operations).toEqual([]);
  });

  it.each([
    'git fetch origin', 'git pull', 'npm install', 'pnpm install', 'npm ci', 'npm run publish',
    'npm run deploy', 'git status', 'docker pull example', 'gh issue list', 'echo git push',
    'publish.sh', 'node script.js', 'node -e "git push"', 'cmd /c git push origin main',
    'powershell -c "git push"', 'bash -c "npm publish"', 'env -S "git push"', 'echo push',
    'env -i git push', 'git --unknown-option push', 'git -C', 'g push',
  ])('does not infer an outward operation from %s', (command) => {
    expect(classifyOutwardCommand(command, posix).operations).toEqual([]);
  });

  it.each(['git push $REMOTE', 'git push "${REMOTE}"', 'git push $(get-remote)',
    'git push | cat', 'git push > log', 'git "pu"sh', 'git push\nnpm publish', 'git push;'])
    ('leaves nonliteral shell syntax unclassified: %s', (command) => {
      expect(classifyOutwardCommand(command, posix)).toEqual({ literal: false, operations: [] });
    });

  it('uses the running grammar and accepts Windows direct executable spellings', () => {
    expect(classifyOutwardCommand('git.exe -C C:\\project push origin main', powershell)
      .operations[0]).toMatchObject({ executable: 'git', arguments: ['origin', 'main'] });
    expect(classifyOutwardCommand('"C:\\Program Files\\Git\\bin\\git.exe" -C C:\\project push origin main', cmd)
      .operations[0]).toMatchObject({ executable: 'git', arguments: ['origin', 'main'] });
    expect(classifyOutwardCommand('npm.cmd publish && git.exe push', cmd).operations).toHaveLength(2);
    // v0.9.101 S4.3: Claude's Bash on Windows uses the POSIX grammar and runs `git.exe push`.
    expect(classifyOutwardCommand('git.exe push origin main', posix).operations[0])
      .toMatchObject({ executable: 'git', arguments: ['origin', 'main'] });
    expect(classifyOutwardCommand('"/c/Program Files/Git/bin/git.exe" push origin main', posix).operations[0])
      .toMatchObject({ executable: 'git' });
    expect(classifyOutwardCommand('git.exe status', posix).operations).toEqual([]);
    expect(classifyOutwardCommand('git push && npm publish', powershell).literal).toBe(false);
    expect(classifyOutwardCommand('git push; npm publish', cmd).literal).toBe(false);
    expect(classifyOutwardCommand('env CI=1 git push', powershell).operations).toEqual([]);
    expect(classifyOutwardCommand('& "C:\\Program Files\\Git\\bin\\git.exe" push', powershell).literal).toBe(false);
  });

  it('adds no execution restriction or silent approval while classification is staged separately', () => {
    const policy = new CommandPolicy('all');
    expect(policy.check('git push origin main', { shell: posix })).toMatchObject({ allowed: true });
    expect(new CommandPolicy('none').check('git push origin main', { shell: posix })).toMatchObject({ allowed: false, disabled: true });
    expect(classifyOutwardCommand('git push origin main', { kind: 'provider-unknown', grammar: 'neutral' }))
      .toEqual({ literal: false, operations: [] });
  });
});
