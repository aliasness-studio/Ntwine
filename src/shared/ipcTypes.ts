// Types shared between the main process and the renderer, across the IPC bridge. They live here —
// not in `src/main/catalog/queries.ts` — so that renderer code can import shapes without pulling
// in any main-process module (better-sqlite3 included), which the renderer must never touch
// directly.

// `SampleRow.peaksFailed`: the waveform queue (src/main/waveforms/queue.ts) writes a
// `waveforms` row with `format = 0` for a failed decode specifically so "failed" is
// distinguishable from "pending, no row yet" — `hasPeaks` alone couldn't carry that distinction once such rows exist.

// `favorite`/`nickname`/`userTags`: the same "connection-gated" shape `Scope` documents
// below — a `querySamples` call on a connection that never ran `openUserDb`
// (src/main/user/userDb.ts) still returns these three fields, at their zero value
// (`false`/`null`/`[]`), rather than omitting them. `userTags` is display names, A-Z
// (`localeCompare`, never SQL collation), same ordering contract as
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
// explicit 'all' variant — absence (`QueryFilters.scope === undefined`) IS "All Samples": "no
// scope" must serialize to an ABSENT key, the same
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

// `ImportProgress`: one event per phase per import-pipeline run.
// `runImport` (src/main/importer/importer.ts) only ever emits 'snapshot' | 'catalog' | 'stat' |
// 'covers' — each phase's start and completion, plus 'covers' may tick once per pack it
// actually attempts a fetch for — and a terminal 'error' event on any failure. 'waveforms' and
// 'done' come from ipc.ts's background peak-decode wiring (src/main/waveforms/queue.ts), after
// `runImport` has returned.
export interface ImportProgress {
  phase: 'snapshot' | 'catalog' | 'stat' | 'covers' | 'waveforms' | 'done' | 'error';
  done: number;
  total: number;
  message?: string;
}

// The picture that hangs off the cursor during a drag-out (2026-08-31). The renderer paints it —
// it is the only side with the waveform peaks, the pack art, the theme and a text-shaping engine
// (src/renderer/dragImage.ts) — and main only decodes it into a `NativeImage` (`resolveDragIcon`,
// src/main/drag.ts). A PNG data URL rather than a raw buffer because that is what `canvas.toDataURL`
// yields and what survives structured-clone across the bridge unchanged.
//
// `scaleFactor` is the RENDERER's `devicePixelRatio`, and it exists to CANCEL the display scaling
// rather than to describe the bitmap. What the OS draws is `pixels x display_scale / scaleFactor`;
// tagging the display's own factor makes that just `pixels`, which is what lets the card be sized
// against Windows' ~210px drag-image clip (DRAG_CARD in dragImage.ts has the measurement). Sending
// the wrong number here does not fail — it silently draws the card too large and the OS cuts its
// edges off.
export interface DragIcon {
  dataUrl: string;
  scaleFactor: number;
}

// THE bridge contract: everything the renderer can reach main through crosses this one object,
// exposed on `window.ntwine` by preload.ts's `contextBridge.exposeInMainWorld`. Renderer code
// imports this interface rather than reaching for ipcRenderer directly — the renderer never
// touches Electron IPC APIs or the filesystem/SQLite itself.
export interface NtwineApi {
  // `libraryRoot` is the EFFECTIVE root (ipc.ts's currentLibraryRoot), never null and never the
  // raw meta key: pre-import it's Splice's own reported folder, or the platform's stock location.
  getState(): Promise<{ imported: boolean; libraryRoot: string; spliceDbFound: boolean }>;
  runImport(): Promise<void>; // resolves when catalog+stat+covers done; waveforms continue
  onImportProgress(cb: (p: ImportProgress) => void): () => void;
  pickLibraryRoot(): Promise<string | null>;
  // Splice-DB picker fallback: null = dialog canceled; rejects (user-facing message via
  // ipcError.ts) when the picked file fails validation. On success the path is persisted
  // (meta.splice_db_path) and wins over detection while the file exists.
  pickSpliceDb(): Promise<string | null>;
  listPacks(): Promise<PackRow[]>;
  listTags(): Promise<TagFacet[]>; // feeds the tag chips (top-N by count, full list searchable)
  querySamples(f: QueryFilters): Promise<SampleRow[]>; // whole result set — 4.2k rows max, one IPC hop
  getPeaks(sampleIds: number[]): Promise<Record<number, ArrayBuffer>>;
  decodePreviewPcm(
    sampleId: number,
  ): Promise<{ sampleRate: number; channels: Float32Array[] } | null>; // the ONE PCM-over-IPC exception — capped + off-main, see below
  // An `invoke`, not an `ipcRenderer.send` — `webContents.startDrag`
  // (drag.ts) blocks the main process until the OS drag session ends, so this invoke's resolution
  // IS the drag-end signal the drag-into-collection slot needs.
  //
  // `icon` (2026-08-31) is the drag card the renderer painted for this sample — see `DragIcon`.
  // Optional: main falls back to its own generated square for any caller that omits it or sends
  // something it won't decode, so a drag never fails over its picture.
  startDrag(sampleId: number, icon?: DragIcon | null): Promise<void>;
  sampleUrl(sampleId: number): string; // `sample://s/${id}` — pure string helper
  coverUrl(packId: number): string; // `cover://p/${id}`

  // User layer. Every write below resolves `sampleId -> file_hash` inside
  // main (ipc.ts); the renderer never sees a hash. `createCollection`/`renameCollection` reject
  // on a normalized-name collision with a DIFFERENT collection — surfaced inline at the editor.
  setFavorite(sampleId: number, on: boolean): Promise<void>;
  setNickname(sampleId: number, nickname: string | null): Promise<void>; // null clears; trimmed; '' -> null
  listUserTags(): Promise<string[]>; // display names A-Z, for autocomplete
  addUserTag(sampleId: number, name: string): Promise<void>;
  removeUserTag(sampleId: number, name: string): Promise<void>;
  listLibraryRail(): Promise<{
    favorites: number; // present-only count
    collections: { id: string; name: string; count: number }[]; // A-Z, present-only counts
  }>;
  createCollection(name: string): Promise<{ id: string }>; // name-collision -> error
  renameCollection(id: string, name: string): Promise<void>; // name-collision -> error
  deleteCollection(id: string): Promise<void>; // items cascade; samples untouched
  addToCollection(collectionId: string, sampleId: number): Promise<void>;
  removeFromCollection(collectionId: string, sampleId: number): Promise<void>;

  // Self-update. Main owns
  // the updater (src/main/updater.ts); in dev, e2e and Linux runs it never starts, and these
  // still answer — `getUpdateState` is a permanent `idle`, `installUpdate` a no-op.
  getUpdateState(): Promise<UpdateState>;
  onUpdateState(cb: (s: UpdateState) => void): () => void; // 'ntwine:update-state' broadcast, once per transition
  installUpdate(): Promise<void>; // quits and installs only when `ready`; otherwise a no-op
  openReleasesPage(): Promise<void>; // opens RELEASES_URL — fixed in main, never renderer-supplied
  getAppVersion(): Promise<string>; // app.getVersion()
}

// Self-update: what the renderer is told about Electron's `autoUpdater`,
// as decided by the pure state machine in src/main/updater.ts. Deliberately coarse — checking
// and ordinary network failures are `idle` (silent, retried on the next tick). `downloading`
// covers the gap between Electron's `update-available` and `update-downloaded`, which on a large
// Mac bundle can run for minutes; Squirrel reports no progress, so it carries none. A download
// that fails for an ordinary reason falls back to `idle`. Beyond that the user only hears "an
// update is ready, restart to install" or, for the one failure a retry can never fix (a
// code-signature mismatch), "download it yourself" with a link to `RELEASES_URL`.
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'downloading' } // found and downloading; no progress is available
  | { kind: 'ready'; version: string } // downloaded; restart installs
  | { kind: 'failed'; reason: 'signature'; downloadUrl: string }; // code-signature mismatch only
// The single GitHub repo slug: the update feed (src/main/updater.ts) and RELEASES_URL both derive
// from it. forge.config.ts's iconUrl repeats it as a literal (build config cannot import app source).
export const UPDATE_REPO = 'aliasness-studio/Ntwine';
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
