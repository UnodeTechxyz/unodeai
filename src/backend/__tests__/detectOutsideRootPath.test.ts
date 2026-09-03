import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { detectOutsideRootPath } from '../WorkspaceTools';

const ROOT = process.platform === 'win32' ? 'C:\\AI_Program\\Unode' : '/work/roam';
const outsideDrive = process.platform === 'win32' ? 'C:\\AI_Program\\ux-scratch\\src\\mathUtils.js' : '/other/ux-scratch/src/mathUtils.js';

describe('detectOutsideRootPath', () => {
  it('flags an absolute path outside the root (the type/Get-Content escape)', () => {
    expect(detectOutsideRootPath(`type ${outsideDrive}`, ROOT)).toBeTruthy();
    expect(detectOutsideRootPath(`Get-Content ${outsideDrive}`, ROOT)).toBeTruthy();
  });

  it('allows an absolute path that is inside the root', () => {
    const inside = path.join(ROOT, 'src', 'foo.ts');
    expect(detectOutsideRootPath(`type ${inside}`, ROOT)).toBeUndefined();
  });

  it('allows an absolute path inside a second read root', () => {
    const second = process.platform === 'win32' ? 'C:\\AI_Program\\SharedLib' : '/work/shared-lib';
    const insideSecond = path.join(second, 'src', 'foo.ts');
    expect(detectOutsideRootPath(`type ${insideSecond}`, [ROOT, second])).toBeUndefined();
  });

  it('ignores relative paths and ordinary commands', () => {
    expect(detectOutsideRootPath('node --test', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('type src/mathUtils.js', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('npm run build', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('cat ./README.md', ROOT)).toBeUndefined();
  });

  it('does not mistake a short flag like /d for a path', () => {
    // `cd /d X` — the /d is a flag, not a unix path (single segment).
    expect(detectOutsideRootPath('cmd /d', ROOT)).toBeUndefined();
  });

  it('does not read the "/b/c" tail of a relative path "a/b/c" as an absolute path', () => {
    // Regression: a task prompt mentioning a deep RELATIVE path matched "/backend/AgentBackend.ts"
    // and resolved it to "C:\backend\AgentBackend.ts" — a bogus "outside root".
    expect(detectOutsideRootPath('edit src/backend/AgentBackend.ts', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('touch src/session/SessionManager.ts and src/backend/Foo.ts', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('(src/backend/AgentBackend.ts)', ROOT)).toBeUndefined();
  });

  it('does not flag the working root itself written in prose with trailing punctuation', () => {
    expect(detectOutsideRootPath(`Work in the Unode repo (${ROOT}).`, ROOT)).toBeUndefined();
    expect(detectOutsideRootPath(`cd ${ROOT}, then build`, ROOT)).toBeUndefined();
  });

  it('still flags a genuine absolute unix path at a boundary', () => {
    expect(detectOutsideRootPath('type /etc/passwd', ROOT)).toBeTruthy();
    expect(detectOutsideRootPath('cat /var/log/syslog', ROOT)).toBeTruthy();
  });

  it('still flags an outside drive path even with trailing prose punctuation', () => {
    expect(detectOutsideRootPath(`see ${outsideDrive}.`, ROOT)).toBeTruthy();
    expect(detectOutsideRootPath(`(${outsideDrive})`, ROOT)).toBeTruthy();
  });

  it('still flags a real sibling dir of the root', () => {
    const sibling = process.platform === 'win32' ? 'C:\\AI_Program\\SiblingProj\\x.ts' : '/work/sibling/x.ts';
    expect(detectOutsideRootPath(`type ${sibling}`, ROOT)).toBeTruthy();
  });

  it('does NOT flag a regex literal inside an inline node script (the 0.8.1 false-positive)', () => {
    // These wedged a real agent: the unix-path branch matched `/\r?\n/`, and a doubled `\\r?\\n`
    // matched `C:\r?\n…`, falsely blocking the command as "outside your working folder".
    expect(detectOutsideRootPath(`node -e "const l=s.split(/\\r?\\n/);console.log(l)"`, ROOT)).toBeUndefined();
    expect(detectOutsideRootPath(`node -e "x.replace(/\\\\r?\\\\n/g,'')"`, ROOT)).toBeUndefined();
    expect(detectOutsideRootPath(`grep -E "foo/?bar" file`, ROOT)).toBeUndefined();
  });

  it('does NOT path-sniff inside inline-script bodies (string escapes like \\n that have no ?/*)', () => {
    // The `?`/`*` filter alone missed these: `'\\n'` → `C:\n`, a bare `/g`, etc. Don't scan the
    // node -e / python -c body at all — it's code, not argv.
    expect(detectOutsideRootPath(`node -e "console.log(a ? a.join('\\n') : 'x')"`, ROOT)).toBeUndefined();
    expect(detectOutsideRootPath(`python3 -c "import re; print(re.split('/a/b/', s))"`, ROOT)).toBeUndefined();
    expect(detectOutsideRootPath(`perl -e 'print "C:\\\\temp\\\\x"'`, ROOT)).toBeUndefined();
  });

  it('does NOT flag /dev/null and friends (the 2>/dev/null discard sink)', () => {
    expect(detectOutsideRootPath('grep -rn assign_task src/ 2>/dev/null', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('cat file > /dev/null', ROOT)).toBeUndefined();
    expect(detectOutsideRootPath('cmd 2>/dev/stderr', ROOT)).toBeUndefined();
    // but a real /dev/<something-else> deep path is still treated as outside
    expect(detectOutsideRootPath('cat /dev/sda/secret', ROOT)).toBeTruthy();
  });

  it('still flags an outside path BEFORE an eval flag, and a real file arg to an interpreter', () => {
    // Truncation starts at the eval flag — anything before it is still checked.
    expect(detectOutsideRootPath(`node ${outsideDrive} -e "1"`, ROOT)).toBeTruthy();
    // A non-interpreter `-p`/`-e` (e.g. git) must NOT trigger truncation.
    expect(detectOutsideRootPath(`type ${outsideDrive}`, ROOT)).toBeTruthy();
  });
});

// A URL scheme ends in a letter followed by "://" — the exact shape of a Windows drive path. `https://…`
// was read as drive `s:`, resolved to `s:\github.com\…`, and reported as "outside your working folder".
// That aborted the chat turn before it ran, and blocked `git clone` / `git remote add` / `curl` outright.
describe('detectOutsideRootPath: URLs are not filesystem paths', () => {
  const urls = [
    'copy https://github.com/someuser/SilentData to that repo?',
    'git remote add org https://github.com/SilentDataAI/SilentData.git',
    'git clone https://github.com/foo/bar.git',
    'curl -sL https://example.com/x',
    'pip install git+ssh://git@host/repo.git',
    'git clone a://host/repo',
    'copy "a://host/repo"',
    'git clone git+ssh:/host/repo',
    'curl x-y+z.1://h',
    'gh repo list SilentDataAI --limit 20',
  ];
  it.each(urls)('does not flag %j', (command) => {
    expect(detectOutsideRootPath(command, ROOT)).toBeUndefined();
  });

  // The URL exemption is exactly "a letter before AND two slashes after". Both halves are load-bearing:
  // widen it either way and a real escape walks through.
  it.runIf(process.platform === 'win32')('still flags a drive letter glued to a short flag', () => {
    expect(detectOutsideRootPath(String.raw`curl -oC:\Users\me\evil.exe https://x.com/p`, ROOT))
      .toBe(String.raw`C:\Users\me\evil.exe`);
    expect(detectOutsideRootPath(String.raw`gcc -IC:\other\include a.c`, ROOT))
      .toBe(String.raw`C:\other\include`);
  });

  it.runIf(process.platform === 'win32')('still flags a drive path written with two slashes', () => {
    // No scheme letter precedes it, so `C://…` is a path, not a URL.
    expect(detectOutsideRootPath('type C://Users/other/id_rsa', ROOT)).toBe(String.raw`C:\Users\other\id_rsa`);
  });

  it.runIf(process.platform === 'win32')('resumes scanning inside a file:// URL and flags its real drive path', () => {
    // `e://…` is rejected as a scheme, so the scan must continue and still catch `c:/secrets.txt`.
    expect(detectOutsideRootPath('read file://c:/secrets.txt', ROOT)).toBe(String.raw`c:\secrets.txt`);
  });

  it.runIf(process.platform === 'win32')('flags Windows extended-length and forward-slash UNC paths', () => {
    expect(detectOutsideRootPath(String.raw`type \\?\C:\Users\me\secret.txt`, ROOT)).toBeTruthy();
    expect(detectOutsideRootPath(String.raw`type \\?\UNC\server\share\secret.txt`, ROOT)).toBeTruthy();
    expect(detectOutsideRootPath('type //server/share/secret.txt', ROOT)).toBeTruthy();
  });
});
