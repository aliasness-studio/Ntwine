// Read-only renderer snapshot for the e2e suite (e2e spec §3.1). Types only — no runtime code.
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
}
