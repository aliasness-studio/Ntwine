import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/ipcTypes';
import { UpdateStore } from './UpdateStore';

// Full `NtwineApi`-shaped fake, same rationale as ImportStore.test.ts's — the five self-update
// methods are overridable per test (UpdateStore only ever calls these), the rest are inert
// defaults it never touches. Kept untyped-as-`NtwineApi` so the overridden fields keep their
// `Mock<...>` shape for direct assertions.
function makeFakeApi(
  over: Partial<{
    getUpdateState: () => Promise<UpdateState>;
    onUpdateState: (cb: (s: UpdateState) => void) => () => void;
    installUpdate: () => Promise<void>;
    openReleasesPage: () => Promise<void>;
    getAppVersion: () => Promise<string>;
  }> = {},
) {
  return {
    getState: vi.fn(async () => ({ imported: false, libraryRoot: '/lib', spliceDbFound: false })),
    runImport: vi.fn(async () => {}),
    onImportProgress: vi.fn(() => () => {}),
    pickLibraryRoot: vi.fn(async () => null as string | null),
    pickSpliceDb: vi.fn(async () => null as string | null),
    listPacks: vi.fn(async () => []),
    listTags: vi.fn(async () => []),
    querySamples: vi.fn(async () => []),
    getPeaks: vi.fn(async () => ({})),
    decodePreviewPcm: vi.fn(
      async () => null as { sampleRate: number; channels: Float32Array[] } | null,
    ),
    startDrag: vi.fn(async () => {}),
    sampleUrl: vi.fn((id: number) => `sample://s/${id}`),
    coverUrl: vi.fn((id: number) => `cover://p/${id}`),
    setFavorite: vi.fn(async () => {}),
    setNickname: vi.fn(async () => {}),
    listUserTags: vi.fn(async () => [] as string[]),
    addUserTag: vi.fn(async () => {}),
    removeUserTag: vi.fn(async () => {}),
    listLibraryRail: vi.fn(async () => ({ favorites: 0, collections: [] as { id: string; name: string; count: number }[] })),
    createCollection: vi.fn(async () => ({ id: 'c1' })),
    renameCollection: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    addToCollection: vi.fn(async () => {}),
    removeFromCollection: vi.fn(async () => {}),
    getUpdateState: vi.fn(over.getUpdateState ?? (async (): Promise<UpdateState> => ({ kind: 'idle' }))),
    onUpdateState: vi.fn(over.onUpdateState ?? (() => () => {})),
    installUpdate: vi.fn(over.installUpdate ?? (async () => {})),
    openReleasesPage: vi.fn(over.openReleasesPage ?? (async () => {})),
    getAppVersion: vi.fn(over.getAppVersion ?? (async () => '1.2.3')),
  };
}

// A controllable 'ntwine:update-state' broadcast channel: `onUpdateState` captures whichever
// callback UpdateStore registers, `emit` fires it directly.
function makeUpdateChannel() {
  let cb: ((s: UpdateState) => void) | null = null;
  const onUpdateState = vi.fn((handler: (s: UpdateState) => void) => {
    cb = handler;
    return () => {};
  });
  const emit = (s: UpdateState) => cb?.(s);
  return { onUpdateState, emit };
}

const READY_1: UpdateState = { kind: 'ready', version: '1.3.0' };
const READY_2: UpdateState = { kind: 'ready', version: '1.4.0' };
const FAILED: UpdateState = {
  kind: 'failed',
  reason: 'signature',
  downloadUrl: 'https://github.com/aliasness-studio/Ntwine/releases/latest',
};

describe('UpdateStore', () => {
  it('starts idle, undismissed, with no version, and not visible', () => {
    const store = new UpdateStore(makeFakeApi());
    expect(store.state).toEqual({ kind: 'idle' });
    expect(store.dismissed).toBe(false);
    expect(store.version).toBeNull();
    expect(store.visible).toBe(false);
  });

  it('init() loads the app version and the current update state', async () => {
    const api = makeFakeApi({ getUpdateState: async () => READY_1 });
    const store = new UpdateStore(api);

    await store.init();

    expect(api.getAppVersion).toHaveBeenCalledTimes(1);
    expect(api.getUpdateState).toHaveBeenCalledTimes(1);
    expect(store.version).toBe('1.2.3');
    expect(store.state).toEqual(READY_1);
    expect(store.visible).toBe(true);
  });

  it('init() subscribes BEFORE fetching — a broadcast landing while getUpdateState is in flight wins over the stale fetched value', async () => {
    const channel = makeUpdateChannel();
    let resolveFetch: (s: UpdateState) => void = () => {};
    const api = makeFakeApi({
      onUpdateState: channel.onUpdateState,
      getUpdateState: () =>
        new Promise<UpdateState>((r) => {
          resolveFetch = r;
        }),
    });
    const store = new UpdateStore(api);

    const initDone = store.init();
    expect(channel.onUpdateState).toHaveBeenCalledTimes(1);
    expect(channel.onUpdateState.mock.invocationCallOrder[0]).toBeLessThan(
      api.getUpdateState.mock.invocationCallOrder[0],
    );
    channel.emit(READY_1); // the newer truth, broadcast mid-fetch
    resolveFetch({ kind: 'idle' }); // the stale snapshot taken before the transition
    await initDone;

    expect(store.state).toEqual(READY_1);
  });

  it('a broadcast after init() updates state', async () => {
    const channel = makeUpdateChannel();
    const store = new UpdateStore(makeFakeApi({ onUpdateState: channel.onUpdateState }));
    await store.init();
    expect(store.visible).toBe(false);

    channel.emit(FAILED);

    expect(store.state).toEqual(FAILED);
    expect(store.visible).toBe(true);
  });

  it('dismiss() hides a visible banner without changing state', async () => {
    const store = new UpdateStore(makeFakeApi({ getUpdateState: async () => READY_1 }));
    await store.init();

    store.dismiss();

    expect(store.dismissed).toBe(true);
    expect(store.visible).toBe(false);
    expect(store.state).toEqual(READY_1);
  });

  it('a later, different non-idle state un-dismisses (new ready version, or failed)', async () => {
    const channel = makeUpdateChannel();
    const store = new UpdateStore(
      makeFakeApi({ onUpdateState: channel.onUpdateState, getUpdateState: async () => READY_1 }),
    );
    await store.init();

    store.dismiss();
    channel.emit(READY_2);
    expect(store.dismissed).toBe(false);
    expect(store.visible).toBe(true);

    store.dismiss();
    channel.emit(FAILED);
    expect(store.dismissed).toBe(false);
    expect(store.visible).toBe(true);
  });

  it('the same state re-sent does NOT un-dismiss', async () => {
    const channel = makeUpdateChannel();
    const store = new UpdateStore(
      makeFakeApi({ onUpdateState: channel.onUpdateState, getUpdateState: async () => READY_1 }),
    );
    await store.init();

    store.dismiss();
    channel.emit({ kind: 'ready', version: '1.3.0' }); // equal by value, fresh object

    expect(store.dismissed).toBe(true);
    expect(store.visible).toBe(false);
  });

  it('an idle broadcast does not un-dismiss (nothing to show), and a later non-idle one does', async () => {
    const channel = makeUpdateChannel();
    const store = new UpdateStore(
      makeFakeApi({ onUpdateState: channel.onUpdateState, getUpdateState: async () => READY_1 }),
    );
    await store.init();

    store.dismiss();
    channel.emit({ kind: 'idle' });
    expect(store.dismissed).toBe(true);
    expect(store.visible).toBe(false);

    channel.emit(READY_1);
    expect(store.dismissed).toBe(false);
    expect(store.visible).toBe(true);
  });

  it('install() calls api.installUpdate only when ready', async () => {
    const channel = makeUpdateChannel();
    const api = makeFakeApi({ onUpdateState: channel.onUpdateState });
    const store = new UpdateStore(api);
    await store.init();

    await store.install(); // idle
    channel.emit(FAILED);
    await store.install(); // failed
    expect(api.installUpdate).not.toHaveBeenCalled();

    channel.emit(READY_1);
    await store.install();
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('openReleases() calls api.openReleasesPage only when failed', async () => {
    const channel = makeUpdateChannel();
    const api = makeFakeApi({ onUpdateState: channel.onUpdateState });
    const store = new UpdateStore(api);
    await store.init();

    await store.openReleases(); // idle
    channel.emit(READY_1);
    await store.openReleases(); // ready
    expect(api.openReleasesPage).not.toHaveBeenCalled();

    channel.emit(FAILED);
    await store.openReleases();
    expect(api.openReleasesPage).toHaveBeenCalledTimes(1);
  });

  it('api errors reject through install()/openReleases() rather than being swallowed', async () => {
    const channel = makeUpdateChannel();
    const store = new UpdateStore(
      makeFakeApi({
        onUpdateState: channel.onUpdateState,
        installUpdate: async () => {
          throw new Error('install boom');
        },
        openReleasesPage: async () => {
          throw new Error('open boom');
        },
      }),
    );
    await store.init();

    channel.emit(READY_1);
    await expect(store.install()).rejects.toThrow('install boom');
    channel.emit(FAILED);
    await expect(store.openReleases()).rejects.toThrow('open boom');
  });
});
