import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASES_URL, type UpdateState } from '../shared/ipcTypes';
import {
  type AutoUpdaterLike,
  UPDATE_INITIAL_DELAY_MS,
  UPDATE_INTERVAL_MS,
  classifyUpdateError,
  createUpdater,
  feedArchFor,
  feedUrlFor,
  registerUpdaterIpc,
  shouldRunUpdater,
  type Updater,
  UPDATE_REPO,
} from './updater';

// Stand-in for Electron's `autoUpdater`: a real EventEmitter (so tests drive it with `emit`,
// exactly as Electron does) whose three commands are spies. Nothing from `electron` is mocked.
class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

// Squirrel.Mac's wording for an update whose signature does not match the running app.
const SIGNATURE_MISMATCH =
  'Code signature at URL file:///private/var/folders/x/Ntwine.app/ did not pass validation: ' +
  'code failed to satisfy specified code requirement(s)';
const UNSIGNED_LOCAL_BUILD = 'Could not get code signature for running application';

const FEED = 'https://update.electronjs.org/aliasness-studio/Ntwine/darwin-universal/0.1.0';

function setup() {
  const autoUpdater = new FakeAutoUpdater();
  const onState = vi.fn();
  const log = vi.fn();
  const updater = createUpdater({ autoUpdater, feedUrl: FEED, onState, log });
  return { autoUpdater, onState, log, updater };
}

describe('updater helpers', () => {
  it('feedUrlFor builds the update.electronjs.org URL', () => {
    expect(feedUrlFor({ platform: 'darwin', arch: 'universal', version: '0.1.0' })).toBe(FEED);
    expect(feedUrlFor({ platform: 'win32', arch: 'x64', version: '1.2.3' })).toBe(
      'https://update.electronjs.org/aliasness-studio/Ntwine/win32-x64/1.2.3',
    );
  });

  it('the feed and RELEASES_URL share the one UPDATE_REPO slug (re-exported from shared)', () => {
    expect(UPDATE_REPO).toBe('aliasness-studio/Ntwine');
    expect(RELEASES_URL).toBe(`https://github.com/${UPDATE_REPO}/releases/latest`);
    expect(feedUrlFor({ platform: 'darwin', arch: 'universal', version: '0.1.0' })).toContain(
      `/${UPDATE_REPO}/`,
    );
  });

  it('feedArchFor asks for the universal feed on every Mac, the process arch elsewhere', () => {
    expect(feedArchFor('darwin', 'arm64')).toBe('universal');
    expect(feedArchFor('darwin', 'x64')).toBe('universal');
    expect(feedArchFor('win32', 'x64')).toBe('x64');
    expect(feedArchFor('win32', 'arm64')).toBe('arm64');
  });

  it('shouldRunUpdater is false unpackaged, under NTWINE_E2E=1, and on linux', () => {
    expect(shouldRunUpdater({ isPackaged: true, platform: 'darwin', env: {} })).toBe(true);
    expect(shouldRunUpdater({ isPackaged: true, platform: 'win32', env: {} })).toBe(true);
    expect(shouldRunUpdater({ isPackaged: false, platform: 'darwin', env: {} })).toBe(false);
    expect(
      shouldRunUpdater({ isPackaged: true, platform: 'darwin', env: { NTWINE_E2E: '1' } }),
    ).toBe(false);
    expect(shouldRunUpdater({ isPackaged: true, platform: 'linux', env: {} })).toBe(false);
  });

  it('classifyUpdateError flags only a Squirrel.Mac signature-validation failure', () => {
    expect(classifyUpdateError(new Error(SIGNATURE_MISMATCH))).toBe('signature');
    expect(classifyUpdateError(new Error('code signature DID NOT PASS VALIDATION'))).toBe(
      'signature',
    );
    // An unsigned / ad-hoc local `yarn package` build: not a signature mismatch, stays silent.
    expect(classifyUpdateError(new Error(UNSIGNED_LOCAL_BUILD))).toBe('other');
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('other');
    expect(classifyUpdateError('not an Error')).toBe('other');
  });
});

describe('createUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks after the initial delay and then every 4 hours', () => {
    const { autoUpdater, updater } = setup();
    updater.start();
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({ url: FEED });
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS - 1);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(UPDATE_INTERVAL_MS - 1);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('update-downloaded → ready with the version, reported once', () => {
    const { autoUpdater, onState, updater } = setup();
    updater.start();
    expect(updater.state()).toStrictEqual({ kind: 'idle' });

    // Electron's listener args: (event, releaseNotes, releaseName, releaseDate, updateURL).
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-not-available');
    autoUpdater.emit(
      'update-downloaded',
      {},
      'notes',
      '0.2.0',
      new Date(),
      'https://example.invalid',
    );
    autoUpdater.emit(
      'update-downloaded',
      {},
      'notes',
      '0.2.0',
      new Date(),
      'https://example.invalid',
    );

    expect(updater.state()).toStrictEqual({ kind: 'ready', version: '0.2.0' });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ kind: 'ready', version: '0.2.0' });
  });

  it('update-available → downloading, reported once', () => {
    const { autoUpdater, onState, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);

    autoUpdater.emit('update-available');
    autoUpdater.emit('update-available');

    expect(updater.state()).toStrictEqual({ kind: 'downloading' });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ kind: 'downloading' });
  });

  it('update-not-available changes nothing and reports nothing', () => {
    const { autoUpdater, onState, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);

    autoUpdater.emit('update-not-available');

    expect(updater.state()).toStrictEqual({ kind: 'idle' });
    expect(onState).not.toHaveBeenCalled();
  });

  it('downloading → ready on update-downloaded, each transition reported once, then polling stops', () => {
    const { autoUpdater, onState, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);

    autoUpdater.emit('update-available');
    autoUpdater.emit(
      'update-downloaded',
      {},
      'notes',
      '0.2.0',
      new Date(),
      'https://example.invalid',
    );

    expect(updater.state()).toStrictEqual({ kind: 'ready', version: '0.2.0' });
    expect(onState.mock.calls).toStrictEqual([
      [{ kind: 'downloading' }],
      [{ kind: 'ready', version: '0.2.0' }],
    ]);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 3);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('a tick while downloading neither checks nor cancels polling', () => {
    const { autoUpdater, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdater.emit('update-available');
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 2);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.state()).toStrictEqual({ kind: 'downloading' });

    // The interval is still armed: once the download fails back to idle, the next tick checks.
    autoUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('a network error while downloading → idle, logged, and the next tick checks again', () => {
    const { autoUpdater, onState, log, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    autoUpdater.emit('update-available');

    autoUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));

    expect(updater.state()).toStrictEqual({ kind: 'idle' });
    expect(onState.mock.calls).toStrictEqual([[{ kind: 'downloading' }], [{ kind: 'idle' }]]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/ERR_CONNECTION_RESET/);

    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('a code-signature error while downloading → failed, and no further checks', () => {
    const { autoUpdater, onState, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    autoUpdater.emit('update-available');

    autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));

    const failed = { kind: 'failed', reason: 'signature', downloadUrl: RELEASES_URL };
    expect(updater.state()).toStrictEqual(failed);
    expect(onState).toHaveBeenLastCalledWith(failed);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 3);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('update-available never leaves a terminal state (ready or failed)', () => {
    const ready = setup();
    ready.updater.start();
    ready.autoUpdater.emit('update-downloaded', {}, 'notes', '0.2.0', new Date(), 'x');
    ready.autoUpdater.emit('update-available');
    expect(ready.updater.state()).toStrictEqual({ kind: 'ready', version: '0.2.0' });
    expect(ready.onState).toHaveBeenCalledTimes(1);

    const failed = setup();
    failed.updater.start();
    failed.autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));
    failed.autoUpdater.emit('update-available');
    expect(failed.updater.state().kind).toBe('failed');
    expect(failed.onState).toHaveBeenCalledTimes(1);
  });

  it('a network error keeps state idle, reports nothing, and the next tick still checks', () => {
    const { autoUpdater, onState, log, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));

    expect(updater.state()).toStrictEqual({ kind: 'idle' });
    expect(onState).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/ERR_INTERNET_DISCONNECTED/);

    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('a code-signature error → failed/signature with RELEASES_URL and no further checks', () => {
    const { autoUpdater, onState, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));

    const failed = { kind: 'failed', reason: 'signature', downloadUrl: RELEASES_URL };
    expect(updater.state()).toStrictEqual(failed);
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(failed);

    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 3);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // A repeat of the same failure is not a change, so it is not re-reported.
    autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it('stops polling once an update is ready (re-checking would re-download it)', () => {
    const { autoUpdater, updater } = setup();
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdater.emit(
      'update-downloaded',
      {},
      'notes',
      '0.2.0',
      new Date(),
      'https://example.invalid',
    );
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 3);

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.state()).toStrictEqual({ kind: 'ready', version: '0.2.0' });
  });

  it('a signature error emitted synchronously by setFeedURL still stops all polling', () => {
    const { autoUpdater, onState, updater } = setup();
    autoUpdater.setFeedURL.mockImplementation(() => {
      autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));
    });
    updater.start();
    vi.advanceTimersByTime(12 * 60 * 60 * 1000);

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.state()).toStrictEqual({
      kind: 'failed',
      reason: 'signature',
      downloadUrl: RELEASES_URL,
    });
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent: a second call neither re-registers nor re-schedules', () => {
    const { autoUpdater, log, updater } = setup();
    updater.start();
    updater.start();
    expect(autoUpdater.setFeedURL).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS + UPDATE_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(log).toHaveBeenCalledTimes(1); // one listener, not two
  });

  it('cancels through the injected clear functions, with the handles the injected setters made', () => {
    const autoUpdater = new FakeAutoUpdater();
    // Spies over the (faked) globals. Cast because `typeof setTimeout` is the DOM+Node overload
    // set, which a single-signature mock cannot satisfy structurally.
    const timers = {
      setTimeout: vi.fn(setTimeout),
      setInterval: vi.fn(setInterval),
      clearTimeout: vi.fn(clearTimeout),
      clearInterval: vi.fn(clearInterval),
    };
    const updater = createUpdater({
      autoUpdater,
      feedUrl: FEED,
      onState: vi.fn(),
      setTimeout: timers.setTimeout as unknown as typeof setTimeout,
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearTimeout: timers.clearTimeout,
      clearInterval: timers.clearInterval,
    });
    updater.start();
    vi.advanceTimersByTime(UPDATE_INITIAL_DELAY_MS);
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers.setInterval).toHaveBeenCalledTimes(1);

    autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));
    expect(timers.clearInterval).toHaveBeenCalledWith(timers.setInterval.mock.results[0].value);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('install() only quits-and-installs when ready', () => {
    const { autoUpdater, updater } = setup();
    updater.start();

    updater.install();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    autoUpdater.emit('error', new Error(SIGNATURE_MISMATCH));
    updater.install();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    autoUpdater.emit(
      'update-downloaded',
      {},
      'notes',
      '0.2.0',
      new Date(),
      'https://example.invalid',
    );
    updater.install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('registerUpdaterIpc', () => {
  // Injected `handle` (main.ts passes `ipcMain.handle.bind(ipcMain)`): records each registration
  // so a test can invoke the handler exactly as ipcMain would. No `electron` mock needed.
  function register(updater: Updater | null) {
    const handlers = new Map<string, (...a: any[]) => unknown>();
    const handle = vi.fn((channel: string, fn: (...a: any[]) => unknown) => {
      handlers.set(channel, fn);
    });
    const openExternal = vi.fn(async () => {});
    registerUpdaterIpc({ handle, updater, openExternal, version: '0.3.1' });
    const invoke = (channel: string) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({} /* IpcMainInvokeEvent */);
    };
    return { handle, handlers, openExternal, invoke };
  }

  function fakeUpdater(state: UpdateState): Updater {
    return { start: vi.fn(), state: vi.fn(() => state), install: vi.fn() };
  }

  it('registers exactly the four update channels', () => {
    const { handle, handlers } = register(null);
    expect(handle).toHaveBeenCalledTimes(4);
    expect([...handlers.keys()].sort()).toEqual([
      'ntwine:getAppVersion',
      'ntwine:getUpdateState',
      'ntwine:installUpdate',
      'ntwine:openReleasesPage',
    ]);
  });

  it('openReleasesPage opens exactly RELEASES_URL', async () => {
    const { openExternal, invoke } = register(null);
    await invoke('ntwine:openReleasesPage');
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(RELEASES_URL);
  });

  it('getAppVersion resolves the injected version', async () => {
    const { invoke } = register(null);
    expect(await invoke('ntwine:getAppVersion')).toBe('0.3.1');
  });

  it('with no updater, getUpdateState is idle and installUpdate is a no-op', async () => {
    const { invoke } = register(null);
    expect(await invoke('ntwine:getUpdateState')).toEqual({ kind: 'idle' });
    await expect(Promise.resolve(invoke('ntwine:installUpdate'))).resolves.toBeUndefined();
  });

  it('with an updater, getUpdateState reads its current state and installUpdate delegates', async () => {
    const ready: UpdateState = { kind: 'ready', version: '0.4.0' };
    const updater = fakeUpdater(ready);
    const { invoke } = register(updater);
    expect(await invoke('ntwine:getUpdateState')).toEqual(ready);
    await invoke('ntwine:installUpdate');
    expect(updater.install).toHaveBeenCalledTimes(1);
    expect(updater.start).not.toHaveBeenCalled();
  });
});
