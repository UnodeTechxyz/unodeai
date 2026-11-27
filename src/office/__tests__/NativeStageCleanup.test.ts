import { afterEach, expect, it } from 'vitest';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NativeStageCleanup } from '../NativeStageCleanup';
const paths: string[] = []; const links: string[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) await unlink(link).catch(() => {});
  for (const path of paths.splice(0)) {
    try { await lstat(path); } catch { continue; }
    if (await realpath(path) !== path || dirname(path) !== await realpath(tmpdir()) || !/^unode-(?:native-render|cleanup-test)-/.test(basename(path))) throw Error('unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function directory(prefix = 'unode-native-render-') { const path = await realpath(await mkdtemp(join(tmpdir(), prefix))); paths.push(path); return path; }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
it('recovers only a completed owned stage after the prior owner ended, retaining unknown root files until removed', async () => {
  const ledger = await directory('unode-cleanup-test-'); const path = await directory(); const first = new NativeStageCleanup(ledger);
  const lease = await first.create(path); await mkdir(join(path, 'tmp')); await writeFile(join(path, 'tmp', 'compiler.dll'), 'generated');
  await writeFile(join(path, 'source.docx'), 'original'); await writeFile(join(path, 'user-canary.txt'), 'keep');
  expect(await first.complete(lease, new Map([[join(path, 'source.docx'), hash('original')]]), ['tmp'])).toBe(false);
  expect(await readFile(join(path, 'user-canary.txt'), 'utf8')).toBe('keep');
  await new NativeStageCleanup(ledger, () => true).recover(); expect(await access(path)).toBeUndefined();
  await unlink(join(path, 'user-canary.txt')); await new NativeStageCleanup(ledger, () => false).recover(); await expect(access(path)).rejects.toThrow();
});
it('retries owned finished cleanup on shutdown and never deletes changed source content', async () => {
  const path = await directory(); const cleaner = new NativeStageCleanup(); const lease = await cleaner.create(path);
  const source = join(path, 'source.docx'); await writeFile(source, 'changed');
  expect(await cleaner.complete(lease, new Map([[source, hash('original')]]), [])).toBe(false);
  expect(await readFile(source, 'utf8')).toBe('changed'); await writeFile(source, 'original'); await cleaner.dispose(); await expect(access(path)).rejects.toThrow();
});
it('preserves unconfirmed and legacy stages, and refuses replaced ownership markers', async () => {
  const ledger = await directory('unode-cleanup-test-'); const path = await directory(); const legacy = await directory();
  const cleaner = new NativeStageCleanup(ledger); const lease = await cleaner.create(path);
  await cleaner.recover(); await cleaner.dispose(); expect(await access(path)).toBeUndefined(); expect(await access(legacy)).toBeUndefined();
  await writeFile(join(path, '.unode-owned-stage'), 'replacement');
  expect(await cleaner.complete(lease, new Map(), [])).toBe(false); expect(await access(path)).toBeUndefined();
});
it.each(['root', 'nested'])('does not follow a %s producer-directory junction into another directory', async location => {
  const path = await directory(); const outside = await directory('unode-cleanup-test-'); const cleaner = new NativeStageCleanup(); const lease = await cleaner.create(path);
  await writeFile(join(outside, 'user-file'), 'keep'); if (location === 'nested') await mkdir(join(path, 'tmp'));
  const link = location === 'nested' ? join(path, 'tmp', 'redirect') : join(path, 'tmp'); await symlink(outside, link, 'junction'); links.push(link);
  expect(await cleaner.complete(lease, new Map(), ['tmp'])).toBe(false);
  expect(await readFile(join(outside, 'user-file'), 'utf8')).toBe('keep');
});

// Started native stages: the sweep never ends a process and cleans only when host, helper and app are all gone.
async function started(options: { receipt?: object | string } = {}) {
  const ledger = await directory('unode-cleanup-test-'); const path = await directory(); const host = new NativeStageCleanup(ledger);
  const lease = await host.create(path); await mkdir(join(path, 'tmp')); await mkdir(join(path, 'native')); await mkdir(join(path, 'pages'));
  await writeFile(join(path, 'source.docx'), 'original'); await writeFile(join(path, 'native', 'internal.pdf'), 'helper output');
  await writeFile(join(path, 'pages', 'page-1.png'), 'helper page');
  const operation = 'office-render-sweep-fixture'; const receipt = host.receiptPath(operation, path);
  await host.defer(lease, new Map([[join(path, 'source.docx'), hash('original')]]), ['tmp', 'native', 'pages'], { operation_id: operation, receipt });
  await host.noteHelper(lease.token, 7001);
  if (options.receipt !== undefined) await writeFile(receipt, typeof options.receipt === 'string' ? options.receipt : JSON.stringify(options.receipt));
  return { ledger, path, lease, receipt, host };
}
const receiptOf = (fields: object) => ({ version: 1, operation_id: 'office-render-sweep-fixture', host_pid: process.pid, helper_pid: 7001, process_name: 'WINWORD', ...fields });
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
it('skips a started stage while its host, helper or recorded application is alive, and never treats it as finished', async () => {
  const f = await started({ receipt: receiptOf({ phase: 'unknown', native_pid: 7002 }) });
  for (const running of [process.pid, 7001, 7002]) { await new NativeStageCleanup(f.ledger, alive(running)).recover(); expect(await access(f.path)).toBeUndefined(); }
  expect((await readdir(f.ledger)).some(name => name.endsWith('.pending.json'))).toBe(true);
  await new NativeStageCleanup(f.ledger, alive()).recover();
  await expect(access(f.path)).rejects.toThrow(); expect(await readdir(f.ledger)).toEqual([]);
});
it('removes a closed stage once host and helper are gone even when the closed application stays with its owner', async () => {
  const f = await started({ receipt: receiptOf({ phase: 'closed', native_app: 'left-running', native_reason: 'shared-at-stop', native_pid: 7002 }) });
  await new NativeStageCleanup(f.ledger, alive(7002)).recover(); await expect(access(f.path)).rejects.toThrow(); expect(await readdir(f.ledger)).toEqual([]);
});
it.each([
  ['a missing receipt', undefined],
  ['a malformed receipt', '{not json'],
  ['a receipt of another operation', { ...receiptOf({ phase: 'closed' }), operation_id: 'office-render-other' }],
  ['a receipt of another host', { ...receiptOf({ phase: 'closed' }), host_pid: process.pid + 1 }],
  ['a receipt naming another helper', { ...receiptOf({ phase: 'closed' }), helper_pid: 7009 }],
  ['a launching receipt without an application process', receiptOf({ phase: 'launching' })],
  ['an unknown end without an application process', receiptOf({ phase: 'unknown', native_app: 'unknown', native_reason: 'ownership-not-confirmed' })],
  ['an incomplete LibreOffice child scan', receiptOf({ phase: 'unknown', process_name: 'soffice', loader_pid: 7003, children: [], children_complete: false })],
])('keeps the stage for %s: a missing field is never read as not started', async (_name, receipt) => {
  const f = await started({ receipt }); await new NativeStageCleanup(f.ledger, alive()).recover();
  expect(await access(f.path)).toBeUndefined(); expect(await readFile(join(f.path, 'native', 'internal.pdf'), 'utf8')).toBe('helper output');
});
it('waits for every recorded LibreOffice conversion process, not only the loader', async () => {
  const f = await started({ receipt: receiptOf({ phase: 'unknown', process_name: 'soffice', loader_pid: 7003, children: [{ pid: 7004, start_ticks: 1 }], children_complete: true }) });
  await new NativeStageCleanup(f.ledger, alive(7004)).recover(); expect(await access(f.path)).toBeUndefined();
  await new NativeStageCleanup(f.ledger, alive()).recover(); await expect(access(f.path)).rejects.toThrow();
});
it('leaves a live claim alone, lets two concurrent sweeps clean once, and reclaims a claim whose claimant exited', async () => {
  const f = await started({ receipt: receiptOf({ phase: 'closed', native_app: 'quit-by-helper' }) });
  const pending = join(f.ledger, f.lease.token + '.pending.json'); const live = join(f.ledger, f.lease.token + '.claimed-7100.json');
  await rename(pending, live);
  await new NativeStageCleanup(f.ledger, alive(7100)).recover();
  expect(await access(f.path)).toBeUndefined(); expect(await readdir(f.ledger)).toContain(f.lease.token + '.claimed-7100.json');
  await rename(live, pending);
  await Promise.all([new NativeStageCleanup(f.ledger, alive()).recover(), new NativeStageCleanup(f.ledger, alive()).recover()]);
  await expect(access(f.path)).rejects.toThrow(); expect(await readdir(f.ledger)).toEqual([]);
  const again = await started({ receipt: receiptOf({ phase: 'closed', native_app: 'quit-by-helper' }) });
  await rename(join(again.ledger, again.lease.token + '.pending.json'), join(again.ledger, again.lease.token + '.claimed-7101.json'));
  await new NativeStageCleanup(again.ledger, alive()).recover(); await expect(access(again.path)).rejects.toThrow(); expect(await readdir(again.ledger)).toEqual([]);
});
it('releases a stage of this host only on the helper end it observed, keeping the stage identity and unknown-file checks', async () => {
  const f = await started();
  expect(await f.host.release(f.lease.token, { exit: { stage_released: false } })).toBe(false); expect(await access(f.path)).toBeUndefined();
  await writeFile(join(f.path, 'user-canary.txt'), 'keep');
  expect(await f.host.release(f.lease.token, { exit: { stage_released: true } })).toBe(false);
  expect(await readFile(join(f.path, 'user-canary.txt'), 'utf8')).toBe('keep');
  await unlink(join(f.path, 'user-canary.txt'));
  // This host claimed the stage before the unknown file stopped it; once that host has exited, a later sweep reclaims it.
  expect(await readdir(f.ledger)).toContain(f.lease.token + '.claimed-' + process.pid + '.json');
  await rename(join(f.ledger, f.lease.token + '.claimed-' + process.pid + '.json'), join(f.ledger, f.lease.token + '.claimed-7102.json'));
  await new NativeStageCleanup(f.ledger, alive()).recover(); await expect(access(f.path)).rejects.toThrow(); expect(await readdir(f.ledger)).toEqual([]);
});

// Release chain of 8fbbceaf: on Windows a rename over a record that another sweep (or any reader) has open fails with
// EPERM. The record update was then lost silently and its temporary file stayed in the ledger.
async function deferred() {
  const ledger = await directory('unode-cleanup-test-'); const path = await directory(); const host = new NativeStageCleanup(ledger);
  const lease = await host.create(path); await mkdir(join(path, 'tmp'));
  const operation = 'workbook-recalc-ledger-reader-fixture';
  await host.defer(lease, new Map(), ['tmp'], { operation_id: operation, receipt: host.receiptPath(operation, path) });
  return { ledger, host, lease, pending: join(ledger, lease.token + '.pending.json') };
}
it('keeps a record update made while another reader has the record open, and leaves no temporary file', async () => {
  const f = await deferred(); const reader = await open(f.pending, 'r');
  const noted = f.host.noteHelper(f.lease.token, 7001);
  // Longer than ten renames without a pause take even at Windows' default timer step; well inside the bounded wait.
  await new Promise(resolve => setTimeout(resolve, 200)); await reader.close(); await noted;
  expect(JSON.parse(await readFile(f.pending, 'utf8')).native.helper_pid).toBe(7001);
  expect(await readdir(f.ledger)).toEqual([f.lease.token + '.pending.json']);
});
it('gives up a record update after a bounded wait for a reader that never closes, without throwing or leaving a temporary file', async () => {
  const f = await deferred(); const reader = await open(f.pending, 'r');
  try { await expect(f.host.noteHelper(f.lease.token, 7001)).resolves.toBeUndefined(); } finally { await reader.close(); }
  expect(await readdir(f.ledger)).toEqual([f.lease.token + '.pending.json']);
});
