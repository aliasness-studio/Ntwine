import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './launch';

export function packagedExecutable(): string {
  // NTWINE_PACKAGED_DIR: absolute path to an `out/Ntwine-<platform>-<arch>` directory, for runs
  // against a build other than the host-arch default (e.g. the universal release build). Empty
  // counts as unset (`||`, not `??`): that is how CI and `VAR= cmd` spell "not configured".
  const override = process.env.NTWINE_PACKAGED_DIR || undefined;
  const dir = override ?? join(REPO_ROOT, 'out', `Ntwine-${process.platform}-${process.arch}`);
  const exe = process.platform === 'darwin' ? join(dir, 'Ntwine.app', 'Contents', 'MacOS', 'Ntwine')
    : process.platform === 'win32' ? join(dir, 'Ntwine.exe')
    : null;
  if (!exe) throw new Error(`packaged probe: unsupported platform ${process.platform}`);
  if (!existsSync(exe)) {
    // With an override, `yarn package` would not help: it writes the default dir, not this one.
    const why = override === undefined ? ' — run yarn package' : ' (NTWINE_PACKAGED_DIR override)';
    throw new Error(`packaged probe: ${exe} not found${why}`);
  }
  return exe;
}

/** Runs the packaged binary to exit (SIGKILL after 30 s) and returns its exit code and stderr. */
export function runPackaged(exe: string, env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr }); });
  });
}

// Quiet by default, same contract as harness/launch.ts: the boot probe otherwise flashes a real
// window. NTWINE_E2E_HEADED=1 in the runner's shell opts back out (debugging).
export const packagedBaseEnv = (): Record<string, string> => {
  const e = { ...(process.env as Record<string, string>) };
  delete e.ELECTRON_RUN_AS_NODE;
  if (process.env.NTWINE_E2E_HEADED !== '1') e.NTWINE_E2E_HIDDEN = '1';
  return e;
};
