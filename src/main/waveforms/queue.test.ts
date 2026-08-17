import { describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../catalog/db';
import { buildFixtureSpliceDb, type FixtureRow } from '../importer/fixtureSpliceDb';
import { readSplice } from '../importer/spliceDb';
import { buildCatalog } from '../importer/importer';
import { pendingPeakIds, querySamples } from '../catalog/queries';
import { runPeaksQueue, type WorkerLike } from './queue';

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-queue-'));
const freshCatalog = () => openCatalog(join(tmp(), 'catalog.db'));

// More ids than the 3-worker concurrency ceiling, so "<=3 in flight" and "exactly 3 forked" are
// both real constraints rather than trivially true for a smaller list.
const SAMPLE_COUNT = 5;

function setUp() {
  const libraryRoot = tmp();
  const dbPath = join(tmp(), 'sounds.db');
  const rows: FixtureRow[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    rows.push({
      table: 'samples',
      file_hash: `h-${i}`,
      local_path: join(libraryRoot, 'sounds', 'packs', 'Fixture Pack', `s${i}.wav`),
      filename: `s${i}.wav`,
      sample_type: 'oneshot',
    });
  }
  buildFixtureSpliceDb(dbPath, rows);
  const data = readSplice(dbPath);
  const catalog = freshCatalog();
  buildCatalog(catalog, data, libraryRoot);
  const ids = catalog.db
    .prepare<[], { id: number }>('SELECT id FROM samples ORDER BY id')
    .all()
    .map((r) => r.id);
  return { catalog, libraryRoot, ids };
}

// Tracks how many fake workers are simultaneously "processing" a message — i.e. have received a
// postMessage but not yet replied — across every fake worker `runPeaksQueue` forks. This is the
// "fakes' concurrency counter" the brief asks the test to assert against.
class ConcurrencyTracker {
  current = 0;
  peak = 0;
  enter(): void {
    this.current++;
    this.peak = Math.max(this.peak, this.current);
  }
  exit(): void {
    this.current--;
  }
}

// `kill` is surfaced as its own field (a properly-typed `Mock<() => void>`) alongside the plain
// `WorkerLike` rather than as a same-named override of `WorkerLike['kill']` on an extended
// interface: a `vi.fn()` mock's type is deliberately broader than the plain `() => void` method
// signature it implements (it carries `.mock.calls` etc.), and re-declaring an inherited method
// with a incompatible-looking (if structurally fine) broader type on an `extends`ed interface is
// exactly the kind of thing TS's stricter interface-extension check rejects — a plain sibling
// field sidesteps that without weakening what's actually asserted on `kill`.
interface FakeWorker {
  worker: WorkerLike;
  kill: Mock<() => void>;
}

/**
 * A WorkerLike fake that answers every message "immediately" (via a microtask, not
 * synchronously — a synchronous reply could never let two postMessage calls overlap, which
 * would make the concurrency assertions below vacuously true no matter what runPeaksQueue does)
 * with a canned 400-byte ok reply, or `{ ok: false }` for any sampleId in `failingIds`. Any
 * postMessage received while a PRIOR message on the same fake is still unanswered is recorded in
 * `violations` instead of thrown — a throw inside a microtask callback wouldn't surface as a
 * clean test failure.
 */
function makeFakeWorker(opts: {
  tracker: ConcurrencyTracker;
  failingIds: Set<number>;
  violations: string[];
}): FakeWorker {
  let onMessage: ((m: unknown) => void) | null = null;
  let busy = false;
  const kill = vi.fn<() => void>();

  const worker: WorkerLike = {
    postMessage: (m: unknown) => {
      const { sampleId } = m as { sampleId: number; absPath: string };
      if (busy) {
        opts.violations.push(`worker received sampleId ${sampleId} while still processing another`);
      }
      busy = true;
      opts.tracker.enter();
      queueMicrotask(() => {
        opts.tracker.exit();
        busy = false;
        const reply = opts.failingIds.has(sampleId)
          ? { sampleId, ok: false, error: 'simulated decode failure' }
          : { sampleId, ok: true, peaks: new ArrayBuffer(400) };
        onMessage?.(reply);
      });
    },
    on: (_ev: 'message', cb: (m: unknown) => void) => {
      onMessage = cb;
    },
    kill,
  };

  return { worker, kill };
}

describe('runPeaksQueue', () => {
  it(
    'processes all ids with <=3 concurrent workers, forks exactly 3, kills all on drain, ' +
      'writes format=0 for the failing id, ticks progress once per id, and clears pendingPeakIds',
    async () => {
      const { catalog, libraryRoot, ids } = setUp();
      const failingId = ids[2];
      const tracker = new ConcurrencyTracker();
      const violations: string[] = [];
      const fakeWorkers: FakeWorker[] = [];

      const forkWorker = vi.fn(() => {
        const fake = makeFakeWorker({ tracker, failingIds: new Set([failingId]), violations });
        fakeWorkers.push(fake);
        return fake.worker;
      });
      const progressCalls: Array<[number, number]> = [];

      await runPeaksQueue({
        catalog,
        libraryRoot,
        sampleIds: ids,
        forkWorker,
        onProgress: (done, total) => progressCalls.push([done, total]),
      });

      // "one message each at a time" per worker — never violated.
      expect(violations).toEqual([]);
      // "<=3 in flight" — and it actually reached the ceiling at least once, so this isn't
      // vacuously true for an accidentally-sequential implementation.
      expect(tracker.peak).toBeLessThanOrEqual(3);
      expect(tracker.peak).toBe(3);
      // "fork ONE utilityProcess per in-flight slot (3 processes)".
      expect(forkWorker).toHaveBeenCalledTimes(3);
      // "kill all on drain".
      expect(fakeWorkers).toHaveLength(3);
      for (const w of fakeWorkers) expect(w.kill).toHaveBeenCalledTimes(1);

      // "progress ticks n times" — once per id, ending at done === total.
      expect(progressCalls).toHaveLength(ids.length);
      expect(progressCalls.map(([done]) => done)).toEqual([1, 2, 3, 4, 5]);
      expect(progressCalls.every(([, total]) => total === ids.length)).toBe(true);

      // ok ids: hasPeaks true. The failing id: peaksFailed true, hasPeaks false (Task 7's
      // format-based distinction, exercised end-to-end through the real writePeaks/
      // writePeaksFailed + querySamples).
      const rows = querySamples(catalog, {});
      for (const id of ids.filter((i) => i !== failingId)) {
        expect(rows.find((r) => r.id === id)).toMatchObject({ hasPeaks: true, peaksFailed: false });
      }
      expect(rows.find((r) => r.id === failingId)).toMatchObject({
        hasPeaks: false,
        peaksFailed: true,
      });
      // The failed row's shape matches the precedent queries.test.ts already pins for a
      // format=0 row (Task 7 review round 1): a 400-byte zeroed placeholder, bucket_count 200.
      const failedRaw = catalog.db
        .prepare('SELECT bucket_count, format FROM waveforms WHERE sample_id = ?')
        .get(failingId) as { bucket_count: number; format: number };
      expect(failedRaw).toEqual({ bucket_count: 200, format: 0 });

      // "pendingPeakIds excludes both ok AND failed rows afterward".
      expect(pendingPeakIds(catalog)).toEqual([]);
    },
  );

  it('a reply for a sampleId with no samples row does not wedge the queue (persistence failure treated like a decode failure)', async () => {
    const { catalog, libraryRoot, ids } = setUp();
    // waveforms.sample_id REFERENCES samples(id), and this catalog's foreign_keys pragma is ON
    // by default (confirmed empirically, same as fixtureSpliceDb.ts's own note) — so writing a
    // waveforms row for an id with no samples row throws a FOREIGN KEY SqliteError. `bogusId` is
    // guaranteed not to collide with any real fixture id.
    const bogusId = Math.max(...ids) + 1000;
    const allIds = [...ids, bogusId];
    const tracker = new ConcurrencyTracker();
    const violations: string[] = [];
    const fakeWorkers: FakeWorker[] = [];
    // Every reply is "ok" — the bogus id fails at PERSISTENCE (writePeaks throws), not at decode
    // (the fake never reports ok:false for it), which is the specific failure mode this test
    // targets: a throw from inside settle() itself, not a worker-reported decode failure.
    const forkWorker = vi.fn(() => {
      const fake = makeFakeWorker({ tracker, failingIds: new Set(), violations });
      fakeWorkers.push(fake);
      return fake.worker;
    });
    const progressCalls: Array<[number, number]> = [];

    await runPeaksQueue({
      catalog,
      libraryRoot,
      sampleIds: allIds,
      forkWorker,
      onProgress: (done, total) => progressCalls.push([done, total]),
    });

    // The queue still completes: one tick per id, ending at done === total.
    expect(progressCalls).toHaveLength(allIds.length);
    expect(progressCalls[progressCalls.length - 1]).toEqual([allIds.length, allIds.length]);
    // Every worker still gets killed on drain — the bad reply didn't leak one.
    for (const w of fakeWorkers) expect(w.kill).toHaveBeenCalledTimes(1);
    // The other (real) ids were processed normally — the one bad id didn't wedge the queue for
    // everyone else.
    for (const id of ids) {
      expect(querySamples(catalog, {}).find((r) => r.id === id)).toMatchObject({ hasPeaks: true });
    }
  });

  it('resolves without forking any worker when sampleIds is empty', async () => {
    const { catalog, libraryRoot } = setUp();
    const forkWorker = vi.fn();
    const progressCalls: Array<[number, number]> = [];

    await runPeaksQueue({
      catalog,
      libraryRoot,
      sampleIds: [],
      forkWorker,
      onProgress: (done, total) => progressCalls.push([done, total]),
    });

    expect(forkWorker).not.toHaveBeenCalled();
    expect(progressCalls).toEqual([]);
  });
});
