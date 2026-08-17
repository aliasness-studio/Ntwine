// Types shared between the main process and the (future) renderer, across the IPC bridge Task
// 11 wires up. They land here — not in `src/main/catalog/queries.ts` — so that later renderer
// code can import shapes without pulling in any main-process module (better-sqlite3 included),
// which the renderer must never touch directly (spec §4/§9.2).

// Field names/order/optionality transcribed verbatim from the Task 7 brief's Interfaces block,
// plus `SampleRow.peaksFailed` (Task 7 review round 1): Task 10 writes a `waveforms` row with
// `format = 0` for a failed decode specifically so "failed" is distinguishable from "pending, no
// row yet" — `hasPeaks` alone couldn't carry that distinction once such rows exist.

export interface SampleRow {
  id: number;
  filename: string;
  relPath: string;
  packId: number | null;
  packName: string | null;
  sampleType: 'oneshot' | 'loop';
  bpm: number | null;
  audioKey: string | null;
  chordType: 'major' | 'minor' | null;
  durationMs: number | null;
  missing: boolean;
  tags: string[];
  hasPeaks: boolean;
  peaksFailed: boolean;
}

export interface PackRow {
  id: number;
  name: string;
  coverFile: string | null;
  sampleCount: number;
}

export interface QueryFilters {
  packId?: number;
  sampleType?: 'oneshot' | 'loop';
  bpmMin?: number;
  bpmMax?: number;
  audioKey?: string;
  tags?: string[];
  search?: string;
}

export interface TagFacet {
  name: string;
  count: number;
}

// `ImportProgress` (Task 9's Interfaces block): one event per phase per import-pipeline run.
// `runImport` (src/main/importer/importer.ts) only ever emits 'snapshot' | 'catalog' | 'stat' |
// 'covers' — each phase's start and completion, plus 'covers' may tick once per pack it
// actually attempts a fetch for — and a terminal 'error' event on any failure. 'waveforms' and
// 'done' are reserved for Task 10 (the background peak-decode queue) and Task 11 (the IPC
// wrapper) to emit once wired; they're part of the union now so the renderer's ImportStore can
// switch over the full phase set from day one, without a later widening migration.
export interface ImportProgress {
  phase: 'snapshot' | 'catalog' | 'stat' | 'covers' | 'waveforms' | 'done' | 'error';
  done: number;
  total: number;
  message?: string;
}
