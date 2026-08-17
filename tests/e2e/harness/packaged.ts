import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './launch';

export function packagedExecutable(): string {
  const dir = join(REPO_ROOT, 'out', `Ntwine-${process.platform}-${process.arch}`);
  const exe = process.platform === 'darwin' ? join(dir, 'Ntwine.app', 'Contents', 'MacOS', 'Ntwine')
    : process.platform === 'win32' ? join(dir, 'Ntwine.exe')
    : null;
  if (!exe) throw new Error(`packaged probe: unsupported platform ${process.platform}`);
  if (!existsSync(exe)) throw new Error(`packaged probe: ${exe} not found — run yarn package`);
  return exe;
}
