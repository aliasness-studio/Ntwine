import { autorun } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { PackRow, QueryFilters, SampleRow, TagFacet } from '../../shared/ipcTypes';
import { LibraryStore } from './LibraryStore';
import { UserLayerStore } from './UserLayerStore';

// Full `NtwineApi`-shaped fake, same rationale as LibraryStore.test.ts's — kept as a plain object
// (not typed `: NtwineApi`) so each field keeps its `Mock<...>` type for direct assertions
// (`.mock.invocationCallOrder` in particular, used below to pin call ORDER, not just occurrence).
// One instance is shared between `new LibraryStore(api)` and `new UserLayerStore(api, library)`
// in every test here — exactly how renderer.tsx wires the real `api` singleton into both — so
// assertions can observe `api.listTags`/`api.querySamples` calls the library double makes on
// UserLayerStore's behalf (via `refreshTags()`/`rerun()`), not only the 11 user-layer methods
// UserLayerStore calls directly.
function makeFakeApi(
  over: Partial<{
    listTags: () => Promise<TagFacet[]>;
    querySamples: (f: QueryFilters) => Promise<SampleRow[]>;
    listUserTags: () => Promise<string[]>;
    listLibraryRail: () => Promise<{
      favorites: number;
      collections: { id: string; name: string; count: number }[];
    }>;
    createCollection: (name: string) => Promise<{ id: string }>;
    renameCollection: (id: string, name: string) => Promise<void>;
  }> = {},
) {
  return {
    getState: vi.fn(async () => ({ imported: true, libraryRoot: '/lib', spliceDbFound: true })),
    runImport: vi.fn(async () => {}),
    onImportProgress: vi.fn(() => () => {}),
    pickLibraryRoot: vi.fn(async () => null as string | null),
    listPacks: vi.fn(async () => [] as PackRow[]),
    listTags: vi.fn(over.listTags ?? (async () => [] as TagFacet[])),
    querySamples: vi.fn(over.querySamples ?? (async () => [] as SampleRow[])),
    getPeaks: vi.fn(async () => ({}) as Record<number, ArrayBuffer>),
    decodePreviewPcm: vi.fn(
      async () => null as { sampleRate: number; channels: Float32Array[] } | null,
    ),
    startDrag: vi.fn(async () => {}),
    sampleUrl: vi.fn((id: number) => `sample://s/${id}`),
    coverUrl: vi.fn((id: number) => `cover://p/${id}`),
    setFavorite: vi.fn(async () => {}),
    setNickname: vi.fn(async () => {}),
    listUserTags: vi.fn(over.listUserTags ?? (async () => [] as string[])),
    addUserTag: vi.fn(async () => {}),
    removeUserTag: vi.fn(async () => {}),
    listLibraryRail: vi.fn(
      over.listLibraryRail ??
        (async () => ({ favorites: 0, collections: [] as { id: string; name: string; count: number }[] })),
    ),
    createCollection: vi.fn(over.createCollection ?? (async () => ({ id: 'c1' }))),
    renameCollection: vi.fn(over.renameCollection ?? (async () => {})),
    deleteCollection: vi.fn(async () => {}),
    addToCollection: vi.fn(async () => {}),
    removeFromCollection: vi.fn(async () => {}),
  };
}

// `library` is a REAL `LibraryStore` instance, not a plain object literal double: `LibraryStore`
// still has private methods (`applyDebouncedSearch`/`patchFilters`) after this task's edits, and
// TS only considers a type with private members assignable from the same declaration — a hand-
// rolled `{ rerun: vi.fn(), ... }` object cannot structurally satisfy `UserLayerStore`'s
// `library: LibraryStore` constructor parameter. `vi.spyOn` on its public `rerun`/`refreshTags`/
// `setScope` methods (mobx `makeAutoObservable` gives each an own, configurable instance
// property) tracks calls while still running the real implementation underneath.
function makeStores(overApi: Parameters<typeof makeFakeApi>[0] = {}) {
  const api = makeFakeApi(overApi);
  const library = new LibraryStore(api);
  return { api, library };
}

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

describe('UserLayerStore', () => {
  describe('init', () => {
    it('fetches the rail and the tag-autocomplete list, WITHOUT re-running the library query', async () => {
      const { api, library } = makeStores({
        listLibraryRail: async () => ({
          favorites: 3,
          collections: [{ id: 'c1', name: 'Drums', count: 2 }],
        }),
        listUserTags: async () => ['bright', 'punchy'],
      });
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.init();

      expect(api.listLibraryRail).toHaveBeenCalledTimes(1);
      expect(api.listUserTags).toHaveBeenCalledTimes(1);
      expect(store.favoritesCount).toBe(3);
      expect(store.collections).toEqual([{ id: 'c1', name: 'Drums', count: 2 }]);
      expect(store.userTagNames).toEqual(['bright', 'punchy']);
      // init() is "fetch rail" only — LibraryStore.init() already ran its own initial query, so
      // UserLayerStore re-running it here would be a redundant duplicate query at startup.
      expect(rerunSpy).not.toHaveBeenCalled();
    });
  });

  describe('loadUserTags', () => {
    it('replaces userTagNames with the api result', async () => {
      const { api, library } = makeStores({ listUserTags: async () => ['a', 'b'] });
      const store = new UserLayerStore(api, library);

      await store.loadUserTags();

      expect(store.userTagNames).toEqual(['a', 'b']);
    });
  });

  describe('toggleFavorite', () => {
    it('calls setFavorite with the NEGATED flag, then refreshes rail + re-runs the library query', async () => {
      const { api, library } = makeStores();
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.toggleFavorite({ ...sampleRow, favorite: false });

      expect(api.setFavorite).toHaveBeenCalledWith(1, true);
      expect(api.listLibraryRail).toHaveBeenCalledTimes(1);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
      expect(api.setFavorite.mock.invocationCallOrder[0]).toBeLessThan(
        api.listLibraryRail.mock.invocationCallOrder[0],
      );
    });

    it('negates a currently-favorited row back to false', async () => {
      const { api, library } = makeStores();
      const store = new UserLayerStore(api, library);

      await store.toggleFavorite({ ...sampleRow, favorite: true });

      expect(api.setFavorite).toHaveBeenCalledWith(1, false);
    });

    it('never touches refreshTags — that refresh is scoped to tag actions only', async () => {
      const { api, library } = makeStores();
      const refreshTagsSpy = vi.spyOn(library, 'refreshTags');
      const store = new UserLayerStore(api, library);

      await store.toggleFavorite({ ...sampleRow, favorite: false });

      expect(refreshTagsSpy).not.toHaveBeenCalled();
    });
  });

  describe('setNickname', () => {
    it('writes the nickname then refreshes', async () => {
      const { api, library } = makeStores();
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.setNickname(1, 'Fat Kick');

      expect(api.setNickname).toHaveBeenCalledWith(1, 'Fat Kick');
      expect(api.listLibraryRail).toHaveBeenCalledTimes(1);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
    });

    it('null clears the nickname', async () => {
      const { api, library } = makeStores();
      const store = new UserLayerStore(api, library);

      await store.setNickname(1, null);

      expect(api.setNickname).toHaveBeenCalledWith(1, null);
    });
  });

  describe('addTag / removeTag', () => {
    it('addTag writes the tag, then refreshes the tag facet AND the autocomplete list', async () => {
      const { api, library } = makeStores({ listUserTags: async () => ['kick', 'new-tag'] });
      const refreshTagsSpy = vi.spyOn(library, 'refreshTags');
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.addTag(1, 'new-tag');

      expect(api.addUserTag).toHaveBeenCalledWith(1, 'new-tag');
      expect(refreshTagsSpy).toHaveBeenCalledTimes(1);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
      expect(api.listUserTags).toHaveBeenCalledTimes(1);
      expect(store.userTagNames).toEqual(['kick', 'new-tag']);
    });

    it('removeTag writes the removal, then refreshes the tag facet AND the autocomplete list', async () => {
      const { api, library } = makeStores();
      const refreshTagsSpy = vi.spyOn(library, 'refreshTags');
      const store = new UserLayerStore(api, library);

      await store.removeTag(1, 'kick');

      expect(api.removeUserTag).toHaveBeenCalledWith(1, 'kick');
      expect(refreshTagsSpy).toHaveBeenCalledTimes(1);
      expect(api.listUserTags).toHaveBeenCalledTimes(1);
    });
  });

  describe('createCollection', () => {
    it('on success: returns { id }, and refreshes the rail', async () => {
      const { api, library } = makeStores({ createCollection: async () => ({ id: 'new-1' }) });
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      const result = await store.createCollection('Drums');

      expect(result).toEqual({ id: 'new-1' });
      expect(api.createCollection).toHaveBeenCalledWith('Drums');
      expect(api.listLibraryRail).toHaveBeenCalledTimes(1);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
    });

    it('on a name collision: catches the rejection and returns { error } WITHOUT refreshing', async () => {
      const { api, library } = makeStores({
        createCollection: async () => {
          throw new Error('A collection named "Drums" already exists.');
        },
      });
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      const result = await store.createCollection('Drums');

      expect(result).toEqual({ error: 'A collection named "Drums" already exists.' });
      expect(api.listLibraryRail).not.toHaveBeenCalled();
      expect(rerunSpy).not.toHaveBeenCalled();
    });
  });

  describe('renameCollection', () => {
    it('on success: returns null, and refreshes the rail', async () => {
      const { api, library } = makeStores();
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      const result = await store.renameCollection('c1', 'Kicks');

      expect(result).toBeNull();
      expect(api.renameCollection).toHaveBeenCalledWith('c1', 'Kicks');
      expect(rerunSpy).toHaveBeenCalledTimes(1);
    });

    it('on a name collision: catches the rejection and returns { error } WITHOUT refreshing', async () => {
      const { api, library } = makeStores({
        renameCollection: async () => {
          throw new Error('A collection named "Kicks" already exists.');
        },
      });
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      const result = await store.renameCollection('c1', 'Kicks');

      expect(result).toEqual({ error: 'A collection named "Kicks" already exists.' });
      expect(rerunSpy).not.toHaveBeenCalled();
    });
  });

  describe('deleteCollection', () => {
    it('scoped to the deleted collection: resets scope to null BEFORE the delete, which runs BEFORE the re-query', async () => {
      const { api, library } = makeStores();
      library.setScope({ kind: 'collection', collectionId: 'c1' });
      const setScopeSpy = vi.spyOn(library, 'setScope');
      const store = new UserLayerStore(api, library);

      await store.deleteCollection('c1');

      expect(setScopeSpy).toHaveBeenCalledWith(null);
      expect(api.deleteCollection).toHaveBeenCalledWith('c1');
      expect(setScopeSpy.mock.invocationCallOrder[0]).toBeLessThan(
        api.deleteCollection.mock.invocationCallOrder[0],
      );
      expect(api.deleteCollection.mock.invocationCallOrder[0]).toBeLessThan(
        api.listLibraryRail.mock.invocationCallOrder[0],
      );
      expect('scope' in library.filters).toBe(false);
    });

    it('scoped to a DIFFERENT collection: leaves scope untouched', async () => {
      const { api, library } = makeStores();
      library.setScope({ kind: 'collection', collectionId: 'other' });
      const setScopeSpy = vi.spyOn(library, 'setScope');
      const store = new UserLayerStore(api, library);

      await store.deleteCollection('c1');

      expect(setScopeSpy).not.toHaveBeenCalled();
      expect(library.filters.scope).toEqual({ kind: 'collection', collectionId: 'other' });
    });

    it('no scope at all: leaves scope untouched', async () => {
      const { api, library } = makeStores();
      const setScopeSpy = vi.spyOn(library, 'setScope');
      const store = new UserLayerStore(api, library);

      await store.deleteCollection('c1');

      expect(setScopeSpy).not.toHaveBeenCalled();
    });

    it('refreshes the rail and re-runs the query after the delete resolves', async () => {
      const { api, library } = makeStores();
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.deleteCollection('c1');

      expect(api.listLibraryRail).toHaveBeenCalledTimes(1);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('addToCollection / removeFromCollection', () => {
    it('addToCollection writes then refreshes', async () => {
      const { api, library } = makeStores();
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.addToCollection('c1', 7);

      expect(api.addToCollection).toHaveBeenCalledWith('c1', 7);
      expect(api.listLibraryRail).toHaveBeenCalledTimes(1);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
    });

    it('removeFromCollection writes then refreshes', async () => {
      const { api, library } = makeStores();
      const rerunSpy = vi.spyOn(library, 'rerun');
      const store = new UserLayerStore(api, library);

      await store.removeFromCollection('c1', 7);

      expect(api.removeFromCollection).toHaveBeenCalledWith('c1', 7);
      expect(rerunSpy).toHaveBeenCalledTimes(1);
    });
  });

  // Plain reads of observable fields are untracked (LibraryStore.test.ts's own note on this
  // applies identically here) — only a live `autorun` actually exercises `enforceActions:
  // 'observed'` across this store's async init/write/refresh paths.
  it('never triggers a MobX enforceActions warning under a live observer, across init + a write', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, library } = makeStores({
      listLibraryRail: async () => ({ favorites: 1, collections: [] }),
    });
    const store = new UserLayerStore(api, library);
    const seen: number[] = [];
    const stop = autorun(() => {
      seen.push(store.favoritesCount);
      void store.collections.length;
      void store.userTagNames.length;
    });

    await store.init();
    await store.toggleFavorite({ ...sampleRow, favorite: false });

    stop();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(seen).toContain(1);
    warnSpy.mockRestore();
  });
});
