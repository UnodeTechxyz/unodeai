import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalInstallNote, recognizeGlobalInstalls, type GlobalInstallContext } from '../GlobalInstallRecognition';
import { BASH_SHELL, CMD_SHELL, PWSH_SHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';

/* A project folder held only in memory: the recognition reads package.json, installed package manifests and
 * pyvenv.cfg through the injected reader, so no case depends on the machine. */
const ROOT = path.resolve(path.sep, 'work', 'project');
const files = new Map<string, string>([
  [path.join(ROOT, 'package.json'), JSON.stringify({
    name: 'fixture', dependencies: { lodash: '^4' }, devDependencies: { typescript: '^5', '@playwright/test': '^1', vitest: '^4' },
  })],
  [path.join(ROOT, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc', tsserver: './bin/tsserver' } })],
  [path.join(ROOT, 'node_modules', 'vitest', 'package.json'), JSON.stringify({ name: 'vitest', bin: './vitest.mjs' })],
  [path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({ name: '@playwright/test', bin: { playwright: 'cli.js' } })],
  [path.join(ROOT, 'pyenvs', 'tools', 'pyvenv.cfg'), 'home = /usr/bin\n'],
]);
const context: GlobalInstallContext = {
  cwd: ROOT, roots: [ROOT], platform: process.platform,
  readFile: async (file) => files.get(path.resolve(file)),
};
const families = async (command: string, shell = BASH_SHELL, extra: Partial<GlobalInstallContext> = {}) =>
  (await recognizeGlobalInstalls(command, shell, { ...context, ...extra })).map((install) => install.family);

describe('installs outside the project that the host recognises', () => {
  it.each([
    ['npm install -g typescript', 'package-manager-global'],
    ['npm i --global @anthropic-ai/claude-code', 'package-manager-global'],
    ['npm add -g cowsay', 'package-manager-global'],
    ['npm -g install cowsay', 'package-manager-global'],
    ['npm install --location=global cowsay', 'package-manager-global'],
    ['pnpm add -g cowsay', 'package-manager-global'],
    ['pnpm install --global cowsay', 'package-manager-global'],
    ['yarn global add cowsay', 'package-manager-global'],
    ['npx playwright install', 'playwright-browsers'],
    ['npx -y playwright install chromium', 'playwright-browsers'],
    ['npx @playwright/test install', 'playwright-browsers'],
    ['npm exec playwright install', 'playwright-browsers'],
    ['pnpm exec playwright install --with-deps', 'playwright-browsers'],
    ['python -m playwright install', 'playwright-browsers'],
    ['python3 -m playwright install firefox', 'playwright-browsers'],
    ['playwright install', 'playwright-browsers'],
    ['npx playwright install-deps', 'system-package-manager'],
    ['winget install Git.Git', 'system-package-manager'],
    ['choco install nodejs', 'system-package-manager'],
    ['scoop install gh', 'system-package-manager'],
    ['pip install requests', 'pip-outside-venv'],
    ['pip3 install --user requests', 'pip-outside-venv'],
    ['pip3.12 install requests', 'pip-outside-venv'],
    ['python -m pip install requests', 'pip-outside-venv'],
    ['py -m pip install -r requirements.txt', 'pip-outside-venv'],
    ['/usr/bin/pip install requests', 'pip-outside-venv'],
    ['pip install --target /opt/libs requests', 'pip-outside-venv'],
    ['npx cowsay hello', 'npx-undeclared'],
    ['npx -y create-vite@latest app', 'npx-undeclared'],
    ['npx eslint@8 .', 'npx-undeclared'],
    ['npx -p cowsay cowsay hi', 'npx-undeclared'],
    ['npx -c "cowsay hi"', 'npx-undeclared'],
    ['npx github:user/tool', 'npx-undeclared'],
    ['npm exec -- cowsay hi', 'npx-undeclared'],
    ['npm x cowsay', 'npx-undeclared'],
  ])('%s', async (command, family) => {
    expect(await families(command)).toEqual([family]);
  });

  it('reads the Windows shells too: an executable suffix, cmd.exe and PowerShell', async () => {
    expect(await families('npm.cmd install -g cowsay', CMD_SHELL)).toEqual(['package-manager-global']);
    expect(await families('winget.exe install Git.Git', WINDOWS_POWERSHELL_SHELL)).toEqual(['system-package-manager']);
    expect(await families('choco install nodejs -y', PWSH_SHELL)).toEqual(['system-package-manager']);
  });
});

describe('project-local and ordinary commands that it leaves alone', () => {
  it.each([
    'npm install',
    'npm install lodash',
    'npm install -D vitest',
    'npm ci',
    'npm run build',
    'npm test',
    'pnpm add zod',
    'yarn add zod',
    'npx tsc --noEmit',
    'npx vitest run',
    'npx typescript --version',
    'npx playwright test',
    'npx ./scripts/local-tool.js',
    'pnpm exec playwright test',
    'pip install --target ./vendor requests',
    'pip install -t vendor requests',
    'python -m venv .venv',
    '.venv/bin/pip install requests',
    '.venv/bin/python -m pip install -r requirements.txt',
    'venv\\Scripts\\pip.exe install requests',
    'pyenvs/tools/bin/pip install requests',
    'python -m venv .venv && .venv/bin/pip install requests',
    'source .venv/bin/activate && pip install requests',
    'pip list',
    'pip download requests',
    'winget list',
    'scoop search gh',
    'echo npm install -g cowsay',
    'git commit -m "npm install -g cowsay"',
  ])('%s', async (command) => {
    expect(await families(command)).toEqual([]);
  });

  // A destination the command names decides before the interpreter: a project venv's pip installs where it is told.
  it.each([
    ['.venv/bin/pip install --target ../user-site-packages requests', 'pip-outside-venv'],
    ['.venv/Scripts/pip.exe install --prefix ../global-python-prefix requests', 'pip-outside-venv'],
    ['.venv/bin/pip install --prefix=/opt/python requests', 'pip-outside-venv'],
    ['.venv/bin/pip install --root / requests', 'pip-outside-venv'],
    ['.venv/bin/pip install -t../out requests', 'pip-outside-venv'],
    ['.venv/bin/python -m pip install --user requests', 'pip-outside-venv'],
    ['pip install --target ./vendor --prefix ../elsewhere requests', 'pip-outside-venv'],
    ['PIP_TARGET=../out .venv/bin/pip install requests', 'pip-outside-venv'],
    ['source .venv/bin/activate && pip install --target ../out requests', 'pip-outside-venv'],
    ['npm install --prefix ../other lodash', 'package-manager-global'],
    ['npm --prefix ../other install lodash', 'package-manager-global'],
    ['npm ci --prefix=/srv/app', 'package-manager-global'],
    ['npm_config_prefix=../other npm install lodash', 'package-manager-global'],
    ['npm_config_global=true npm install cowsay', 'package-manager-global'],
    ['pnpm add -C ../other zod', 'package-manager-global'],
    ['pnpm install --dir ../other', 'package-manager-global'],
    ['yarn add --cwd ../other zod', 'package-manager-global'],
    ['yarn --modules-folder /srv/node_modules install', 'package-manager-global'],
  ])('a destination outside the project asks: %s', async (command, family) => {
    expect(await families(command)).toEqual([family]);
  });

  it.each([
    '.venv/bin/pip install --target ./vendor requests',
    '.venv/Scripts/pip.exe install --prefix .venv-extra requests',
    'pip install --prefix ./local requests',
    'pip install -tvendor requests',
    'npm install --prefix ./packages/a lodash',
    'npm --prefix ./packages/a run build',
    'pnpm install --dir ./packages/a',
    'yarn add --cwd ./packages/a zod',
  ])('a destination inside the project does not: %s', async (command) => {
    expect(await families(command)).toEqual([]);
  });

  it('PIP_USER sends even an activated environment\'s pip to the user site-packages', async () => {
    expect(await families('PIP_USER=1 pip install requests', BASH_SHELL, { environment: { VIRTUAL_ENV: path.join(ROOT, '.venv') } }))
      .toEqual(['pip-outside-venv']);
  });

  it('reads the pip of an activated project environment as the project\'s', async () => {
    expect(await families('pip install requests', BASH_SHELL, { environment: { VIRTUAL_ENV: path.join(ROOT, '.venv') } })).toEqual([]);
    // An environment outside the agent's folders is not the project's.
    expect(await families('pip install requests', BASH_SHELL, { environment: { VIRTUAL_ENV: path.resolve(path.sep, 'elsewhere', 'venv') } }))
      .toEqual(['pip-outside-venv']);
  });

  it('does not take a virtual environment outside the project for the project\'s', async () => {
    expect(await families(`${path.resolve(path.sep, 'opt', 'venv', 'bin', 'pip')} install requests`)).toEqual(['pip-outside-venv']);
  });

  it('asks for every npx when the project\'s package.json cannot be read', async () => {
    expect(await families('npx tsc --noEmit', BASH_SHELL, { readFile: async () => undefined })).toEqual(['npx-undeclared']);
  });

  it('asks when the reads run out of time, instead of waiting for them', async () => {
    const never = () => new Promise<string | undefined>(() => undefined);
    expect(await families('npx tsc', BASH_SHELL, { readFile: never, budgetMs: 20 })).toEqual(['npx-undeclared']);
  });
});

describe('a project folder whose name starts with two dots', () => {
  // v0.9.106 (chain on 22244944): containment is segment-aware. A child named `..cache` or `..venv` is inside the
  // project; only a real `..` segment leaves it.
  it.each([
    ['pip install --target ./..vendor requests'],
    ['pip install --prefix ..cache/py requests'],
    ['npm install --prefix ..cache lodash'],
  ])('%s stays project-local: no card', async (command) => {
    expect(await families(command)).toEqual([]);
  });

  it.each([
    ['pip install --target ../outside requests', 'pip-outside-venv'],
    ['npm install --prefix ../outside lodash', 'package-manager-global'],
  ])('%s leaves the project: one card', async (command, family) => {
    expect(await families(command)).toEqual([family]);
  });
});

describe('a command of several parts', () => {
  it.each([
    ['npm test && npm install -g cowsay', ['package-manager-global']],
    ['npm test; pip install requests', ['pip-outside-venv']],
    ['npm ci && npx playwright install && npm test', ['playwright-browsers']],
    // A pipe, a redirect or `||` puts the command outside the policy's literal reading; it is still read for installs.
    ['npm install -g cowsay | tee install.log', ['package-manager-global']],
    ['npm test || npm i -g cowsay', ['package-manager-global']],
    ['npx playwright install > out.txt 2>&1', ['playwright-browsers']],
    ['CI=1 npm install -g cowsay', ['package-manager-global']],
    ['env CI=1 pip install requests', ['pip-outside-venv']],
    ['bash -lc "npm install -g cowsay"', ['package-manager-global']],
    ['winget install Git.Git && npm install -g cowsay', ['system-package-manager', 'package-manager-global']],
  ])('%s', async (command, expected) => {
    expect(await families(command)).toEqual(expected);
  });

  it('reads a cmd.exe chain and an inline cmd /c', async () => {
    expect(await families('npm test && npm install -g cowsay', CMD_SHELL)).toEqual(['package-manager-global']);
    expect(await families('cmd /c npm install -g cowsay', PWSH_SHELL)).toEqual(['package-manager-global']);
  });
});

describe('the note on the card', () => {
  it('names the command, where it installs and the size where known', async () => {
    const installs = await recognizeGlobalInstalls('npm i -g cowsay && npx playwright install', BASH_SHELL, { ...context, platform: 'win32',
      cwd: 'C:\\work\\project', roots: ['C:\\work\\project'], readFile: async () => undefined });
    const note = globalInstallNote(installs);
    expect(note).toContain('- npm i -g cowsay\n  Installs to: npm\'s global folder');
    expect(note).toContain('Size: size unknown.');
    expect(note).toContain('- npx playwright install\n  Installs to: the Playwright browser cache in your user profile (%LOCALAPPDATA%\\ms-playwright)');
    expect(note).toContain('several hundred MB');
    expect(note).toContain('If you deny it, nothing is installed and the agent continues');
  });
});
