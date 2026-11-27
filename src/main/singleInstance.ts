/**
 * One running copy per user-data directory. Every copy of the app shares the same user data and
 * SQLite catalog, so a second launch (a downloaded copy opened while the installed one runs, a
 * double-clicked Dock icon on Windows) must hand over to the first and quit before it touches
 * any of it. Pure on purpose (the e2e.ts pattern): no runtime Electron import, so it runs under
 * Vitest; main.ts passes in app.requestSingleInstanceLock and the window.
 *
 * Electron keys the lock on the user-data path (chrome::DIR_USER_DATA, which app.setPath('userData')
 * overrides): a SingletonLock/SingletonSocket inside that directory on macOS and Linux, and on
 * Windows a message window named after it plus a lockfile inside it. So the lock must be requested
 * only after main.ts has set the E2E user-data path, and E2E launches with separate
 * NTWINE_USER_DATA directories never see each other's lock.
 */

/** 'squirrel' — a Windows `--squirrel-*` install/update/uninstall launch: electron-squirrel-startup
 * already does its work and quits, and it must not take (or be refused) the lock, because
 * Squirrel runs the new version's `--squirrel-updated` while the old one may still be open.
 * 'abort' — the E2E config was refused and the process is exiting; requesting the lock would
 * create (and lock) the real user-data directory.
 * 'secondary' — another copy holds the lock and has been told to come forward; quit now. */
export type StartupRole = 'squirrel' | 'abort' | 'secondary' | 'primary';

export function claimStartup(a: {
  squirrelEvent: boolean;
  configFailed: boolean;
  requestLock: () => boolean;
}): StartupRole {
  if (a.squirrelEvent) return 'squirrel';
  if (a.configFailed) return 'abort';
  return a.requestLock() ? 'primary' : 'secondary';
}

/** The slice of BrowserWindow the hand-over drives. */
export interface WindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface RevealDeps {
  window: WindowLike | null;
  /** False while startup is still awaiting a modal dialog (the move-to-Applications prompt) and
   * no window exists yet; a window created then would race the one startup creates. */
  startupDone: boolean;
  createWindow: () => WindowLike;
  /** Brings the app itself forward: on macOS that is what raises an app-modal startup dialog. */
  focusApp: () => void;
}

/** The primary instance's `second-instance` handler: restore, show and focus the window, or
 * recreate it if macOS kept the app alive with none. Never throws for a missing window. */
export function revealPrimary(d: RevealDeps): void {
  let win = d.window !== null && !d.window.isDestroyed() ? d.window : null;
  if (win === null && d.startupDone) win = d.createWindow();
  if (win !== null) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  d.focusApp();
}
