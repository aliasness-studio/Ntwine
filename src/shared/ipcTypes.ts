// Types shared between the main process and the (future) renderer, across the IPC bridge Task
// 11 wires up. They land here — not in `src/main/catalog/queries.ts` — so that later renderer
// code can import shapes without pulling in any main-process module (better-sqlite3 included),
// which the renderer must never touch directly (spec §4/§9.2).

// Field names/order/optionality transcribed verbatim from the Task 7 brief's Interfaces block.

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
