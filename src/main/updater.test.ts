import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASES_URL } from '../shared/ipcTypes';
import {
  type AutoUpdaterLike,
  UPDATE_INITIAL_DELAY_MS,
  UPDATE_INTERVAL_MS,
  classifyUpdateError,
  createUpdater,
  feedUrlFor,
  shouldRunUpdater,
} from './updater';

// Stand-in for Electron's `autoUpdater`: a real EventEmitter (so tests drive it with `emit`,
// exactly as Electron does) whose three commands are spies. Nothing from `electron` is mocked.
class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

// Squirrel.Mac's wording for an update whose signature does not match the running app (D7).
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
    // An unsigned / ad-hoc local `yarn package` build: not a D7 mismatch, stays silent.
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
