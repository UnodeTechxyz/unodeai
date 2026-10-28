import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { autoVerifyCommand, detectPackageManager } from '../session/ProjectConventions';
import type { EffectiveVerificationPolicy, VerificationPolicyResolution } from './CompletionVerificationPolicy';

export const VERIFICATION_MANIFEST_LIMIT = 1024 * 1024;
export type ManifestProblem = 'manifest-missing' | 'manifest-unreadable';
export type VerificationManifest =
  | { kind: 'read'; scripts: Readonly<Record<string, string>> }
  | { kind: ManifestProblem };

export type VerificationAdmission =
  | Extract<VerificationPolicyResolution, { kind: 'configuration-invalid' }>
  | { kind: 'disabled'; effective: EffectiveVerificationPolicy }
  | { kind: 'not-applicable'; effective: EffectiveVerificationPolicy;
      reason: ManifestProblem | 'script-missing' | 'no-auto-check' }
  | { kind: 'ready'; effective: EffectiveVerificationPolicy; command: string;
      applicability: 'recognized' | 'unchecked' };

/** Deliberately not a shell parser. Flags, quoting and chains remain unchecked, never partly recognised. */
export function verificationScript(command: string): string | undefined {
  if (command === 'npm test') return 'test';
  return /^(?:npm|pnpm|yarn) run ([A-Za-z0-9:_-]{1,80})$/.exec(command)?.[1];
}

/** One regular, non-link manifest; bounded reads through one handle, including a growth sentinel byte. */
export async function readVerificationManifest(cwd: string): Promise<VerificationManifest> {
  if (!path.isAbsolute(cwd)) return { kind: 'manifest-unreadable' };
  const file = path.join(cwd, 'package.json');
  let initial;
  try { initial = await fs.lstat(file); } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable' };
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > VERIFICATION_MANIFEST_LIMIT) {
    return { kind: 'manifest-unreadable' };
  }
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino
      || before.size > VERIFICATION_MANIFEST_LIMIT) return { kind: 'manifest-unreadable' };
    const bytes = Buffer.alloc(VERIFICATION_MANIFEST_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    const [after, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (length > VERIFICATION_MANIFEST_LIMIT || !named.isFile() || named.isSymbolicLink()
      || before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || length !== after.size) return { kind: 'manifest-unreadable' };
    const document: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) return { kind: 'manifest-unreadable' };
    const raw = (document as Record<string, unknown>).scripts;
    const scripts: Record<string, string> = Object.create(null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.trim()) scripts[key] = value;
      }
    }
    return { kind: 'read', scripts };
  } catch {
    return { kind: 'manifest-unreadable' };
  } finally {
    await handle?.close();
  }
}

export interface VerificationAdmissionReaders {
  manifest(cwd: string): Promise<VerificationManifest>;
  packageManager(cwd: string): Promise<string>;
}

const readers: VerificationAdmissionReaders = {
  manifest: readVerificationManifest,
  // Reuse the existing manager priority without reading unbounded lockfile contents.
  packageManager: (cwd) => detectPackageManager(cwd, async (file) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular lock file');
    return '';
  }),
};

/** Configuration selects a command, never an execution grant. The host supplies the actual execution cwd. */
export async function admitCompletionVerification(
  resolution: VerificationPolicyResolution,
  cwd: string,
  io: VerificationAdmissionReaders = readers,
): Promise<VerificationAdmission> {
  if (resolution.kind === 'configuration-invalid') return resolution;
  const effective = resolution.effective;
  const policy = effective.policy;
  if (policy.mode === 'disabled') return { kind: 'disabled', effective };
  let command = policy.mode === 'command' ? policy.command : '';
  let script = verificationScript(command);
  if (policy.mode === 'command' && script === undefined) {
    return { kind: 'ready', effective, command, applicability: 'unchecked' };
  }
  const manifest = await io.manifest(cwd);
  if (manifest.kind !== 'read') return { kind: 'not-applicable', effective, reason: manifest.kind };
  if (policy.mode === 'auto') {
    command = autoVerifyCommand({ packageManager: await io.packageManager(cwd), scripts: { ...manifest.scripts } });
    if (!command) return { kind: 'not-applicable', effective, reason: 'no-auto-check' };
    script = verificationScript(command);
  }
  if (script !== undefined && (!Object.hasOwn(manifest.scripts, script)
    || typeof manifest.scripts[script] !== 'string' || !manifest.scripts[script].trim())) {
    return { kind: 'not-applicable', effective, reason: 'script-missing' };
  }
  return { kind: 'ready', effective, command, applicability: script === undefined ? 'unchecked' : 'recognized' };
}
