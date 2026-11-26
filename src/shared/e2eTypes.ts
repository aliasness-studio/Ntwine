// Read-only renderer snapshot for the e2e suite. Types only — no runtime code.
export interface E2ESnapshot {
  rows: number;
  resultCount: number;
  selectedId: number | null;
  volume: number;
  filters: Record<string, unknown>;
  importPhase: string | null;
  running: boolean;
  peaksCached: number;
  playCount: number;
  lastPlayedId: number | null;
  /** Transport dock (2026-08-23). `stopCount` is the only way a spec can observe Stop at all:
   * silence is not a DOM state, and the store deliberately leaves `selectedId` untouched, so
   * without a counter a Stop button wired to nothing would pass every assertion. `autoplay`
   * likewise makes "the click selected but did not sound" checkable as intent, not just as an
   * unchanged `playCount`. */
  stopCount: number;
  autoplay: boolean;
}
