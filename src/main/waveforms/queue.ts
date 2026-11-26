import { join } from 'node:path';
import type { Catalog } from '../catalog/db';
import { writePeaks, writePeaksFailed } from '../catalog/queries';
import { relPathToAbs } from '../importer/transform';

// Mirrors `utilityProcess.fork(...)`'s own return shape (Electron.UtilityProcess) narrowed down
// to exactly what this queue uses. Production passes a real utilityProcess handle; tests pass a
// fake — see the module doc comment on `runPeaksQueue` for why the real Electron API can't be
// called directly from here (or from a test run).
export interface WorkerLike {
  postMessage(m: unknown): void;
  on(ev: 'message', cb: (m: unknown) => void): void;
  kill(): void;
}

export interface RunPeaksQueueOptions {
  catalog: Catalog;
  libraryRoot: string;
  sampleIds: number[];
  concurrency?: number;
  forkWorker: () => WorkerLike;
  onProgress: (done: number, total: number) => void;
}

// peaksWorker.ts's own reply shape (see that file) — the `ok` discriminant is what a real
// utilityProcess message and a test fake's canned reply both key off of.
interface WorkerReplyOk {
  sampleId: number;
  ok: true;
  peaks: ArrayBuffer;
}
interface WorkerReplyFail {
  sampleId: number;
  ok: false;
  error?: string;
}
type WorkerReply = WorkerReplyOk | WorkerReplyFail;

const DEFAULT_CONCURRENCY = 3;

// The CJS main bundle emits `peaksWorker.js` beside `main.js` (vite.main.config.ts's second
// `rollupOptions.input` entry) — `__dirname` at runtime is `.vite/build/`, the same
// directory `main.js` itself resolves from once packaged. Exported so the real call site (ipc.ts's
// wiring) can build `() => utilityProcess.fork(WORKER_PATH)` without re-deriving
// this path. Evaluated at module load purely as a string — safe under `vitest` too, where
// `__dirname` points at the TS source directory instead and is simply never opened, since tests
// only ever inject a fake `forkWorker`.
export const WORKER_PATH = join(__dirname, 'peaksWorker.js');

interface SampleRelPathRow {
  id: number;
  rel_path: string;
}

// Resolves each id's stored `rel_path` back to a native absolute path via `transform.ts`'s
// `relPathToAbs` — shared with `importer.ts`'s `statPass` rather than two independently-maintained
// copies (see `relPathToAbs`'s own doc comment).
function absPathsFor(catalog: Catalog, libraryRoot: string, ids: number[]): Map<number, string> {
  if (ids.length === 0) return new Map();
  const rows = catalog.db
    .prepare<number[], SampleRelPathRow>(
      `SELECT id, rel_path FROM samples WHERE id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids);
  const map = new Map<number, string>();
  for (const row of rows) {
    map.set(row.id, relPathToAbs(libraryRoot, row.rel_path));
  }
  return map;
}

/**
 * Runs `sampleIds` through a fixed-size pool of `concurrency` (default 3) background decode
 * workers, writing each result into the catalog's `waveforms` table via `writePeaks`/
 * `writePeaksFailed`, and resolves once every id has settled. The main process never decodes
 * audio itself — every actual `decodeAudio`/`computePeaks` call happens inside a forked
 * `peaksWorker.ts` child, reached only through `forkWorker`/`WorkerLike`, never imported
 * directly here.
 *
 * Pool contract (binding): one `WorkerLike` is forked per in-flight slot — i.e.
 * `min(concurrency, sampleIds.length)` workers total, each a long-lived worker that is pumped
 * with its NEXT id only after replying to its current one ("one message at a time" per worker;
 * `min` rather than always forking exactly `concurrency` so an id list shorter than the
 * concurrency ceiling doesn't fork-then-immediately-idle workers that were never going to get
 * any work). Every worker is killed together once the LAST id anywhere in the pool settles
 * ("kill all on drain") — not as each individual worker's own share of the work runs out, which
 * is why an idle worker (its own ids exhausted, but the pool as a whole isn't done) is simply
 * left alone until that final drain.
 *
 * A per-id decode failure (`ok: false`) is not a queue failure: it's recorded via
 * `writePeaksFailed` (a `format = 0` row — queries.ts's "failed" vs. "pending" distinction) and the
 * queue continues; `runPeaksQueue`'s own promise only rejects if `forkWorker` itself throws
 * synchronously while priming the pool. `onProgress(done, total)` fires exactly once per settled
 * id (`done` 1..`total` in order — a single shared counter, so its value is monotonic regardless
 * of which worker's reply arrives in which order).
 *
 * Testability: `utilityProcess.fork` requires the full Electron app lifecycle, which isn't
 * available under this repo's test runner (`ELECTRON_RUN_AS_NODE=1`, so `process.type` is never
 * `'browser'`) — `forkWorker` is the injection seam that lets tests supply a `WorkerLike` fake
 * instead. Nothing else in this module touches `electron` at all.
 */
export function runPeaksQueue(opts: RunPeaksQueueOptions): Promise<void> {
  const { catalog, libraryRoot, sampleIds, forkWorker, onProgress } = opts;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const total = sampleIds.length;

  return new Promise((resolve) => {
    if (total === 0) {
      resolve();
      return;
    }

    const absPathById = absPathsFor(catalog, libraryRoot, sampleIds);
    const workerCount = Math.min(concurrency, total);
    const workers: WorkerLike[] = [];
    let cursor = 0;
    let done = 0;

    // A persistence failure (most notably: a reply for a sampleId with no matching `samples`
    // row — `waveforms.sample_id REFERENCES samples(id)`, and this catalog's `foreign_keys`
    // pragma defaults ON, so that INSERT throws) counts exactly like a decode failure, not a
    // queue failure: it must never escape uncaught (which — since this runs inside an
    // asynchronous worker-message callback, not the synchronous Promise executor body — would
    // NOT reject `runPeaksQueue`'s promise; it would surface as an unhandled exception while the
    // promise hangs forever, since `done` never reaches `total`). The nested try around the
    // `writePeaksFailed` fallback exists because IT can throw for the exact same FK reason (a
    // reply for an unknown sampleId, ok or not) — that second failure is logged and swallowed,
    // but `done`/`onProgress`/the next `pump`/the final kill-all must still happen regardless.
    const settle = (reply: WorkerReply): void => {
      try {
        if (reply.ok) {
          writePeaks(catalog, reply.sampleId, new Int8Array(reply.peaks));
        } else {
          writePeaksFailed(catalog, reply.sampleId);
        }
      } catch (err) {
        console.error(
          `runPeaksQueue: failed to persist a waveforms row for sampleId ${reply.sampleId}`,
          err,
        );
        try {
          writePeaksFailed(catalog, reply.sampleId);
        } catch (fallbackErr) {
          console.error(
            `runPeaksQueue: writePeaksFailed fallback also failed for sampleId ${reply.sampleId} — giving up on this id, continuing the queue`,
            fallbackErr,
          );
        }
      }
      done++;
      onProgress(done, total);
      if (done === total) {
        for (const w of workers) w.kill();
        resolve();
      }
    };

    const pump = (worker: WorkerLike): void => {
      if (cursor >= total) return; // nothing left — this worker goes idle until the final drain.
      const sampleId = sampleIds[cursor++];
      const absPath = absPathById.get(sampleId);
      worker.postMessage({ sampleId, absPath });
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = forkWorker();
      workers.push(worker);
      worker.on('message', (m) => {
        const reply = m as WorkerReply;
        settle(reply);
        pump(worker); // same worker, next id — "one message at a time".
      });
      pump(worker);
    }
  });
}
