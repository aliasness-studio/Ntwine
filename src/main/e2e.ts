import { isAbsolute } from 'node:path';

/**
 * The app's E2E-mode contract (e2e spec §3.1). Pure on purpose: main.ts is un-importable under
 * Vitest (module-scope Electron side effects), so every decision lives here and main.ts only
 * wires the result. NOTHING is honoured unless NTWINE_E2E === '1'.
 */
export interface E2EConfig {
  userData: string;
  appData: string | null;
  libraryRoot: string | null;
  bootMarker: string | null;
  /** NTWINE_E2E_HIDDEN=1 — present the window imperceptibly (off-screen, transparent, inactive,
   * muted; see main.ts for why plain `show:false` is too slow) so an e2e run never pops a
   * window, steals focus, or makes noise on the dev box. Same exact-"1" discipline as
   * NTWINE_E2E itself; the harness sets it by default (NTWINE_E2E_HEADED=1 opts back out). */
  hidden: boolean;
}

export class E2EConfigError extends Error {}

/** Absent → null; present but not absolute → E2EConfigError (the spec's env table says <abs …> for every key). */
function absoluteOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined || value === '') return null;
  if (!isAbsolute(value)) throw new E2EConfigError(`${key} must be an absolute path (got "${value}")`);
  return value;
}

export function readE2EConfig(env: NodeJS.ProcessEnv): E2EConfig | null {
  if (env.NTWINE_E2E !== '1') return null;
  const userData = env.NTWINE_USER_DATA;
  // A missed override on the PACKAGED binary would otherwise land in the developer's real
  // <appData>/Ntwine/ntwine-data — refusing to boot is the structural guard.
  if (!userData || !isAbsolute(userData)) {
    throw new E2EConfigError('NTWINE_E2E=1 requires NTWINE_USER_DATA=<absolute dir>; refusing to boot against the real user-data directory');
  }
  return {
    userData,
    appData: absoluteOrNull(env, 'NTWINE_APP_DATA'),
    libraryRoot: absoluteOrNull(env, 'NTWINE_LIBRARY_ROOT'),
    bootMarker: absoluteOrNull(env, 'NTWINE_E2E_BOOT_MARKER'),
    hidden: env.NTWINE_E2E_HIDDEN === '1',
  };
}

export type E2EEmit = (event: string, payload: unknown) => void;
export interface EmitterLike {
  emit(eventName: string, ...args: unknown[]): boolean;
}

export function makeE2EEmitter(app: EmitterLike, cfg: E2EConfig | null): E2EEmit | null {
  if (cfg === null) return null;
  return (event, payload) => {
    app.emit(event, payload);
  };
}
