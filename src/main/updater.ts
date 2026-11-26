import { RELEASES_URL, UPDATE_REPO, type UpdateState } from '../shared/ipcTypes';

/**
 * Self-update state machine over Electron's built-in `autoUpdater`, fed by update.electronjs.org.
 * Pure on purpose (the e2e.ts pattern): no runtime Electron import, so it runs under Vitest's node
 * environment; main.ts passes in the real `autoUpdater` and wires `onState` to the renderer.
 */

export const UPDATE_INITIAL_DELAY_MS = 30_000;
export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
// One slug for the feed and the Releases page: defined in shared (RELEASES_URL derives from it),
// re-exported here so the updater's own callers and tests keep importing it from this module.
export { UPDATE_REPO };

/** darwin always asks for the universal feed — the only Mac asset published (make:mac) —
 * whatever arch this process runs as; every other platform asks for its own arch. */
export function feedArchFor(platform: string, arch: string): string {
  return platform === 'darwin' ? 'universal' : arch;
}

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

/** Squirrel.Mac rejects an update whose code signature does not match the running app's:
 * "Code signature at URL … did not pass validation". Retrying cannot fix that, so it is the one
 * error the user is told about. Keyed on "did not pass validation", not "code signature": an
 * unsigned/ad-hoc local `yarn package` build fails with "Could not get code signature for running
 * application", and that must stay silent ('other') rather than show a download link. */
export function classifyUpdateError(err: unknown): 'signature' | 'other' {
  const message = err instanceof Error ? err.message : String(err);
  return /did not pass validation/i.test(message) ? 'signature' : 'other';
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
  /** Must match the injected setters (a handle is only meaningful to its own timer source). */
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
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
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const log = deps.log ?? ((msg: string) => console.error(msg));

  let current: UpdateState = { kind: 'idle' };
  let started = false;
  let firstCheck: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  function setState(next: UpdateState): void {
    if (sameState(current, next)) return;
    current = next;
    onState(next);
  }

  /** Cancel every pending check: once an update is downloaded (another check would re-download
   * it; `install()` is all that is left) or once the updater can never succeed (signature failure). */
  function stop(): void {
    if (firstCheck !== null) clearTimeoutFn(firstCheck);
    if (interval !== null) clearIntervalFn(interval);
    firstCheck = null;
    interval = null;
  }

  /** `ready` and `failed` end polling for good; `downloading` does not, since a download that
   * fails falls back to `idle` and the next tick must try again. */
  function isTerminal(s: UpdateState): boolean {
    return s.kind === 'ready' || s.kind === 'failed';
  }

  /** Polling only ever happens from `idle`. A tick in a terminal state cancels the timers (the
   * backstop for any path where a transition lands before or between timer arming); a tick while
   * `downloading` is skipped, because a second check would start a second download. */
  function check(): void {
    if (isTerminal(current)) {
      stop();
      return;
    }
    if (current.kind === 'downloading') return;
    autoUpdater.checkForUpdates();
  }

  return {
    start() {
      if (started) return;
      started = true;
      // Emitted once an update is found; Squirrel starts downloading it straight away.
      autoUpdater.on('update-available', () => {
        if (current.kind === 'idle') setState({ kind: 'downloading' });
      });
      autoUpdater.on(
        'update-downloaded',
        (_event: unknown, _notes: unknown, releaseName: string) => {
          stop();
          setState({ kind: 'ready', version: releaseName });
        },
      );
      autoUpdater.on('error', (err: unknown) => {
        if (classifyUpdateError(err) === 'signature') {
          stop();
          setState({ kind: 'failed', reason: 'signature', downloadUrl: RELEASES_URL });
          return;
        }
        // Offline, feed down, rate-limited, download cut off…: silent, and the next tick simply
        // tries again. A failed download is no longer downloading, so it drops back to idle.
        if (current.kind === 'downloading') setState({ kind: 'idle' });
        log(`[updater] update check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      autoUpdater.setFeedURL({ url: feedUrl });
      // setFeedURL can itself emit a signature error synchronously; stop() then had nothing to
      // cancel, so never arm timers from a terminal state.
      if (isTerminal(current)) return;
      firstCheck = setTimeoutFn(() => {
        firstCheck = null;
        if (isTerminal(current)) return;
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

/** An `Updater` that never touches `autoUpdater`: it always reports `state`, and `start`/`install`
 * do nothing. Only for an e2e run that pins the update state (e2e.ts's `updateState`). */
export function fixedStateUpdater(state: UpdateState): Updater {
  return { start() {}, state: () => state, install() {} };
}

export interface UpdaterIpcDeps {
  /** `ipcMain.handle.bind(ipcMain)` in main.ts; injected so this stays Electron-free and testable. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (channel: string, fn: (...a: any[]) => unknown) => void;
  /** `null` whenever `shouldRunUpdater` is false (dev, e2e, Linux): the bridge still answers. An
   * e2e run that pins its update state passes a `fixedStateUpdater` instead. */
  updater: Updater | null;
  openExternal: (url: string) => Promise<void>;
  version: string;
}

/** The four update invokes behind NtwineApi's `getUpdateState`/`installUpdate`/`openReleasesPage`/
 * `getAppVersion`. The `'ntwine:update-state'` broadcast is not here: main.ts wires `onState` to
 * the window directly. With no updater the renderer simply sees a permanent `idle`. */
export function registerUpdaterIpc(deps: UpdaterIpcDeps): void {
  const { handle, updater, openExternal, version } = deps;
  handle('ntwine:getUpdateState', (): UpdateState => updater?.state() ?? { kind: 'idle' });
  handle('ntwine:installUpdate', (): void => updater?.install());
  // Fixed URL, never renderer-supplied: this channel must not become an arbitrary-URL opener.
  handle('ntwine:openReleasesPage', () => openExternal(RELEASES_URL));
  handle('ntwine:getAppVersion', () => version);
}
