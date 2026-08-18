import { app, dialog, ipcMain, net, utilityProcess } from 'electron';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Catalog } from './catalog/db';
import { getPeaks, listPacks, listTags, pendingPeakIds, querySamples } from './catalog/queries';
import type { E2EEmit } from './e2e';
import { runImport as runImportPipeline, statPass, type ImportDeps } from './importer/importer';
import { resolveSpliceDbCandidates } from './paths';
import { resolveSampleAbsPath } from './protocol';
import type { UserDb } from './user/userDb';
import { runPeaksQueue, WORKER_PATH, type WorkerLike } from './waveforms/queue';
import type { ImportProgress, QueryFilters } from '../shared/ipcTypes';

// spec §5 step 1: "default library root ~/Splice" — used only when `meta.library_root` hasn't
// been set yet (first launch, before any import or pickLibraryRoot has run).
const DEFAULT_LIBRARY_ROOT = join(homedir(), 'Splice');

/**
 * The current effective library root: whatever's persisted in `meta.library_root`, or a default —
 * the spec's `~/Splice` unless a caller supplies its own (Task 1: E2E mode's `NTWINE_LIBRARY_ROOT`
 * override, main.ts's `e2e?.libraryRoot`). A persisted root always wins over EITHER default — an
 * E2E run must not silently override a library root the user already picked via pickLibraryRoot
 * inside that same E2E userData dir. Exported so main.ts can build the SAME live getter it hands
 * to `registerProtocols`/`registerDragHandler` — one definition of "what's the current root"
 * (owner's "one question, two gates" rule), not three independently-computed ones that could
 * drift the moment a fourth consumer forgets the default.
 */
export function currentLibraryRoot(catalog: Catalog, defaultRoot: string = DEFAULT_LIBRARY_ROOT): string {
  return catalog.getMeta('library_root') ?? defaultRoot;
}

// Splice DB discovery (spec §5 step 1) answered once here and reused by both `getState`'s
// `spliceDbFound` and `runImport`'s own `spliceDbPath` — the same "one question, two gates"
// reasoning as `currentLibraryRoot` above. `resolveSpliceDbCandidates` can return more than one
// hit (multiple Splice user profiles); the first is as good a guess as any today — v1 has no UI
// to choose among candidates.
function findSpliceDbPath(): string | null {
  const candidates = resolveSpliceDbCandidates(app.getPath('appData'));
  return candidates.length > 0 ? candidates[0] : null;
}

export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const PREVIEW_MAX_SECONDS = 60;

export interface DecodePreviewPcmDeps {
  // Same `(sampleId) => absPath | null` shape as drag.ts's `registerDragHandler` — in production
  // both are `resolveSampleAbsPath` closed over the live catalog/libraryRoot (see main.ts); a
  // test can stub this directly without a real catalog, which is what "a stubbed resolver" in
  // the Task 11 brief's Step 7 refers to.
  resolvePath: (sampleId: number) => string | null;
  forkWorker: () => WorkerLike;
  // Injected so the byte-cap test doesn't need a real 50 MB fixture file on disk — defaults to
  // the real node:fs statSync in production.
  statFn?: (path: string) => { size: number };
}

interface PcmWorkerReplyOk {
  sampleId: number;
  ok: true;
  sampleRate: number;
  channels: ArrayBuffer[];
}
interface PcmWorkerReplyFail {
  sampleId: number;
  ok: false;
  error?: string;
}
type PcmWorkerReply = PcmWorkerReplyOk | PcmWorkerReplyFail;

/**
 * The §4 "ONE exception": decodes a sample's full PCM for the AIFF preview fallback (spec §9.3)
 * — off the main event loop (through the same one-shot-per-call `forkWorker` seam queue.ts uses
 * for the background peaks pass, `kind: 'pcm'` instead of the default peaks path — see
 * peaksWorker.ts), size- and duration-capped so a renderer bug or a hostile sample can't hand
 * the main process gigabytes of PCM.
 *
 * Two caps, checked at two different times because only one of them CAN be checked early:
 * `PREVIEW_MAX_BYTES` is a `statSync` on the resolved path, BEFORE forking a worker at all — no
 * point spinning up a decode for a file this large. `PREVIEW_MAX_SECONDS` can only be known AFTER
 * decode (`channels[0].length / sampleRate`) — file size on disk doesn't reliably predict decoded
 * duration (compression, bit depth, channel count all vary it), so the worker always runs first
 * and this is a post-hoc refusal, not a pre-flight one. Either refusal returns null, never throws
 * — "no library sample is near either limit" (Task 11 brief) makes this a hard-abuse guard, not a
 * real-world UX path.
 */
export async function decodePreviewPcm(
  deps: DecodePreviewPcmDeps,
  sampleId: number,
): Promise<{ sampleRate: number; channels: Float32Array[] } | null> {
  const absPath = deps.resolvePath(sampleId);
  if (absPath === null) return null;

  const stat = deps.statFn ?? statSync;
  let size: number;
  try {
    size = stat(absPath).size;
  } catch {
    return null; // vanished between resolve and stat — same "nothing to serve" outcome as missing=1.
  }
  if (size > PREVIEW_MAX_BYTES) return null;

  const worker = deps.forkWorker();
  const reply = await new Promise<PcmWorkerReply>((resolve) => {
    worker.on('message', (m) => resolve(m as PcmWorkerReply));
    worker.postMessage({ sampleId, absPath, kind: 'pcm' });
  });
  worker.kill(); // one-shot: fork, one message, kill on reply — win or lose.

  if (!reply.ok) return null;

  const channels = reply.channels.map((buf) => new Float32Array(buf));
  if (channels.length === 0) return null;
  if (channels[0].length / reply.sampleRate > PREVIEW_MAX_SECONDS) return null;

  return { sampleRate: reply.sampleRate, channels };
}

export interface RegisterIpcDeps {
  catalog: Catalog;
  // Task 6: the user-layer CRUD surface (src/main/user/userDb.ts) — `openUserDb` has already run
  // by the time this is wired (main.ts's whenReady), so every handler below can call straight
  // through to it.
  userDb: UserDb;
  snapshotDir: string;
  coversDir: string;
  // Forwards one ImportProgress event to the renderer (main.ts wires this to
  // `mainWindow.webContents.send('ntwine:import-progress', p)` — kept as an injected callback
  // here so ipc.ts itself never needs to know about BrowserWindow).
  sendProgress: (p: ImportProgress) => void;
  // Task 1 (E2E mode): overrides currentLibraryRoot's fallback default at every call site below —
  // main.ts wires this to `e2e?.libraryRoot`, undefined outside E2E mode (production behaviour
  // unchanged).
  defaultLibraryRoot?: string;
  e2eEmit?: E2EEmit | null;
}

export interface RunWaveformsInBackgroundDeps {
  catalog: Catalog;
  libraryRoot: string;
  sendProgress: (p: ImportProgress) => void;
  forkWorker: () => WorkerLike;
}

/**
 * Shared by the runImport handler (with the ids `runImportPipeline` just produced) and the
 * startup-resume path (with whatever `pendingPeakIds` still finds outstanding) — both mean "run
 * the background decode queue for these ids, forwarding progress as 'waveforms' events, and
 * announce 'done' once the queue drains." One definition, two callers.
 *
 * Both call sites are fire-and-forget with no try/catch of their own — the startup-resume one
 * runs unconditionally on every cold launch once `imported = 1` — so this function must never
 * let ANY failure escape as an unhandled rejection or a synchronous throw. `runPeaksQueue`'s own
 * doc comment names a real rejection path ("only rejects if forkWorker itself throws
 * synchronously while priming the pool" — a broken install missing peaksWorker.js beside
 * main.js, or resource exhaustion, not a hypothetical), which the `.catch()` below handles; the
 * outer try/catch additionally covers a synchronous throw from anything evaluated before
 * `runPeaksQueue` returns a promise at all (a bare `.catch()` on the chain would not catch
 * that). Either failure degrades to "placeholders stay pending" — logged, swallowed — never a
 * crashed app.
 */
export function runWaveformsInBackground(
  deps: RunWaveformsInBackgroundDeps,
  sampleIds: number[],
): void {
  try {
    runPeaksQueue({
      catalog: deps.catalog,
      libraryRoot: deps.libraryRoot,
      sampleIds,
      forkWorker: deps.forkWorker,
      onProgress: (done, total) => deps.sendProgress({ phase: 'waveforms', done, total }),
    })
      .then(() => {
        deps.sendProgress({ phase: 'done', done: sampleIds.length, total: sampleIds.length });
      })
      .catch((err: unknown) => {
        console.error(
          'runWaveformsInBackground: background waveform pass failed — placeholders remain pending',
          err,
        );
      });
  } catch (err) {
    console.error(
      'runWaveformsInBackground: failed to start the background waveform pass — placeholders remain pending',
      err,
    );
  }
}

/**
 * Wires one `ipcMain.handle` per `NtwineApi` method (channel names `ntwine:<method>`) onto
 * `deps`. `startDrag` isn't here — it's wired by drag.ts's own `registerDragHandler`, called
 * separately from main.ts; as of Task 6 that's ALSO `ipcMain.handle` (promoted from `.on` so
 * `webContents.startDrag`'s blocking-until-drag-end becomes the invoke's own resolution, design
 * spec §4), just not registered from this function. `sampleUrl`/`coverUrl` aren't here either —
 * pure template-string helpers built entirely in preload.ts, no IPC round-trip.
 *
 * Every query-style handler (`querySamples`/`listPacks`/`listTags`/`getPeaks`) is safe to call
 * before any import has ever run: `openCatalog` always creates a valid (if empty) schema, so
 * these just return `[]`/`{}` from ordinary SQL over empty tables — no special-casing needed, and
 * no handler here ever throws for "nothing imported yet." The Task 6 user-layer handlers below
 * share that discipline for a different reason: `openUserDb` (main.ts) always creates its own
 * valid-if-empty schema too, and a sampleId that resolves to no catalog row is a silent no-op
 * (see `hashOf`), never a throw — a renderer racing a since-changed result set is routine, not an
 * error.
 */
export function registerIpc(deps: RegisterIpcDeps): void {
  const { catalog, userDb } = deps;

  // One definition of "the deps runWaveformsInBackground needs," built fresh at each call site
  // (libraryRoot is re-read live, not cached — see currentLibraryRoot's own doc comment) rather
  // than duplicated inline at both the runImport handler and the startup-resume block below.
  const waveformDeps = (): RunWaveformsInBackgroundDeps => ({
    catalog,
    libraryRoot: currentLibraryRoot(catalog, deps.defaultLibraryRoot),
    sendProgress: deps.sendProgress,
    forkWorker: () => utilityProcess.fork(WORKER_PATH),
  });

  ipcMain.handle('ntwine:getState', async () => ({
    // Reads the exact meta keys `runImport` writes (importer.ts) — 'imported' and
    // 'library_root' — so this can never drift from what a successful import actually stamped.
    imported: catalog.getMeta('imported') === '1',
    libraryRoot: catalog.getMeta('library_root'),
    spliceDbFound: findSpliceDbPath() !== null,
  }));

  ipcMain.handle('ntwine:runImport', async () => {
    const importDeps: ImportDeps = {
      catalog,
      libraryRoot: currentLibraryRoot(catalog, deps.defaultLibraryRoot),
      spliceDbPath: findSpliceDbPath(),
      snapshotDir: deps.snapshotDir,
      coversDir: deps.coversDir,
      fetchFn: (url) => net.fetch(url),
    };
    // Resolves once catalog+stat+covers are done (runImportPipeline's own contract) — waveforms
    // continue in the background after this handler's promise (and so the renderer's await)
    // already returned.
    const peakIds = await runImportPipeline(importDeps, (p) => deps.sendProgress(p));
    runWaveformsInBackground(waveformDeps(), peakIds);
  });

  ipcMain.handle('ntwine:pickLibraryRoot', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const newRoot = result.filePaths[0];
    // spec §8 "library root moved": persist the new root, re-check existence — NOT a re-import.
    catalog.setMeta('library_root', newRoot);
    statPass(catalog, newRoot);
    return newRoot;
  });

  ipcMain.handle('ntwine:listPacks', async () => listPacks(catalog));
  ipcMain.handle('ntwine:listTags', async () => listTags(catalog));
  ipcMain.handle('ntwine:querySamples', async (_event, f: QueryFilters) =>
    querySamples(catalog, f),
  );
  ipcMain.handle('ntwine:getPeaks', async (_event, sampleIds: number[]) =>
    getPeaks(catalog, sampleIds),
  );

  ipcMain.handle('ntwine:decodePreviewPcm', async (_event, sampleId: number) => {
    const result = await decodePreviewPcm(
      {
        resolvePath: (id) => resolveSampleAbsPath(catalog, currentLibraryRoot(catalog, deps.defaultLibraryRoot), id),
        forkWorker: () => utilityProcess.fork(WORKER_PATH),
      },
      sampleId,
    );
    deps.e2eEmit?.('ntwine:e2e:preview-pcm', { sampleId, ok: result !== null });
    return result;
  });

  // sampleId -> file_hash for every user-layer write below (design spec §4: "the renderer never
  // sees hashes"). Deliberately a bare `.prepare()` per call, not a hoisted statement like the
  // rest of this module's hot paths — these are user-triggered one-at-a-time writes (a heart
  // click, a tag add), never a per-row query loop. An id with no matching row (stale renderer
  // state — the row was deleted/re-imported since the id was read) resolves to null; every
  // handler below treats null as "nothing to do," never a throw.
  const hashOf = (sampleId: number): string | null =>
    (
      catalog.db.prepare('SELECT file_hash AS h FROM samples WHERE id = ?').get(sampleId) as
        | { h: string }
        | undefined
    )?.h ?? null;

  // User layer (Task 6, design spec §4). Synchronous SQLite under the hood throughout (better-
  // sqlite3, via userDb) — no handler here awaits anything internally, the same discipline
  // querySamples/listPacks/listTags above already keep: handlers answering in registration order
  // is what keeps LibraryStore's un-sequenced re-queries safe. `createCollection`/
  // `renameCollection` deliberately do NOT catch `UserNameError` — an invoke rejection carries
  // `.message` straight back to the renderer's inline editor error (spec §2.3/§5.1/§5.3).
  ipcMain.handle('ntwine:setFavorite', async (_event, sampleId: number, on: boolean) => {
    const hash = hashOf(sampleId);
    if (hash === null) return;
    userDb.setFavorite(hash, on);
  });

  ipcMain.handle('ntwine:setNickname', async (_event, sampleId: number, nickname: string | null) => {
    const hash = hashOf(sampleId);
    if (hash === null) return;
    userDb.setNickname(hash, nickname);
  });

  ipcMain.handle('ntwine:listUserTags', async () => userDb.listUserTagNames());

  ipcMain.handle('ntwine:addUserTag', async (_event, sampleId: number, name: string) => {
    const hash = hashOf(sampleId);
    if (hash === null) return;
    userDb.addUserTag(hash, name);
  });

  ipcMain.handle('ntwine:removeUserTag', async (_event, sampleId: number, name: string) => {
    const hash = hashOf(sampleId);
    if (hash === null) return;
    userDb.removeUserTag(hash, name);
  });

  ipcMain.handle('ntwine:listLibraryRail', async () => userDb.listLibraryRail());

  ipcMain.handle('ntwine:createCollection', async (_event, name: string) => userDb.createCollection(name));

  ipcMain.handle('ntwine:renameCollection', async (_event, id: string, name: string) => {
    userDb.renameCollection(id, name);
  });

  ipcMain.handle('ntwine:deleteCollection', async (_event, id: string) => {
    userDb.deleteCollection(id);
  });

  ipcMain.handle('ntwine:addToCollection', async (_event, collectionId: string, sampleId: number) => {
    const hash = hashOf(sampleId);
    if (hash === null) return;
    userDb.addToCollection(collectionId, hash);
  });

  ipcMain.handle('ntwine:removeFromCollection', async (_event, collectionId: string, sampleId: number) => {
    const hash = hashOf(sampleId);
    if (hash === null) return;
    userDb.removeFromCollection(collectionId, hash);
  });

  // Startup resume (spec §5 "resumable"): a quit mid-waveform-pass must not orphan pending
  // placeholder rows forever. Only when an import has actually completed — pre-import there are
  // no sample rows at all, so pendingPeakIds would just be a wasted empty query — and only when
  // there's real work outstanding, matching runWaveformsInBackground's own "fire-and-forget"
  // framing rather than firing an unsolicited 'waveforms'/'done' pair at cold startup for
  // nothing to do.
  if (catalog.getMeta('imported') === '1') {
    const pending = pendingPeakIds(catalog);
    if (pending.length > 0) {
      runWaveformsInBackground(waveformDeps(), pending);
    }
  }
}
