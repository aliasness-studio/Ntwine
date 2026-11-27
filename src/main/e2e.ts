import { isAbsolute } from 'node:path';
import type { UpdateState } from '../shared/ipcTypes';

/**
 * The app's E2E-mode contract. Pure on purpose: main.ts is un-importable under
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
  /** NTWINE_E2E_UPDATE_STATE — what `ntwine:getUpdateState` answers in this run, since an e2e run
   * never starts the real updater. `downloading`, or `ready:<release name>` with the name taken
   * verbatim (e.g. `ready:Ntwine v0.2.0 (beta)`). The pinned updater's install is a no-op, so a
   * spec can click "Restart to update" safely. Absent → null (the usual permanent `idle`). */
  updateState: Extract<UpdateState, { kind: 'downloading' | 'ready' }> | null;
}

export class E2EConfigError extends Error {}

/** Absent → null; present but not absolute → E2EConfigError (every key takes an absolute path). */
function absoluteOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined || value === '') return null;
  if (!isAbsolute(value)) throw new E2EConfigError(`${key} must be an absolute path (got "${value}")`);
  return value;
}

const READY_PREFIX = 'ready:';

/** Absent → null; exactly "downloading", or "ready:" plus a non-blank release name → that state;
 * anything else → E2EConfigError. */
function updateStateOrNull(env: NodeJS.ProcessEnv): E2EConfig['updateState'] {
  const value = env.NTWINE_E2E_UPDATE_STATE;
  if (value === undefined || value === '') return null;
  if (value === 'downloading') return { kind: 'downloading' };
  if (value.startsWith(READY_PREFIX)) {
    const version = value.slice(READY_PREFIX.length);
    if (version.trim() !== '') return { kind: 'ready', version };
  }
  throw new E2EConfigError(
    `NTWINE_E2E_UPDATE_STATE accepts only "downloading" or "ready:<release name>" (got "${value}")`,
  );
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
    updateState: updateStateOrNull(env),
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
