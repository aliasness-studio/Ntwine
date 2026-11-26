// LibraryStore: the single source of browsing state — packs/tags for the rail and
// filter chips, the current (already-queried) row set, and the peaks cache the waveform
// thumbnails read from. Every filter-shaped action (search, scope, type, bpm, key, tag) mutates
// `filters` then re-queries; `filters` always mirrors the QueryFilters object the LAST
// `querySamples` call was actually made with — there is no separate "pending" filter state to
// reconcile against it.
import { makeAutoObservable, observable, runInAction, toJS } from 'mobx';
import './configure';
import type {
  NtwineApi,
  PackRow,
  QueryFilters,
  SampleRow,
  Scope,
  TagFacet,
} from '../../shared/ipcTypes';

// Instant-as-you-type search: short enough to feel live, long enough that a fast
// typist's keystrokes collapse into one query instead of one per character.
const SEARCH_DEBOUNCE_MS = 50;

// Back-stack depth. Deep enough that "back" always covers a real browsing session, bounded so a
// long-lived window can't grow the stack without limit.
const HISTORY_LIMIT = 50;

function sameScope(a: Scope | undefined, b: Scope | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'pack' && b.kind === 'pack') return a.packId === b.packId;
  if (a.kind === 'collection' && b.kind === 'collection') return a.collectionId === b.collectionId;
  return true; // both 'favorites' — no payload to compare
}

/**
 * Value equality over the whole filter set, so a re-click that changes nothing (the same pack
 * twice, the same key from two different rows) can be dropped before it costs a history entry and
 * a re-query. Every QueryFilters field is a primitive except `scope` (a small tagged union) and
 * `tags` (an order-insensitive set), which get their own comparisons below. Exported for its own
 * unit tests — the "back went nowhere" bug this prevents is invisible from the outside.
 */
export function sameFilters(a: QueryFilters, b: QueryFilters): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof QueryFilters>;
  for (const key of keys) {
    if (key === 'scope') {
      if (!sameScope(a.scope, b.scope)) return false;
    } else if (key === 'tags') {
      const at = a.tags ?? [];
      const bt = b.tags ?? [];
      if (at.length !== bt.length || !at.every((t) => bt.includes(t))) return false;
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export class LibraryStore {
  packs: PackRow[] = [];
  tags: TagFacet[] = [];
  rows: SampleRow[] = [];
  filters: QueryFilters = {};
  searchText = '';
  loading = false;
  peaksCache = new Map<number, ArrayBuffer>();

  // Browser-style back stack: every filter-shaped change snapshots the
  // state it replaced, so following a link out of a row — pack, key, bpm, tag — is always
  // reversible. Oldest-first; `back()` pops the tail.
  //
  // A snapshot is `filters` ALONE, never a filters+searchText pair, because `searchText` is not
  // independent state at a restorable point: the box is set synchronously on every keystroke while
  // `filters.search` only lands after the debounce, so a captured `searchText` records a moment
  // mid-typing that was never actually queried. Every APPLIED state satisfies
  // `searchText === filters.search ?? ''`, so `back()` derives the box from the filters it
  // restores and the two can't disagree by construction.
  history: QueryFilters[] = [];

  // What produced the top history entry, so a run of same-kind changes collapses into ONE entry
  // instead of one per event. Without it, typing "kick" leaves up to four entries behind and
  // "back" has to be pressed four times to undo one search. Bookkeeping, not app state — but
  // left observable (unlike `searchDebounceHandle`) since nothing needs it excluded.
  historyCoalesceKey: string | null = null;

  // Debounce-timer bookkeeping, not app state — no UI ever reads it, so it's excluded from the
  // observable graph below (same reasoning as `api`). Not `private` — same
  // `makeAutoObservable`-overrides limitation described just below applies here too.
  searchDebounceHandle: ReturnType<typeof setTimeout> | null = null;

  // `api` is a plain (not `private`) field, assigned in the constructor body — NOT the
  // `constructor(private readonly api: NtwineApi)` parameter-property shorthand used elsewhere in
  // this repo. Two real TypeScript limitations forced this, both confirmed empirically with a
  // throwaway repro before landing this: (1) a parameter-property member isn't visible to `keyof
  // this` inside `makeAutoObservable`'s overrides type at all, and (2) even declared manually,
  // marking the field `private` ALSO excludes it from that same `keyof this` — only `readonly`
  // (no `private`) survives. Either way `{ api: false }` below would fail to typecheck ("'api'
  // does not exist in type AnnotationsMap<this, never>"). TS's `private` is compile-time-only
  // access control regardless, so this doesn't weaken any actual encapsulation.
  readonly api: NtwineApi;

  constructor(api: NtwineApi) {
    this.api = api;
    // `api` is an injected dependency, not reactive app state — excluded from MobX's observable
    // graph (the documented pattern for constructor-injected collaborators) rather than left to
    // the default auto-inference, which would otherwise wrap it as a deep observable for no
    // benefit.
    // `history` is SHALLOW: an observable array deep-converts whatever is pushed
    // into it, so plain snapshots would be re-wrapped as proxies the moment they were stored.
    // Nothing ever mutates a history entry — they are pushed and popped whole — so deep
    // observability buys nothing and costs both a conversion per push and the guarantee that a
    // snapshot is an inert value.
    makeAutoObservable(this, {
      api: false,
      searchDebounceHandle: false,
      history: observable.shallow,
    });
  }

  get resultCount(): number {
    return this.rows.length;
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  /** How many dimensions are currently narrowing the view — each tag counts separately, since
   * each is independently removable. Reads `filters.search` rather than `searchText` so it
   * describes what the CURRENT rows were queried with, not a keystroke still inside the debounce. */
  get activeFilterCount(): number {
    const f = this.filters;
    let count = 0;
    if (f.scope !== undefined) count += 1;
    if (f.sampleType !== undefined) count += 1;
    if (f.audioKey !== undefined) count += 1;
    if (f.bpmMin !== undefined || f.bpmMax !== undefined) count += 1; // one "BPM" dimension
    if (f.search !== undefined) count += 1;
    count += f.tags?.length ?? 0;
    return count;
  }

  /**
   * Loads the rail (packs) and the tag-chip facet list, THEN runs one initial unfiltered query
   * so `rows` isn't empty until the user's first filter/search action — browsing is the
   * default view ("All Samples"), not an empty list waiting for input.
   */
  async init(): Promise<void> {
    this.loading = true;
    const [packs, tags] = await Promise.all([this.api.listPacks(), this.api.listTags()]);
    runInAction(() => {
      this.packs = packs;
      this.tags = tags;
    });
    await this.rerun();
  }

  /**
   * Re-fetches just the tag facet list (`listTags()`), leaving `packs`/`rows` untouched —
   * UserLayerStore calls this after a user-tag add/remove so a brand-new tag's chip (or a tag's
   * last removal) shows up in the facet list without re-fetching packs too, which `init()` would
   * do unnecessarily.
   */
  async refreshTags(): Promise<void> {
    const tags = await this.api.listTags();
    runInAction(() => {
      this.tags = tags;
    });
  }

  /**
   * Debounced 50ms: `searchText` updates synchronously on every call (so a controlled input
   * never lags a keystroke) but the actual re-query — and `filters.search` — only lands after
   * the debounce settles, so a fast typist's intermediate strings never reach `querySamples` at
   * all.
   */
  setSearch(s: string): void {
    this.searchText = s;
    if (this.searchDebounceHandle !== null) {
      clearTimeout(this.searchDebounceHandle);
    }
    this.searchDebounceHandle = setTimeout(() => this.applyDebouncedSearch(s), SEARCH_DEBOUNCE_MS);
  }

  /**
   * Restores the previous browse state — the back button, Alt+Left, and the only way out of a
   * link followed from a row. Restoring is NOT itself a history event (that would make back a
   * no-op loop between two states), so it bypasses `patchFilters` entirely and re-queries directly.
   */
  back(): void {
    const previous = this.history.pop();
    if (previous === undefined) return;
    // A search typed a moment ago may still have a timer in flight; letting it land would re-apply
    // the very search this restore just undid.
    this.cancelPendingSearch();
    this.historyCoalesceKey = null;
    this.filters = previous;
    this.searchText = previous.search ?? '';
    void this.rerun();
  }

  /**
   * Clears the search box and its filter IMMEDIATELY — for the search crumb's ✕, which is a
   * discrete control like every other crumb's, not a keystroke. Routing it
   * through `setSearch('')` would make it the one crumb that doesn't take effect until a debounce
   * elapses, and it would coalesce into whatever typing run preceded it instead of being its own
   * back step.
   */
  clearSearch(): void {
    this.cancelPendingSearch();
    this.searchText = '';
    this.patchFilters({ search: undefined });
  }

  /** Drops every filter at once (the "Clear all" affordance) as ONE reversible step. */
  clearFilters(): void {
    if (this.activeFilterCount === 0) return;
    this.pushHistory(null);
    this.cancelPendingSearch();
    this.filters = {};
    this.searchText = '';
    void this.rerun();
  }

  setScope(scope: Scope | null): void {
    this.patchFilters({ scope: scope ?? undefined });
  }

  toggleType(t: 'oneshot' | 'loop'): void {
    this.patchFilters({ sampleType: this.filters.sampleType === t ? undefined : t });
  }

  // Coalesced like search, and for the same reason: FilterPanel's number inputs fire per
  // keystroke, so typing "128" would otherwise leave three history entries behind.
  setBpmRange(min: number | null, max: number | null): void {
    this.patchFilters({ bpmMin: min ?? undefined, bpmMax: max ?? undefined }, 'bpm');
  }

  setKey(k: string | null): void {
    this.patchFilters({ audioKey: k ?? undefined });
  }

  /** Follow a row's BPM link: narrow to exactly that tempo. Separate from `setBpmRange` because
   * it's one deliberate navigation rather than a keystroke inside a run — it must NOT coalesce,
   * or following two different tempos in a row would collapse into a single back step. */
  filterByBpm(bpm: number): void {
    this.patchFilters({ bpmMin: bpm, bpmMax: bpm });
  }

  toggleTag(t: string): void {
    const current = this.filters.tags ?? [];
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    this.patchFilters({ tags: next.length > 0 ? next : undefined });
  }

  /** Merges into `peaksCache`; ids already cached are never re-requested (no wasted IPC hop). */
  async fetchPeaks(ids: number[]): Promise<void> {
    const missing = ids.filter((id) => !this.peaksCache.has(id));
    if (missing.length === 0) return;
    const result = await this.api.getPeaks(missing);
    runInAction(() => {
      for (const [idStr, buf] of Object.entries(result)) {
        this.peaksCache.set(Number(idStr), buf);
      }
    });
  }

  // A class method — auto-wrapped as a MobX action by `makeAutoObservable` — so invoking it from
  // the debounce timer's callback (a plain, non-action closure) still runs this method's own
  // synchronous body inside a proper action. That's what makes the direct `this.filters =`
  // mutation inside `patchFilters` (called from here) safe under `enforceActions: 'observed'`
  // without a separate `runInAction` wrapper at the call site.
  private applyDebouncedSearch(s: string): void {
    this.searchDebounceHandle = null;
    // Coalesced: a run of typing leaves ONE history entry — the state before the user started
    // typing — instead of one per debounce window.
    this.patchFilters({ search: s === '' ? undefined : s }, 'search');
  }

  private cancelPendingSearch(): void {
    if (this.searchDebounceHandle !== null) {
      clearTimeout(this.searchDebounceHandle);
      this.searchDebounceHandle = null;
    }
  }

  /**
   * Snapshots the state a change is about to replace. `coalesceKey` names the kind of change:
   * consecutive pushes sharing a key keep the FIRST snapshot (the state before the run began) and
   * discard the rest, which is what makes one back press undo one typed search rather than one
   * keystroke. A null key never coalesces.
   */
  private pushHistory(coalesceKey: string | null): void {
    if (coalesceKey !== null && coalesceKey === this.historyCoalesceKey) return;
    this.historyCoalesceKey = coalesceKey;
    // `toJS`, not a spread: a spread is SHALLOW, so `tags` (an array) and `scope`
    // (an object) would stay aliased to the live filters, and every entry would carry MobX proxies
    // into the history. `toJS` deep-copies and strips observables, so a snapshot is an inert value
    // that no later edit — in place or otherwise — can reach back and change.
    this.history.push(toJS(this.filters));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  // A naive `{ ...this.filters, ...patch }` spread leaves a patch's
  // `undefined`-valued keys (e.g. `{ scope: undefined }` from `setScope(null)`) as stale OWN
  // properties instead of removing them — `querySamples` itself doesn't care (main-process
  // filters are read with `!== undefined` checks either way), but a future filter-chip/active-
  // count UI reading `Object.keys(store.filters)`/`Object.entries(...)` would show a phantom
  // entry for every dimension the user has ever touched-then-cleared this session. Deleting is
  // legal here (unlike a generic `keyof T`-indexed delete, which TS sometimes rejects) because
  // EVERY field of the concrete `QueryFilters` type is declared optional.
  private patchFilters(patch: Partial<QueryFilters>, coalesceKey: string | null = null): void {
    const merged: QueryFilters = { ...this.filters, ...patch };
    for (const key of Object.keys(merged) as (keyof QueryFilters)[]) {
      if (merged[key] === undefined) {
        delete merged[key];
      }
    }
    // A change that changes nothing (the same pack clicked twice, the same key followed from two
    // rows) must not cost a history entry — otherwise "back" appears broken: the first press
    // restores a state identical to the current one and the view doesn't move.
    if (sameFilters(this.filters, merged)) return;
    this.pushHistory(coalesceKey);
    this.filters = merged;
    void this.rerun();
  }

  // Public — UserLayerStore's private `refresh()` calls this
  // directly after a user-layer write (favorite/nickname/tag/collection membership) so the
  // CURRENT filters re-query against the just-changed catalog state, without UserLayerStore
  // reaching into `patchFilters`/`filters` itself or duplicating the `toJS` IPC-safety handling
  // below.
  async rerun(): Promise<void> {
    this.loading = true;
    // `toJS(this.filters)`, not `this.filters` directly: `makeAutoObservable` deep-wraps
    // object-typed fields as MobX observables (Proxies) by default, and `filters` isn't in the
    // constructor's `{ api: false, searchDebounceHandle: false }` exclusion list — it's real app
    // state, meant to be observed. That Proxy is exactly what a REAL `ipcRenderer.invoke` call
    // cannot structured-clone (found in manual testing against a real library: every query
    // rejected with "An object could not be cloned" the instant a genuine Electron IPC boundary
    // was involved — a test-double `api` never surfaces this, since a plain mock function call
    // never serializes its arguments at all). `toJS` recursively converts the observable graph
    // back to a plain object — mobx's own documented tool for exactly this "hand this to
    // something that doesn't understand observables" boundary.
    const rows = await this.api.querySamples(toJS(this.filters));
    runInAction(() => {
      this.rows = rows;
      this.loading = false;
    });
  }
}
