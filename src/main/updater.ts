import { RELEASES_URL, type UpdateState } from '../shared/ipcTypes';

/**
 * Self-update state machine over Electron's built-in `autoUpdater`, fed by update.electronjs.org.
 * Pure on purpose (the e2e.ts pattern): no runtime Electron import, so it runs under Vitest's node
 * environment; main.ts passes in the real `autoUpdater` and wires `onState` to the renderer.
 */

export const UPDATE_INITIAL_DELAY_MS = 30_000;
export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_REPO = 'aliasness-studio/Ntwine';

export function feedUrlFor(a: { platform: string; arch: string; version: string }): string {
  return `https://update.electronjs.org/${UPDATE_REPO}/${a.platform}-${a.arch}/${a.version}`;
}

/** Packaged darwin/win32 builds only: a dev run has no signed bundle to replace, Linux has no
 * Squirrel backend, and an e2e run must never phone home or swap the binary under test. */
export function shouldRunUpdater(a: {
  isPackaged: boolean;
  platform: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    a.isPackaged && (a.platform === 'darwin' || a.platform === 'win32') && a.env.NTWINE_E2E !== '1'
  );
}

/** Squirrel.Mac rejects an update whose code signature does not match the running app's (D7).
 * Retrying cannot fix that, so it is the one error the user is told about. */
export function classifyUpdateError(err: unknown): 'signature' | 'other' {
  const message = err instanceof Error ? err.message : String(err);
  return /code signature/i.test(message) ? 'signature' : 'other';
}

/** The slice of Electron's `autoUpdater` this module drives. `any[]` (not `unknown[]`) so the real
 * object, whose `on` is a set of per-event typed overloads, stays assignable to it. */
export interface AutoUpdaterLike {
  setFeedURL(o: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(ev: string, cb: (...a: any[]) => void): this;
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  feedUrl: string;
  /** Called once per transition — never for a repeat of the current state. */
  onState: (s: UpdateState) => void;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  log?: (msg: string) => void;
}

export interface Updater {
  start(): void;
  state(): UpdateState;
  install(): void;
}

function sameState(a: UpdateState, b: UpdateState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const { autoUpdater, feedUrl, onState } = deps;
  const setTimeoutFn = deps.setTimeout ?? setTimeout;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const log = deps.log ?? ((msg: string) => console.error(msg));

  let current: UpdateState = { kind: 'idle' };
  let firstCheck: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  function setState(next: UpdateState): void {
    if (sameState(current, next)) return;
    current = next;
    onState(next);
  }

  /** Cancel every pending check — used once the updater can never succeed (signature failure). */
  function stop(): void {
    if (firstCheck !== null) clearTimeout(firstCheck);
    if (interval !== null) clearInterval(interval);
    firstCheck = null;
    interval = null;
  }

  function check(): void {
    autoUpdater.checkForUpdates();
  }

  return {
    start() {
      autoUpdater.on(
        'update-downloaded',
        (_event: unknown, _notes: unknown, releaseName: string) => {
          setState({ kind: 'ready', version: releaseName });
        },
      );
      autoUpdater.on('error', (err: unknown) => {
        if (classifyUpdateError(err) === 'signature') {
          stop();
          setState({ kind: 'failed', reason: 'signature', downloadUrl: RELEASES_URL });
          return;
        }
        // Offline, feed down, rate-limited…: silent, and the next tick simply tries again.
        log(`[updater] update check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      autoUpdater.setFeedURL({ url: feedUrl });
      firstCheck = setTimeoutFn(() => {
        firstCheck = null;
        // Interval armed BEFORE the first check so a synchronously-emitted signature error can
        // still cancel it.
        interval = setIntervalFn(check, UPDATE_INTERVAL_MS);
        check();
      }, UPDATE_INITIAL_DELAY_MS);
    },
    state: () => current,
    install() {
      if (current.kind === 'ready') autoUpdater.quitAndInstall();
    },
  };
}
