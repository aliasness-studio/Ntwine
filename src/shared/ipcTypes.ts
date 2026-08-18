// Types shared between the main process and the (future) renderer, across the IPC bridge Task
// 11 wires up. They land here — not in `src/main/catalog/queries.ts` — so that later renderer
// code can import shapes without pulling in any main-process module (better-sqlite3 included),
// which the renderer must never touch directly (spec §4/§9.2).

// Field names/order/optionality transcribed verbatim from the Task 7 brief's Interfaces block,
// plus `SampleRow.peaksFailed` (Task 7 review round 1): Task 10 writes a `waveforms` row with
// `format = 0` for a failed decode specifically so "failed" is distinguishable from "pending, no
// row yet" — `hasPeaks` alone couldn't carry that distinction once such rows exist.

// `favorite`/`nickname`/`userTags` (Task 3): the same "connection-gated" shape `Scope` documents
// below — a `querySamples` call on a connection that never ran `openUserDb`
// (src/main/user/userDb.ts) still returns these three fields, at their zero value
// (`false`/`null`/`[]`), rather than omitting them. `userTags` is display names, A-Z
// (`localeCompare`, never SQL collation — Global Constraints), same ordering contract as
// `UserDb.listUserTagNames`.
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
  favorite: boolean;
  nickname: string | null;
  userTags: string[];
}

export interface PackRow {
  id: number;
  name: string;
  coverFile: string | null;
  sampleCount: number;
}

// `Scope` narrows `querySamples` to a pack, the favorites set, or a named collection. There is no
// explicit 'all' variant — absence (`QueryFilters.scope === undefined`) IS "All Samples": the
// spec's §8 fallout note requires "no scope" to serialize to an ABSENT key, the same
// undefined-deletes-the-key mechanism `LibraryStore.patchFilters` already uses for every other
// filter dimension, so `setScope(null)` round-trips to `{}` exactly like every other cleared
// filter does.
//
// `querySamples` (src/main/catalog/queries.ts) implements all three arms. `favorites`/
// `collection` are gated on whether the connection ever ran `openUserDb`
// (src/main/user/userDb.ts): on one that has not, both kinds short-circuit to `[]` rather than
// let the underlying SQL reference a `user` schema alias that was never ATTACHed.
export type Scope =
  | { kind: 'pack'; packId: number }
  | { kind: 'favorites' }
  | { kind: 'collection'; collectionId: string };

export interface QueryFilters {
  scope?: Scope;
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

// THE bridge contract (Task 11): everything the renderer can reach main through crosses this one
// object, exposed on `window.ntwine` by preload.ts's `contextBridge.exposeInMainWorld`. Every
// later renderer task (12-15) imports this interface rather than reaching for ipcRenderer
// directly — the renderer never touches Electron IPC APIs or the filesystem/SQLite itself (spec
// §4). Field order/signatures transcribed verbatim from the Task 11 brief's Interfaces block.
export interface NtwineApi {
  getState(): Promise<{ imported: boolean; libraryRoot: string | null; spliceDbFound: boolean }>;
  runImport(): Promise<void>; // resolves when catalog+stat+covers done; waveforms continue
  onImportProgress(cb: (p: ImportProgress) => void): () => void;
  pickLibraryRoot(): Promise<string | null>;
  listPacks(): Promise<PackRow[]>;
  listTags(): Promise<TagFacet[]>; // feeds the §7 tag chips (top-N by count, full list searchable)
  querySamples(f: QueryFilters): Promise<SampleRow[]>; // whole result set — 4.2k rows max, one IPC hop
  getPeaks(sampleIds: number[]): Promise<Record<number, ArrayBuffer>>;
  decodePreviewPcm(
    sampleId: number,
  ): Promise<{ sampleRate: number; channels: Float32Array[] } | null>; // §4's ONE exception — capped + off-main, see below
  // Task 6: promoted from `ipcRenderer.send` to `invoke` (design spec §4) — `webContents.startDrag`
  // (drag.ts) blocks the main process until the OS drag session ends, so this invoke's resolution
  // IS the drag-end signal the drag-into-collection slot (spec §7) needs.
  startDrag(sampleId: number): Promise<void>;
  sampleUrl(sampleId: number): string; // `sample://s/${id}` — pure string helper
  coverUrl(packId: number): string; // `cover://p/${id}`

  // User layer (Task 6, design spec §4): the bridge grows from 12 to 23 methods here — signatures
  // transcribed verbatim from spec §4. Every write below resolves `sampleId -> file_hash` inside
  // main (ipc.ts); the renderer never sees a hash. `createCollection`/`renameCollection` reject
  // (design spec §2.3) on a normalized-name collision with a DIFFERENT collection — surfaced
  // inline at the editor (spec §5.1/§5.3).
  setFavorite(sampleId: number, on: boolean): Promise<void>;
  setNickname(sampleId: number, nickname: string | null): Promise<void>; // null clears; trimmed; '' -> null
  listUserTags(): Promise<string[]>; // display names A-Z, for autocomplete
  addUserTag(sampleId: number, name: string): Promise<void>;
  removeUserTag(sampleId: number, name: string): Promise<void>;
  listLibraryRail(): Promise<{
    favorites: number; // present-only count
    collections: { id: string; name: string; count: number }[]; // A-Z, present-only counts
  }>;
  createCollection(name: string): Promise<{ id: string }>; // name-collision -> error (§2.3)
  renameCollection(id: string, name: string): Promise<void>; // name-collision -> error (§2.3)
  deleteCollection(id: string): Promise<void>; // items cascade; samples untouched
  addToCollection(collectionId: string, sampleId: number): Promise<void>;
  removeFromCollection(collectionId: string, sampleId: number): Promise<void>;
}
