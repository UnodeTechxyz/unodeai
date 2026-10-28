import { rmSync } from 'node:fs';

/**
 * Removes the temporary folder of a test whose processes worked in it.
 *
 * On Windows a folder can stay held for a few seconds after every process that used it has ended. Measured on a
 * loaded developer machine: 4 of about 1,150 cleanups of the Codex compatibility-check tests found the folder held,
 * for 1 to 4 s, and in none was a process naming the folder still listed. The likely holders are real-time antivirus
 * scanning and the ended process's handle rundown. Under a full release run the same hold has outlasted Node's retries
 * (about 21 s), on this machine and on GitHub's Windows runner.
 *
 * What these tests guard is a process that did not stop. So on Windows a folder still held after the retries fails the
 * test only when one of the test's processes still runs; otherwise it is left in the system temporary folder. On other
 * platforms EPERM and EBUSY mean a permission or mount problem and fail as any other error does.
 */
export function removeTestFolder(
  folder: string,
  pids: readonly (number | undefined)[],
  deps: { remove?: (folder: string) => void; alive?: (pid: number) => boolean; platform?: NodeJS.Platform } = {},
): void {
  const remove = deps.remove ?? ((target: string) => rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const isAlive = deps.alive ?? processAlive;
  try {
    remove(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((deps.platform ?? process.platform) !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
    const running = [...new Set(pids.filter((pid): pid is number => pid !== undefined && isAlive(pid)))];
    if (running.length > 0) {
      throw new Error(`${folder} is still held and process ${running.join(', ')} still runs (${(error as Error).message})`);
    }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
