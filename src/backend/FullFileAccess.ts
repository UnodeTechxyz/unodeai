import * as path from 'node:path';

/** Derive only the already-resolved target's volume/share; never enumerate disks or read a directory. */
export function fullAccessTargetRoot(physicalTarget: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const ordinary = physicalTarget.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    return path.win32.parse(ordinary).root;
  }
  return path.posix.parse(physicalTarget).root;
}
