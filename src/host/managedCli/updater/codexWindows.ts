/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the managed Codex program on Windows x64 (v0.9.97)
 *  The package is the vendor's `codex-package-x86_64-pc-windows-msvc.tar.gz`, kept exactly as published: `bin\`,
 *  `codex-resources\`, `codex-path\` and `codex-package.json`, with no file removed or replaced. The program started
 *  is `bin\codex.exe` inside one promoted version folder, named only through the instance store. Nothing here starts
 *  anything.
 *
 *  Starting it uses the existing App Server argv builder unchanged (`buildCodexAppServerArgs`). Codex's own updater
 *  stays out of the way without any extra argument:
 *  - the version folder lies outside `CODEX_HOME\packages\standalone\releases\`, and the spawn environment drops every
 *    `CODEX_MANAGED_BY_*` variable, so Codex classifies the install as "Other", which has no update action;
 *  - `codex app-server` has no update check, and the interactive program is never started;
 *  - the argv guard refuses `update`, `daemon`, `login`, `logout` and `install`;
 *  - `-c check_for_update_on_startup=false` is deliberately not added: it is a setting of the interactive program,
 *    and adding it would change the argv the release canaries tested, under `--strict-config`, for no effect.
 *  Each qualified version's policy entry records a review of these facts at its release tag.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { InstanceRef, InstanceStoreApi, VersionKey } from '../contracts';

/** The program's listing path inside a version folder: what a policy entry's `layout.entrypoint` must name. */
export const CODEX_WINDOWS_ENTRYPOINT = 'bin/codex.exe';

/** The absolute path of `bin\codex.exe` in one version folder. The folder comes from the instance store alone. */
export function managedCodexExecutable(instances: Pick<InstanceStoreApi, 'versionFolder'>, ref: InstanceRef, key: VersionKey): string {
  return path.join(instances.versionFolder(ref, key), ...CODEX_WINDOWS_ENTRYPOINT.split('/'));
}
