import { spawn } from 'node:child_process';
import * as path from 'node:path';

/** A program and its arguments, started without a shell. */
export interface DocumentOpenerCommand {
  command: string;
  args: string[];
  /** Windows only: the arguments are already quoted and reach the program exactly as written. */
  verbatim: boolean;
}

/**
 * v0.9.102: the program that opens a document in its Windows app, given the file's own path.
 *
 * VS Code's `openExternal` hands Windows a file URL, and Windows reads the URL's percent-encoded UTF-8 as single
 * bytes. A Chinese file name then names a file that does not exist, and the user sees "The system cannot find the
 * file specified. (0x2)". File Explorer is given the path itself and opens the file with its app, as a double click
 * does.
 *
 * The path is one argument, quoted here. Unquoted, File Explorer reads a comma in a path as the start of an
 * option, and opens a folder instead. Quoting is exact because a Windows path never holds a quotation mark; a path
 * that does is refused. The program is named by its full path, never looked up in the current folder.
 */
export function windowsDocumentOpener(filePath: string, systemRoot: string | undefined): DocumentOpenerCommand {
  if (filePath.includes('"')) throw new Error('A Windows path cannot hold a quotation mark.');
  return {
    command: path.win32.join(systemRoot || 'C:\\Windows', 'explorer.exe'),
    args: [`"${filePath}"`],
    verbatim: true,
  };
}

/**
 * Starts the program without a shell and without waiting for it, and resolves once it started. File Explorer's
 * exit code says nothing about the file, so a start is all this reports; a program that cannot start rejects.
 */
export function startDocumentOpener(opener: DocumentOpenerCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opener.command, opener.args, {
      shell: false,
      stdio: 'ignore',
      windowsVerbatimArguments: opener.verbatim,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
