// LibraryStore (Task 12): the single source of browsing state — packs/tags for the rail and
// filter chips, the current (already-queried) row set, and the peaks cache the waveform
// thumbnails read from. Every filter-shaped action (search, pack, type, bpm, key, tag) mutates
// `filters` then re-queries; `filters` always mirrors the QueryFilters object the LAST
// `querySamples` call was actually made with — there is no separate "pending" filter state to
// reconcile against it.
import { makeAutoObservable, runInAction } from 'mobx';
import './configure';
import type { NtwineApi, PackRow, QueryFilters, SampleRow, TagFacet } from '../../shared/ipcTypes';

// spec §3.1 item 3 ("instant-as-you-type"): short enough to feel live, long enough that a fast
// typist's keystrokes collapse into one query instead of one per character.
const SEARCH_DEBOUNCE_MS = 50;

export class LibraryStore {
  packs: PackRow[] = [];
  tags: TagFacet[] = [];
  rows: SampleRow[] = [];
  filters: QueryFilters = {};
  searchText = '';
  loading = false;
  peaksCache = new Map<number, ArrayBuffer>();

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
    makeAutoObservable(this, { api: false, searchDebounceHandle: false });
  }

  get resultCount(): number {
    return this.rows.length;
  }

  /**
   * Loads the rail (packs) and the tag-chip facet list, THEN runs one initial unfiltered query
   * so `rows` isn't empty until the user's first filter/search action — spec §3.1 frames
   * browsing as the default view ("All Samples"), not an empty list waiting for input.
   */
  async init(): Promise<void> {
    this.loading = true;
    const [packs, tags] = await Promise.all([this.api.listPacks(), this.api.listTags()]);
    runInAction(() => {
      this.packs = packs;
      this.tags = tags;
    });
    await this.runQuery();
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

  setPack(id: number | null): void {
    this.patchFilters({ packId: id ?? undefined });
  }

  toggleType(t: 'oneshot' | 'loop'): void {
    this.patchFilters({ sampleType: this.filters.sampleType === t ? undefined : t });
  }

  setBpmRange(min: number | null, max: number | null): void {
    this.patchFilters({ bpmMin: min ?? undefined, bpmMax: max ?? undefined });
  }

  setKey(k: string | null): void {
    this.patchFilters({ audioKey: k ?? undefined });
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
    this.patchFilters({ search: s === '' ? undefined : s });
  }

  private patchFilters(patch: Partial<QueryFilters>): void {
    this.filters = { ...this.filters, ...patch };
    void this.runQuery();
  }

  private async runQuery(): Promise<void> {
    this.loading = true;
    const rows = await this.api.querySamples(this.filters);
    runInAction(() => {
      this.rows = rows;
      this.loading = false;
    });
  }
}
