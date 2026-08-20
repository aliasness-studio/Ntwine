import { autorun, isObservable } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackRow, QueryFilters, SampleRow, TagFacet } from '../../shared/ipcTypes';
import { LibraryStore, sameFilters } from './LibraryStore';

// Full `NtwineApi`-shaped fake (all 23 bridge methods), built from plain `vi.fn()`s so the
// returned object satisfies `NtwineApi` structurally when passed into `new LibraryStore(...)` —
// no cast needed. Individual methods LibraryStore actually calls (`listPacks`/`listTags`/
// `querySamples`/`getPeaks`) are overridable per test; the rest are inert defaults LibraryStore
// never touches. Kept as a plain object (not typed `: NtwineApi`) so each field keeps its
// `Mock<...>` type for direct assertions (`expect(api.querySamples)...`) — see PlayerStore's
// fake for why an explicit interface type isn't used here either.
function makeFakeApi(
  over: Partial<{
    listPacks: () => Promise<PackRow[]>;
    listTags: () => Promise<TagFacet[]>;
    querySamples: (f: QueryFilters) => Promise<SampleRow[]>;
    getPeaks: (ids: number[]) => Promise<Record<number, ArrayBuffer>>;
  }> = {},
) {
  return {
    getState: vi.fn(async () => ({ imported: true, libraryRoot: '/lib', spliceDbFound: true })),
    runImport: vi.fn(async () => {}),
    // Zero-arity fallback/inert implementations throughout (rather than named-but-unused
    // parameters): TS allows a function with fewer declared params to satisfy a type expecting
    // more (safe: callers may pass extra args the function just ignores), and it sidesteps
    // `@typescript-eslint/no-unused-vars`'s default `args: "after-used"` behavior, which — unlike
    // queue.test.ts's/ipc.test.ts's `_ev`-before-a-used-param precedent — does NOT exempt a
    // trailing unused parameter with nothing used after it.
    onImportProgress: vi.fn(() => () => {}),
    pickLibraryRoot: vi.fn(async () => null as string | null),
    pickSpliceDb: vi.fn(async () => null as string | null),
    listPacks: vi.fn(over.listPacks ?? (async () => [] as PackRow[])),
    listTags: vi.fn(over.listTags ?? (async () => [] as TagFacet[])),
    querySamples: vi.fn(over.querySamples ?? (async () => [] as SampleRow[])),
    getPeaks: vi.fn(over.getPeaks ?? (async () => ({}) as Record<number, ArrayBuffer>)),
    decodePreviewPcm: vi.fn(
      async () => null as { sampleRate: number; channels: Float32Array[] } | null,
    ),
    startDrag: vi.fn(async () => {}),
    sampleUrl: vi.fn((id: number) => `sample://s/${id}`),
    coverUrl: vi.fn((id: number) => `cover://p/${id}`),
    // Task 6 (design spec §4): 11 new bridge methods, inert here — LibraryStore itself never
    // calls any of these (UserLayerStore, a later task, owns the writes; LibraryStore only
    // re-runs querySamples/listTags afterward).
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
  };
}

const samplePack: PackRow = { id: 1, name: 'Pack A', coverFile: null, sampleCount: 3 };
const sampleTag: TagFacet = { name: 'kick', count: 12 };
const sampleRow: SampleRow = {
  id: 1,
  filename: 'kick.wav',
  relPath: 'packs/Pack A/kick.wav',
  packId: 1,
  packName: 'Pack A',
  sampleType: 'oneshot',
  bpm: 120,
  audioKey: 'c',
  chordType: null,
  durationMs: 500,
  missing: false,
  tags: ['kick'],
  hasPeaks: true,
  peaksFailed: false,
  favorite: false,
  nickname: null,
  userTags: [],
};

describe('LibraryStore', () => {
  describe('init', () => {
    it('loads packs and tag facets, and runs an initial unfiltered query so rows is not empty on arrival', async () => {
      const api = makeFakeApi({
        listPacks: async () => [samplePack],
        listTags: async () => [sampleTag],
        querySamples: async () => [sampleRow],
      });
      const store = new LibraryStore(api);

      await store.init();

      expect(api.listPacks).toHaveBeenCalledTimes(1);
      expect(api.listTags).toHaveBeenCalledTimes(1);
      expect(store.packs).toEqual([samplePack]);
      expect(store.tags).toEqual([sampleTag]);
      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenCalledWith({});
      expect(store.rows).toEqual([sampleRow]);
      expect(store.loading).toBe(false);
    });

    it('loading is true while the initial query is in flight, false once it resolves', async () => {
      // A holder OBJECT rather than a bare `let` — TS's control-flow narrowing of a `let`
      // reassigned only from inside a captured closure collapses the later optional-call read to
      // `never` in this exact shape (confirmed empirically); mutating a property instead sidesteps
      // it entirely.
      const holder: { resolveQuery: ((rows: SampleRow[]) => void) | null } = {
        resolveQuery: null,
      };
      const api = makeFakeApi({
        querySamples: () =>
          new Promise<SampleRow[]>((resolve) => {
            holder.resolveQuery = resolve;
          }),
      });
      const store = new LibraryStore(api);

      const initPromise = store.init();
      // Flushes listPacks/listTags's microtasks so runQuery has actually started (and set
      // `loading = true`) by the time we assert — same idiom src/main/ipc.test.ts already uses.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.loading).toBe(true);

      holder.resolveQuery?.([]);
      await initPromise;
      expect(store.loading).toBe(false);
    });
  });

  describe('setSearch debounce (50ms)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('collapses rapid setSearch calls into exactly ONE querySamples call carrying the FINAL string', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setSearch('k');
      store.setSearch('ki');
      store.setSearch('kic');
      store.setSearch('kick');

      // Not yet — still within the debounce window.
      expect(api.querySamples).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenCalledWith({ search: 'kick' });
    });

    it('searchText updates synchronously on every keystroke, ahead of the debounced query', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setSearch('k');
      expect(store.searchText).toBe('k');
      store.setSearch('ki');
      expect(store.searchText).toBe('ki');
      // Query hasn't fired yet even though searchText already reflects the latest keystroke.
      expect(api.querySamples).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
    });

    it('a query already committed before the debounce window elapses again is unaffected by a second burst', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setSearch('kick');
      vi.advanceTimersByTime(50);
      expect(api.querySamples).toHaveBeenCalledTimes(1);

      store.setSearch('snare');
      store.setSearch('snares');
      vi.advanceTimersByTime(50);

      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({ search: 'snares' });
    });

    it('clearing back to an empty string removes search from the composed filters', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);
      store.setSearch('kick');
      vi.advanceTimersByTime(50);
      api.querySamples.mockClear();

      store.setSearch('');
      vi.advanceTimersByTime(50);

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenCalledWith({});
    });
  });

  describe('non-search filter actions — no debounce, one query per call', () => {
    it('setScope({kind:pack}) triggers exactly one query with the composed filters', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 5 });

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenCalledWith({ scope: { kind: 'pack', packId: 5 } });
      expect(store.filters).toEqual({ scope: { kind: 'pack', packId: 5 } });
    });

    it('setScope(null) clears the scope filter in exactly one more query', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);
      store.setScope({ kind: 'pack', packId: 5 });

      store.setScope(null);

      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({});
      // Not just value-equal to undefined — the KEY itself must be gone (patchFilters deletes
      // undefined-valued keys), the same mechanism every other filter dimension already relies on
      // so "no scope" round-trips over IPC as an absent key, not a `scope: undefined` own property.
      expect('scope' in store.filters).toBe(false);
    });

    it('toggleType sets the type filter, and toggling the SAME type again clears it back to "all"', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.toggleType('loop');
      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenLastCalledWith({ sampleType: 'loop' });

      store.toggleType('loop');
      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({});
    });

    it('toggleType to a DIFFERENT type replaces the filter rather than toggling it off', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);
      store.toggleType('loop');

      store.toggleType('oneshot');

      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({ sampleType: 'oneshot' });
    });

    it('setBpmRange triggers one query with both bounds composed', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setBpmRange(90, 140);

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenCalledWith({ bpmMin: 90, bpmMax: 140 });
    });

    it('setBpmRange(null, null) clears both bounds', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);
      store.setBpmRange(90, 140);

      store.setBpmRange(null, null);

      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({});
    });

    it('setKey triggers one query with the composed filters', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setKey('c#');

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenCalledWith({ audioKey: 'c#' });
    });

    it('setKey(null) clears the key filter', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);
      store.setKey('c#');

      store.setKey(null);

      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({});
    });

    it('toggleTag adds then removes a tag, one query per call', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.toggleTag('kick');
      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(api.querySamples).toHaveBeenLastCalledWith({ tags: ['kick'] });

      store.toggleTag('snare');
      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({ tags: ['kick', 'snare'] });

      store.toggleTag('kick');
      expect(api.querySamples).toHaveBeenCalledTimes(3);
      expect(api.querySamples).toHaveBeenLastCalledWith({ tags: ['snare'] });
    });

    it('composes filters CUMULATIVELY across different actions (pack scope + type together)', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 5 });
      store.toggleType('oneshot');

      expect(api.querySamples).toHaveBeenCalledTimes(2);
      expect(api.querySamples).toHaveBeenLastCalledWith({
        scope: { kind: 'pack', packId: 5 },
        sampleType: 'oneshot',
      });
    });

    it('a query resolving updates rows and resultCount', async () => {
      const api = makeFakeApi({ querySamples: async () => [sampleRow, sampleRow] });
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(store.rows).toEqual([sampleRow, sampleRow]);
      expect(store.resultCount).toBe(2);
    });
  });

  // Task 13 hand-QA against the REAL library (2026-08-17): every single query — the very first
  // one, `init()`'s own unfiltered call — rejected with "An object could not be cloned" the
  // moment a REAL Electron IPC boundary (not this file's `vi.fn()` fake) was involved. `filters`
  // is a plain field but `makeAutoObservable` deep-wraps it as an observable object (a Proxy) by
  // default — nothing here excludes it the way `api`/`searchDebounceHandle` are excluded — and a
  // MobX Proxy fails structured-clone the instant it crosses a REAL `ipcRenderer.invoke` call.
  // packs/tags loaded fine in that same hand-QA session because `listPacks()`/`listTags()` take
  // no arguments at all — nothing to clone on the way IN — which is exactly why 20+ existing
  // `toHaveBeenCalledWith({...})` assertions above never caught this: deep-equality matchers (and
  // a bare mock function call) are both blind to "is this a real Proxy," the one property that
  // actually breaks a real IPC round trip. `isObservable` (mobx's own utility) is what actually
  // falsifies the claim, not a value-equality check that a Proxy wrapping equal values would
  // still pass.
  describe('querySamples receives a plain object, not a MobX observable (real IPC requirement)', () => {
    it('the filters argument to querySamples is never a MobX-observable object', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setKey('c#');
      store.toggleTag('kick');

      for (const call of api.querySamples.mock.calls) {
        expect(isObservable(call[0])).toBe(false);
      }
    });

    it('the initial unfiltered query from init() is also a plain object', async () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      await store.init();

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(isObservable(api.querySamples.mock.calls[0][0])).toBe(false);
    });
  });

  // Review round 1, Finding 1: `patchFilters` used to spread-merge `undefined`-valued patch
  // entries (e.g. `{ scope: undefined }` from `setScope(null)`) straight into `this.filters`,
  // leaving a stale OWN key rather than removing it. `toEqual`/`toHaveBeenCalledWith` (used
  // everywhere above) are equality-insensitive to "key present with value undefined" vs "key
  // absent" — that's why none of those 20 tests caught it. `toStrictEqual` (and reading
  // `Object.keys` directly) is what actually distinguishes them, which matters because that's
  // exactly what a future filter-chip / active-filter-count UI (Task 13) would read.
  describe('filters — exact shape (no stale undefined-valued keys after clearing)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('touching and clearing EVERY filter dimension (including search) leaves filters strictly empty', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 5 });
      store.setScope(null);

      store.toggleType('loop');
      store.toggleType('loop'); // toggling the same type again clears it

      store.setBpmRange(90, 140);
      store.setBpmRange(null, null);

      store.setKey('c#');
      store.setKey(null);

      store.toggleTag('kick');
      store.toggleTag('kick'); // removes the only tag — exercises the tags: undefined branch,
      // otherwise untested by any test above (all of which only ever add tags).

      store.setSearch('kick');
      vi.advanceTimersByTime(50);
      store.setSearch('');
      vi.advanceTimersByTime(50);

      expect(store.filters).toStrictEqual({});
      expect(Object.keys(store.filters)).toEqual([]);
    });

    it('clearing ONE filter removes exactly its own key, leaving the exact key set of others still active untouched', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 5 });
      store.setKey('c#');
      store.setScope(null); // clear only the scope

      expect(store.filters).toStrictEqual({ audioKey: 'c#' });
    });
  });

  // Guards the "a change that changes nothing costs nothing" rule below. A false NEGATIVE here
  // (equal filters reported different) silently adds a dead history entry, which surfaces as a
  // back press that appears to do nothing at all.
  describe('sameFilters', () => {
    it('treats an empty filter set as equal to itself', () => {
      expect(sameFilters({}, {})).toBe(true);
    });

    it('compares scope by kind AND payload, not by reference', () => {
      expect(sameFilters({ scope: { kind: 'pack', packId: 5 } }, { scope: { kind: 'pack', packId: 5 } })).toBe(true);
      expect(sameFilters({ scope: { kind: 'pack', packId: 5 } }, { scope: { kind: 'pack', packId: 6 } })).toBe(false);
      expect(sameFilters({ scope: { kind: 'favorites' } }, { scope: { kind: 'favorites' } })).toBe(true);
      expect(sameFilters({ scope: { kind: 'favorites' } }, { scope: { kind: 'pack', packId: 5 } })).toBe(false);
      expect(sameFilters({ scope: { kind: 'collection', collectionId: 'a' } }, { scope: { kind: 'collection', collectionId: 'b' } })).toBe(false);
      expect(sameFilters({ scope: { kind: 'pack', packId: 5 } }, {})).toBe(false);
    });

    it('treats tags as a set — order does not matter, membership does', () => {
      expect(sameFilters({ tags: ['kick', 'snare'] }, { tags: ['snare', 'kick'] })).toBe(true);
      expect(sameFilters({ tags: ['kick'] }, { tags: ['kick', 'snare'] })).toBe(false);
      expect(sameFilters({ tags: [] }, {})).toBe(true); // an empty list narrows nothing
    });

    it('compares the scalar dimensions by value', () => {
      expect(sameFilters({ bpmMin: 90, bpmMax: 140 }, { bpmMin: 90, bpmMax: 140 })).toBe(true);
      expect(sameFilters({ bpmMin: 90 }, { bpmMin: 91 })).toBe(false);
      expect(sameFilters({ audioKey: 'c#' }, { audioKey: 'c' })).toBe(false);
      expect(sameFilters({ search: 'kick' }, {})).toBe(false);
    });
  });

  // Navigation (QoL round 2, 2026-08-20). Rows became link-navigable — pack/key/bpm/tag cells
  // change the browse state on click — which is only safe if every such change is reversible.
  describe('back stack', () => {
    it('starts empty: there is nothing to go back to on arrival', () => {
      const store = new LibraryStore(makeFakeApi());
      expect(store.canGoBack).toBe(false);
      store.back(); // a no-op, never a throw
      expect(store.filters).toStrictEqual({});
    });

    it('back() restores the exact previous filter set and re-queries with it', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 5 });
      store.setKey('c#');
      expect(store.canGoBack).toBe(true);

      store.back();

      expect(store.filters).toStrictEqual({ scope: { kind: 'pack', packId: 5 } });
      expect(api.querySamples).toHaveBeenLastCalledWith({ scope: { kind: 'pack', packId: 5 } });
    });

    it('unwinds one step per press, all the way back to the unfiltered view', () => {
      const store = new LibraryStore(makeFakeApi());

      store.setScope({ kind: 'pack', packId: 5 });
      store.toggleTag('kick');
      store.filterByBpm(128);

      store.back();
      expect(store.filters).toStrictEqual({ scope: { kind: 'pack', packId: 5 }, tags: ['kick'] });
      store.back();
      expect(store.filters).toStrictEqual({ scope: { kind: 'pack', packId: 5 } });
      store.back();
      expect(store.filters).toStrictEqual({});
      expect(store.canGoBack).toBe(false);
    });

    it('back() is not itself a history event — pressing it repeatedly never ping-pongs', () => {
      const store = new LibraryStore(makeFakeApi());
      store.setKey('c#');

      store.back();
      expect(store.canGoBack).toBe(false);
      store.back();
      expect(store.filters).toStrictEqual({});
    });

    // The bug this prevents looks exactly like "back is broken": the first press restores a state
    // identical to the current one, so nothing on screen moves.
    it('a change that changes nothing costs neither a history entry nor a query', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.setScope({ kind: 'pack', packId: 5 });
      expect(api.querySamples).toHaveBeenCalledTimes(1);

      store.setScope({ kind: 'pack', packId: 5 }); // the same pack, followed from another row
      store.setKey(null); // clearing a key that was never set

      expect(api.querySamples).toHaveBeenCalledTimes(1);
      expect(store.history).toHaveLength(1);
    });

    it('caps the stack rather than growing without bound', () => {
      const store = new LibraryStore(makeFakeApi());
      for (let i = 0; i < 120; i++) store.filterByBpm(i + 1);
      expect(store.history.length).toBeLessThanOrEqual(50);
      // The OLDEST entries are the ones dropped, so the most recent steps stay reversible.
      store.back();
      expect(store.filters).toStrictEqual({ bpmMin: 119, bpmMax: 119 });
    });

    describe('coalescing (per-keystroke sources collapse into one step)', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('one typed search is ONE back step, not one per debounce window', () => {
        const store = new LibraryStore(makeFakeApi());
        store.setScope({ kind: 'pack', packId: 5 });

        store.setSearch('k');
        vi.advanceTimersByTime(50);
        store.setSearch('ki');
        vi.advanceTimersByTime(50);
        store.setSearch('kick');
        vi.advanceTimersByTime(50);
        expect(store.filters).toStrictEqual({ scope: { kind: 'pack', packId: 5 }, search: 'kick' });

        store.back();

        expect(store.filters).toStrictEqual({ scope: { kind: 'pack', packId: 5 } });
        expect(store.searchText).toBe('');
      });

      it('a search still inside its debounce window cannot land after back() undid it', () => {
        const api = makeFakeApi();
        const store = new LibraryStore(api);
        store.setKey('c#');

        store.setSearch('kick'); // timer armed, not yet applied
        store.back();
        vi.advanceTimersByTime(50); // the pending timer would fire here if it survived

        expect(store.filters).toStrictEqual({});
        expect(store.searchText).toBe('');
      });

      it('typing after a non-search change starts a NEW back step', () => {
        const store = new LibraryStore(makeFakeApi());

        store.setSearch('kick');
        vi.advanceTimersByTime(50);
        store.setKey('c#');
        store.setSearch('snare');
        vi.advanceTimersByTime(50);

        store.back();
        expect(store.filters).toStrictEqual({ search: 'kick', audioKey: 'c#' });
      });
    });
  });

  // Review, PR #14: a snapshot must be an inert value. A shallow spread left `tags`/`scope`
  // aliased to the live filters and stored MobX proxies in the history, so a future in-place edit
  // of a nested filter value could reach back and rewrite the past.
  describe('history snapshots are inert values', () => {
    it('does not alias nested filter values, and stores no observables', () => {
      const store = new LibraryStore(makeFakeApi());
      store.toggleTag('kick');
      store.setScope({ kind: 'pack', packId: 5 }); // snapshots the tags-only state

      const snapshot = store.history[store.history.length - 1];
      expect(snapshot).toEqual({ tags: ['kick'] });
      expect(isObservable(snapshot)).toBe(false);
      expect(snapshot.tags).not.toBe(store.filters.tags); // a copy, not the live array
    });

    it('a snapshot survives later edits to the same dimensions untouched', () => {
      const store = new LibraryStore(makeFakeApi());
      store.setScope({ kind: 'pack', packId: 5 });
      store.toggleTag('kick');
      const afterScope = store.history[store.history.length - 1];

      store.toggleTag('snare');
      store.setScope({ kind: 'favorites' });

      expect(afterScope).toEqual({ scope: { kind: 'pack', packId: 5 } });
    });
  });

  describe('clearSearch', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears box and filter on the spot, without waiting out the debounce', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);
      store.setSearch('kick');
      vi.advanceTimersByTime(50);
      expect(store.filters).toStrictEqual({ search: 'kick' });

      store.clearSearch();

      // No timer advance: the crumb's ✕ is a discrete control, not a keystroke.
      expect(store.filters).toStrictEqual({});
      expect(store.searchText).toBe('');
      expect(api.querySamples).toHaveBeenLastCalledWith({});
    });

    it('is its own back step rather than coalescing into the typing that preceded it', () => {
      const store = new LibraryStore(makeFakeApi());
      store.setSearch('kick');
      vi.advanceTimersByTime(50);

      store.clearSearch();
      store.back();

      expect(store.filters).toStrictEqual({ search: 'kick' });
      expect(store.searchText).toBe('kick');
    });

    it('cancels a still-pending keystroke so it cannot re-apply afterwards', () => {
      const store = new LibraryStore(makeFakeApi());
      store.setSearch('kick'); // timer armed, never allowed to land

      store.clearSearch();
      vi.advanceTimersByTime(50);

      expect(store.filters).toStrictEqual({});
      expect(store.searchText).toBe('');
    });
  });

  describe('clearFilters', () => {
    it('drops every dimension at once and is reversible as a SINGLE step', () => {
      const store = new LibraryStore(makeFakeApi());
      store.setScope({ kind: 'pack', packId: 5 });
      store.setKey('c#');
      store.toggleTag('kick');

      store.clearFilters();
      expect(store.filters).toStrictEqual({});
      expect(store.searchText).toBe('');

      store.back();
      expect(store.filters).toStrictEqual({
        scope: { kind: 'pack', packId: 5 },
        audioKey: 'c#',
        tags: ['kick'],
      });
    });

    it('is a no-op with nothing active — it never pushes an empty step onto the stack', () => {
      const api = makeFakeApi();
      const store = new LibraryStore(api);

      store.clearFilters();

      expect(store.canGoBack).toBe(false);
      expect(api.querySamples).not.toHaveBeenCalled();
    });
  });

  describe('activeFilterCount', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('counts each dimension once, each tag separately, and BPM bounds as one', () => {
      const store = new LibraryStore(makeFakeApi());
      expect(store.activeFilterCount).toBe(0);

      store.setScope({ kind: 'favorites' });
      store.toggleType('loop');
      store.setKey('c#');
      store.setBpmRange(90, 140); // two bounds, ONE dimension
      store.toggleTag('kick');
      store.toggleTag('snare');
      store.setSearch('hat');
      vi.advanceTimersByTime(50);

      expect(store.activeFilterCount).toBe(7);
    });

    it('ignores a search still inside its debounce window (it describes the CURRENT rows)', () => {
      const store = new LibraryStore(makeFakeApi());

      store.setSearch('kick');

      expect(store.searchText).toBe('kick');
      expect(store.activeFilterCount).toBe(0);
    });
  });

  describe('fetchPeaks', () => {
    it('requests only ids not already cached, and merges the result into peaksCache', async () => {
      const bufA = new ArrayBuffer(8);
      const bufB = new ArrayBuffer(8);
      const api = makeFakeApi({
        getPeaks: async (ids: number[]) => {
          const out: Record<number, ArrayBuffer> = {};
          if (ids.includes(1)) out[1] = bufA;
          if (ids.includes(2)) out[2] = bufB;
          return out;
        },
      });
      const store = new LibraryStore(api);

      await store.fetchPeaks([1, 2]);

      expect(api.getPeaks).toHaveBeenCalledTimes(1);
      expect(api.getPeaks).toHaveBeenCalledWith([1, 2]);
      expect(store.peaksCache.get(1)).toBe(bufA);
      expect(store.peaksCache.get(2)).toBe(bufB);

      await store.fetchPeaks([1, 2, 3]);

      // 1 and 2 are already cached — only the new id 3 is re-requested.
      expect(api.getPeaks).toHaveBeenCalledTimes(2);
      expect(api.getPeaks).toHaveBeenLastCalledWith([3]);
    });

    it('does not call getPeaks at all when every requested id is already cached', async () => {
      const api = makeFakeApi({ getPeaks: async () => ({ 1: new ArrayBuffer(8) }) });
      const store = new LibraryStore(api);
      await store.fetchPeaks([1]);
      api.getPeaks.mockClear();

      await store.fetchPeaks([1]);

      expect(api.getPeaks).not.toHaveBeenCalled();
    });
  });

  // Plain unit-test reads of observable fields (`expect(store.rows)`) are UNTRACKED — they never
  // register as MobX "observers", so `enforceActions: 'observed'` (which only enforces action
  // discipline on observables that currently HAVE an observer — confirmed against mobx's own
  // source, `hasObservers || enforceActions === 'always'`) would stay silent even if a post-await
  // mutation were missing its `runInAction`. A live `autorun` is what actually exercises the
  // enforcement this store's async paths (`init`, `fetchPeaks`) depend on getting right.
  it('never triggers a MobX enforceActions warning under a live observer, across an async init + fetchPeaks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeFakeApi({
      querySamples: async () => [sampleRow],
      getPeaks: async () => ({ 1: new ArrayBuffer(8) }),
    });
    const store = new LibraryStore(api);
    const loadingSeen: boolean[] = [];
    const stop = autorun(() => {
      loadingSeen.push(store.loading);
      void store.rows.length;
      void store.peaksCache.size;
    });

    await store.init();
    await store.fetchPeaks([1]);

    stop();
    expect(warnSpy).not.toHaveBeenCalled();
    // loading flipped true -> false at least once, so the reaction genuinely observed the
    // post-await mutation (not just the initial false -> false no-op).
    expect(loadingSeen).toContain(true);
    expect(loadingSeen[loadingSeen.length - 1]).toBe(false);
    warnSpy.mockRestore();
  });
});
