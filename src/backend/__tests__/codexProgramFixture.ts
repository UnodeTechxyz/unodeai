import type { CodexProgramLaunch, CodexProgramStart } from '../CodexBackend';

/**
 * A launcher for tests that always runs one program, in the order the host's launcher keeps: the egress consent
 * with the program, the preflight, the spawn. Production never uses a fixed program; its launcher resolves each start.
 */
export function fixedCodexProgram(
  executable: string,
  record?: { starts: CodexProgramStart['pin'][]; released: number },
): (start: CodexProgramStart) => Promise<CodexProgramLaunch> {
  return async (start) => {
    record?.starts.push(start.pin);
    await start.beforeStart(executable);
    await start.preflight(executable);
    const child = start.spawn(executable);
    return {
      child,
      executable,
      identityKey: `external|codex-cli|${executable.toLowerCase()}|test`,
      release: () => { if (record) record.released++; },
    };
  };
}
