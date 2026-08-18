// UserLayerStore (Task 7): the write side of the user layer — favorites, nicknames, user tags,
// and collections (Task 6's 11-method bridge addition) — plus the two pieces of state the LIBRARY
// rail (Task 8) reads: `favoritesCount`/`collections`. Every mutation here follows the same
// "fire the write, then refresh" posture as LibraryStore: this store never predicts server-side
// state locally (e.g. it doesn't increment `favoritesCount` itself) — `refresh()` re-fetches the
// rail from `listLibraryRail()` and re-runs the library's current query so `rows` picks up
// whatever the write actually changed (a nickname, a tag, a favorite flag, collection
// membership). `createCollection`/`renameCollection` are the one exception: they catch the
// invoke rejection (Task 6: a name collision throws `UserNameError` on the main side, which
// crosses `ipcMain.handle` as a rejected promise carrying `.message`) and hand back `{ error }`
// for the popover/rail editor to render inline (design spec §2.3/§5.1/§5.3) — every other action
// here lets a rejection surface to the console, same posture LibraryStore/ImportStore already
// take on their own IPC calls.
import { makeAutoObservable, runInAction } from 'mobx';
import './configure';
import type { NtwineApi, SampleRow } from '../../shared/ipcTypes';
import type { LibraryStore } from './LibraryStore';

export class UserLayerStore {
  favoritesCount = 0;
  collections: { id: string; name: string; count: number }[] = [];
  // Autocomplete source for the tag editor (spec §5.3) — loaded on `init()` and again whenever a
  // tag popover opens (that second call site belongs to the popover's own task; this store only
  // exposes `loadUserTags()` for it to call).
  userTagNames: string[] = [];

  // Task 11 (design spec §5.3): open-state for the tags/collection popovers and the inline
  // nickname editor — SampleList reads these to decide what (if anything) to render and where to
  // anchor it; SampleRow reads `nicknameEditId === row.id` (pre-resolved by SampleList, same
  // shape as its existing `selected` prop) to swap its filename cell for an input. `null` is
  // closed/not-editing in both.
  openPopover: { kind: 'tags' | 'collection'; sampleId: number } | null = null;
  nicknameEditId: number | null = null;

  // Plain (not `private`) fields, assigned in the constructor body — see LibraryStore.ts's `api`
  // field for why: a `makeAutoObservable` overrides-typing limitation (empirically confirmed
  // there) means neither a parameter-property nor a `private`-marked manual field is visible to
  // `keyof this` in the overrides map below, so `{ api: false, library: false }` needs plain
  // `readonly` fields to typecheck.
  readonly api: NtwineApi;
  readonly library: LibraryStore;

  constructor(api: NtwineApi, library: LibraryStore) {
    this.api = api;
    this.library = library;
    // `api`/`library` are injected dependencies, not reactive app state of THIS store — excluded
    // from the observable graph exactly like LibraryStore excludes its own `api`.
    makeAutoObservable(this, { api: false, library: false });
  }

  /**
   * Fetches just the rail (`favoritesCount`/`collections`) and the tag-autocomplete list.
   * Deliberately NOT a call to `refresh()` — `LibraryStore.init()` already runs its own initial
   * query, so re-running it again here (as every write-path `refresh()` below does) would be a
   * redundant duplicate query at startup.
   */
  async init(): Promise<void> {
    await Promise.all([this.fetchRail(), this.loadUserTags()]);
  }

  async loadUserTags(): Promise<void> {
    const names = await this.api.listUserTags();
    runInAction(() => {
      this.userTagNames = names;
    });
  }

  async toggleFavorite(row: SampleRow): Promise<void> {
    await this.api.setFavorite(row.id, !row.favorite);
    await this.refresh();
  }

  async setNickname(sampleId: number, nickname: string | null): Promise<void> {
    await this.api.setNickname(sampleId, nickname);
    await this.refresh();
  }

  async addTag(sampleId: number, name: string): Promise<void> {
    await this.api.addUserTag(sampleId, name);
    await Promise.all([this.refresh({ tags: true }), this.loadUserTags()]);
  }

  async removeTag(sampleId: number, name: string): Promise<void> {
    await this.api.removeUserTag(sampleId, name);
    await Promise.all([this.refresh({ tags: true }), this.loadUserTags()]);
  }

  // The `try` covers ONLY the invoke — a name collision (rejected `createCollection`) is the one
  // failure this method's contract turns into `{ error }` for the popover to render inline. A
  // successful create whose FOLLOW-UP `refresh()` fails is a different failure entirely (the
  // collection now exists server-side; nothing about that is a naming problem), so it must not be
  // reported as `{ error }` — indistinguishable from a collision, it would invite a caller to
  // retry the same name and hit a REAL collision on top of the write that already succeeded.
  // `refresh()` runs outside the `try`, same posture as every other action's post-write refresh:
  // a failure there surfaces uncaught. (Fix round 1 — review finding; regression test:
  // "a refresh failure AFTER a successful create propagates as a rejection, not { error }".)
  async createCollection(name: string): Promise<{ id: string } | { error: string }> {
    let result: { id: string };
    try {
      result = await this.api.createCollection(name);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    await this.refresh();
    return result;
  }

  // Mirrors createCollection's narrowed `try` above — same fix, same reasoning.
  async renameCollection(id: string, name: string): Promise<{ error: string } | null> {
    try {
      await this.api.renameCollection(id, name);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    await this.refresh();
    return null;
  }

  /**
   * Deleting the collection currently scoping the row list must not leave that scope pointing at
   * an id that no longer exists — `library.setScope(null)` runs BEFORE the delete (and therefore
   * before `refresh()`'s re-query) so the row list falls back to "All Samples" instead of
   * re-querying a now-deleted collection id.
   */
  async deleteCollection(id: string): Promise<void> {
    const scope = this.library.filters.scope;
    if (scope?.kind === 'collection' && scope.collectionId === id) {
      this.library.setScope(null);
    }
    await this.api.deleteCollection(id);
    await this.refresh();
  }

  async addToCollection(collectionId: string, sampleId: number): Promise<void> {
    await this.api.addToCollection(collectionId, sampleId);
    await this.refresh();
  }

  async removeFromCollection(collectionId: string, sampleId: number): Promise<void> {
    await this.api.removeFromCollection(collectionId, sampleId);
    await this.refresh();
  }

  // Task 11 (design spec §5.3): open-state transitions for the tags/collection popovers and the
  // inline nickname editor. Pure synchronous UI state — no `api` call, unlike every write action
  // above — so these five are plain fields-only actions. Opening either popover kind or starting
  // a nickname edit clears the OTHER surface's open-state, so at most one editing affordance is
  // ever live at once: without that, a popover left open on one row while a context-menu action
  // starts a nickname edit on another (or the same) row would show two uncoordinated edit
  // surfaces at once, and Esc — which "unwinds one layer" per spec §5.4 — would only ever reach
  // whichever one's own listener happens to catch it first. `TagsPopover`'s own `loadUserTags()`
  // call on mount is what spec §5.3's "loaded via loadUserTags() on popover open" describes (see
  // `userTagNames`'s own field comment above) — deliberately not reproduced here, so this stays a
  // plain, synchronously-testable state transition like the other four.
  openTagsPopover(sampleId: number): void {
    this.nicknameEditId = null;
    this.openPopover = { kind: 'tags', sampleId };
  }

  openCollectionPopover(sampleId: number): void {
    this.nicknameEditId = null;
    this.openPopover = { kind: 'collection', sampleId };
  }

  closePopover(): void {
    this.openPopover = null;
  }

  startNicknameEdit(sampleId: number): void {
    this.openPopover = null;
    this.nicknameEditId = sampleId;
  }

  stopNicknameEdit(): void {
    this.nicknameEditId = null;
  }

  private async fetchRail(): Promise<void> {
    const rail = await this.api.listLibraryRail();
    runInAction(() => {
      this.favoritesCount = rail.favorites;
      this.collections = rail.collections;
    });
  }

  /**
   * The shared post-write sync: every mutation above (except a failed create/rename) ends here.
   * Always re-fetches the rail and re-runs the library's current query — a favorite/nickname/tag/
   * collection-membership change can change what a live filter/scope should show, not just the
   * rail counts. `opts.tags` additionally re-fetches the tag facet list, scoped to the two actions
   * that can change which tags even exist (`addTag`/`removeTag`). The three sub-fetches are
   * mutually independent (no sub-fetch reads another's result) but run sequentially rather than
   * via `Promise.all`, matching this method's own doc-order — simplicity over the marginal
   * latency win on what is always a post-write, not a startup-path, refresh.
   */
  private async refresh(opts?: { tags?: boolean }): Promise<void> {
    await this.fetchRail();
    await this.library.rerun();
    if (opts?.tags) {
      await this.library.refreshTags();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
