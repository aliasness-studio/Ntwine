import { autorun } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { ImportProgress } from '../../shared/ipcTypes';
import { ImportStore } from './ImportStore';

// Full `NtwineApi`-shaped fake, same rationale as LibraryStore.test.ts's — `runImport`/
// `onImportProgress` are overridable per test (ImportStore only ever calls these two), the rest
// are inert defaults it never touches. Kept untyped-as-`NtwineApi` so the overridden fields keep
// their `Mock<...>` shape for direct assertions.
function makeFakeApi(
  over: Partial<{
    runImport: () => Promise<void>;
    onImportProgress: (cb: (p: ImportProgress) => void) => () => void;
  }> = {},
) {
  return {
    getState: vi.fn(async () => ({ imported: false, libraryRoot: '/lib', spliceDbFound: false })),
    runImport: vi.fn(over.runImport ?? (async () => {})),
    // Zero-arity fallback (rather than a named-but-unused `_cb` parameter): TS allows a function
    // with fewer declared params to satisfy a type expecting more, and it sidesteps
    // `@typescript-eslint/no-unused-vars`'s default `args: "after-used"`, which does not exempt a
    // trailing unused parameter with nothing used after it (see LibraryStore.test.ts's fake for
    // the same reasoning, applied throughout there too).
    onImportProgress: vi.fn(over.onImportProgress ?? (() => () => {})),
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
    platform: 'darwin',
    revealSample: vi.fn(async () => {}),
    copySamplePath: vi.fn(async () => {}),
    // User layer: 11 bridge methods, inert here — ImportStore never calls any
    // of these (only runImport/onImportProgress, both already overridable above).
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
    // Self-update: 5 bridge methods, inert here.
    getUpdateState: vi.fn(async () => ({ kind: 'idle' as const })),
    onUpdateState: vi.fn(() => () => {}),
    installUpdate: vi.fn(async () => {}),
    openReleasesPage: vi.fn(async () => {}),
    getAppVersion: vi.fn(async () => '0.0.0'),
  };
}

// A controllable progress channel: `onImportProgress` captures whichever callback ImportStore
// registers, `emit` fires it directly (from inside a `runImport` implementation, or later from
// the test body), `unsubscribe` records whether/how many times ImportStore tore the subscription
// down.
function makeProgressChannel() {
  let cb: ((p: ImportProgress) => void) | null = null;
  const unsubscribe = vi.fn();
  const onImportProgress = vi.fn((handler: (p: ImportProgress) => void) => {
    cb = handler;
    return unsubscribe;
  });
  const emit = (p: ImportProgress) => cb?.(p);
  return { onImportProgress, unsubscribe, emit };
}

describe('ImportStore', () => {
  it('starts with no phase and waveformsDone false', () => {
    const store = new ImportStore(makeFakeApi());
    expect(store.phase).toBeNull();
    expect(store.done).toBe(0);
    expect(store.total).toBe(0);
    expect(store.waveformsDone).toBe(false);
  });

  it('subscribes to onImportProgress BEFORE invoking runImport — an event fired SYNCHRONOUSLY during the call is captured, not missed', async () => {
    const channel = makeProgressChannel();
    const runImport = vi.fn(async () => {
      // Simulates main emitting its first progress event synchronously as part of starting the
      // import. This is the falsifier: it only reaches the store if onImportProgress was called
      // BEFORE runImport — the wrong order would leave `cb` unset (null) at this point, silently
      // dropping the event.
      channel.emit({ phase: 'snapshot', done: 0, total: 1, message: 'copying…' });
    });
    const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
    const store = new ImportStore(api);

    await store.run();

    expect(channel.onImportProgress).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledTimes(1);
    // Registration must have happened before invocation — assert call ORDER directly, not just
    // that both happened.
    expect(channel.onImportProgress.mock.invocationCallOrder[0]).toBeLessThan(
      runImport.mock.invocationCallOrder[0],
    );
    expect(store.phase).toBe('snapshot');
    expect(store.done).toBe(0);
    expect(store.total).toBe(1);
    expect(store.message).toBe('copying…');
  });

  it("run()'s promise resolves as soon as runImport resolves — it does NOT wait for a later 'done' event", async () => {
    const channel = makeProgressChannel();
    const runImport = vi.fn(async () => {
      channel.emit({ phase: 'catalog', done: 1, total: 1 });
      // Deliberately does not emit 'waveforms'/'done' before resolving — matches the real
      // contract (api.runImport resolves after catalog+stat+covers; waveform progress and the
      // terminal 'done' arrive later via onImportProgress).
    });
    const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
    const store = new ImportStore(api);

    await store.run();

    expect(store.phase).toBe('catalog');
    expect(store.waveformsDone).toBe(false);

    // Later, independent progress ticks (arriving after run() already returned) still update
    // the store through the same subscription.
    channel.emit({ phase: 'waveforms', done: 3, total: 10 });
    expect(store.phase).toBe('waveforms');
    expect(store.done).toBe(3);
    expect(store.total).toBe(10);
    expect(store.waveformsDone).toBe(false);

    channel.emit({ phase: 'done', done: 10, total: 10 });
    expect(store.phase).toBe('done');
    expect(store.waveformsDone).toBe(true);
  });

  it("unsubscribes once phase reaches 'done' — not before", async () => {
    const channel = makeProgressChannel();
    const api = makeFakeApi({ onImportProgress: channel.onImportProgress });
    const store = new ImportStore(api);

    await store.run();
    expect(channel.unsubscribe).not.toHaveBeenCalled();

    channel.emit({ phase: 'waveforms', done: 1, total: 2 });
    expect(channel.unsubscribe).not.toHaveBeenCalled();

    channel.emit({ phase: 'done', done: 2, total: 2 });
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a rejected runImport (after its terminal 'error' progress event) does not throw from run(), and unsubscribes", async () => {
    const channel = makeProgressChannel();
    const runImport = vi.fn(async () => {
      // Mirrors importer.ts's real contract: one terminal `{phase:'error'}` event is emitted
      // BEFORE the promise rejects, so a progress-only listener can learn why without wrapping
      // every call in its own try/catch.
      channel.emit({ phase: 'error', done: 0, total: 0, message: 'boom' });
      throw new Error('boom');
    });
    const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
    const store = new ImportStore(api);

    await expect(store.run()).resolves.toBeUndefined();

    expect(store.phase).toBe('error');
    expect(store.message).toBe('boom');
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a rejection with no prior progress event still unsubscribes and never throws (defensive — real runImport always emits error first, but run() must not depend on that)', async () => {
    const channel = makeProgressChannel();
    const runImport = vi.fn(async () => {
      throw new Error('no progress event this time');
    });
    const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
    const store = new ImportStore(api);

    await expect(store.run()).resolves.toBeUndefined();

    expect(store.phase).toBeNull();
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);

    // Regression guard for the re-entrancy fix: `onProgress`'s terminal-phase
    // branch is the ONLY other place `running` resets to false — and it never runs here, since
    // runImport rejected without ever emitting a progress event at all. Before this was fixed,
    // `running` stayed `true` forever, and `run()`'s own re-entrancy guard then silently no-op'd
    // every future call (`Promise.resolve()`, `runImport` never re-invoked) — bricking the import
    // flow until an app restart, strictly worse than the phase-derived predicate this replaced
    // (which correctly read "not importing" in this exact case).
    expect(store.running).toBe(false);

    await expect(store.run()).resolves.toBeUndefined();
    expect(runImport).toHaveBeenCalledTimes(2);
  });

  // A fast double-click before the
  // first onImportProgress event round-trips from main used to invoke runImport twice
  // concurrently — `phase` is still null at that point, so a phase-derived "is running" check
  // (the FirstRun/SettingsSheet predicate this replaces) hasn't engaged yet. `running` is a
  // dedicated flag precisely so it doesn't have that gap: it flips true synchronously inside
  // `run()`, before ANY await — including before `onImportProgress` is even called — so a SECOND
  // synchronous call sees it true immediately, with no window where neither call has set it yet.
  describe('run() re-entrancy', () => {
    it('two synchronous back-to-back calls: api.runImport invoked exactly once, exactly one subscription, running is true immediately', async () => {
      const channel = makeProgressChannel();
      const runImport = vi.fn(async () => {
        channel.emit({ phase: 'catalog', done: 1, total: 1 });
      });
      const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
      const store = new ImportStore(api);

      const p1 = store.run();
      const p2 = store.run(); // fires before either promise has had a chance to settle

      expect(store.running).toBe(true);
      await Promise.all([p1, p2]);

      expect(runImport).toHaveBeenCalledTimes(1);
      expect(channel.onImportProgress).toHaveBeenCalledTimes(1);
    });

    it('the re-entrant call returns the SAME in-flight promise, not an early separate resolution', async () => {
      // The failure mode a naive "no-op, resolve immediately" guard would reintroduce: a caller
      // chaining `.then()` off the SECOND call (exactly FirstRun.tsx's `handleImport` shape)
      // would fire its continuation before the real import has done anything, at a point where
      // `phase` isn't 'error' yet — e.g. FirstRun would flip to the library screen prematurely.
      // Resolving both calls together, at the SAME real completion point, is what this pins.
      const channel = makeProgressChannel();
      const runImport = vi.fn(async () => {
        channel.emit({ phase: 'catalog', done: 1, total: 1 });
      });
      const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
      const store = new ImportStore(api);
      const order: string[] = [];

      const p1 = store.run().then(() => order.push('p1'));
      const p2 = store.run().then(() => order.push('p2'));

      await Promise.all([p1, p2]);
      expect(order).toEqual(['p1', 'p2']); // settled in the same microtask batch, not p2 first
    });

    it("running flips back to false on 'done', and a run() call afterward starts a genuinely fresh run (not permanently wedged)", async () => {
      const channel = makeProgressChannel();
      const api = makeFakeApi({ onImportProgress: channel.onImportProgress });
      const store = new ImportStore(api);

      await store.run();
      expect(store.running).toBe(true); // still true — covers/catalog done, waveforms continue

      channel.emit({ phase: 'waveforms', done: 1, total: 2 });
      expect(store.running).toBe(true);

      channel.emit({ phase: 'done', done: 2, total: 2 });
      expect(store.running).toBe(false);

      await store.run();
      expect(api.runImport).toHaveBeenCalledTimes(2);
      expect(channel.onImportProgress).toHaveBeenCalledTimes(2);
    });

    it("running flips back to false on 'error' too", async () => {
      const channel = makeProgressChannel();
      const runImport = vi.fn(async () => {
        channel.emit({ phase: 'error', done: 0, total: 0, message: 'boom' });
        throw new Error('boom');
      });
      const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
      const store = new ImportStore(api);

      await store.run();

      expect(store.running).toBe(false);
    });

    it("a re-entrant call arriving after runImport settled but before 'done' (mid background waveform phase) still does not invoke runImport again", async () => {
      const channel = makeProgressChannel();
      const runImport = vi.fn(async () => {
        channel.emit({ phase: 'catalog', done: 1, total: 1 });
      });
      const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
      const store = new ImportStore(api);

      await store.run(); // runImport's own promise has now settled; running is still true
      expect(store.running).toBe(true);

      await store.run(); // no in-flight promise left to return — must still no-op, not re-run

      expect(runImport).toHaveBeenCalledTimes(1);
      expect(channel.onImportProgress).toHaveBeenCalledTimes(1);
    });
  });

  // Same rationale as LibraryStore's equivalent test: an untracked `expect(store.phase)` read
  // never registers as a MobX observer, so `enforceActions: 'observed'` would stay silent
  // regardless of whether async continuations are correctly action-wrapped. A live `autorun`
  // over the whole run() lifecycle (subscribe -> synchronous event -> later events -> done) is
  // what actually exercises that.
  it('never triggers a MobX enforceActions warning under a live observer, across the whole run() lifecycle', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const channel = makeProgressChannel();
    const runImport = vi.fn(async () => {
      channel.emit({ phase: 'snapshot', done: 0, total: 1 });
    });
    const api = makeFakeApi({ runImport, onImportProgress: channel.onImportProgress });
    const store = new ImportStore(api);
    const phasesSeen: (ImportProgress['phase'] | null)[] = [];
    const stop = autorun(() => {
      phasesSeen.push(store.phase);
      void store.done;
      void store.total;
    });

    await store.run();
    channel.emit({ phase: 'waveforms', done: 1, total: 2 });
    channel.emit({ phase: 'done', done: 2, total: 2 });

    stop();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(phasesSeen).toEqual([null, 'snapshot', 'waveforms', 'done']);
    warnSpy.mockRestore();
  });
});
