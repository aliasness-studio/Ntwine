import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './launch';

export function packagedExecutable(): string {
  // NTWINE_PACKAGED_DIR: absolute path to an `out/Ntwine-<platform>-<arch>` directory, for runs
  // against a build other than the host-arch default (e.g. the universal release build).
  const dir =
    process.env.NTWINE_PACKAGED_DIR ??
    join(REPO_ROOT, 'out', `Ntwine-${process.platform}-${process.arch}`);
  const exe = process.platform === 'darwin' ? join(dir, 'Ntwine.app', 'Contents', 'MacOS', 'Ntwine')
    : process.platform === 'win32' ? join(dir, 'Ntwine.exe')
    : null;
  if (!exe) throw new Error(`packaged probe: unsupported platform ${process.platform}`);
  if (!existsSync(exe)) throw new Error(`packaged probe: ${exe} not found — run yarn package`);
  return exe;
}
