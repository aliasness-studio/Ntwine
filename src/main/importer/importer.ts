import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Catalog } from '../catalog/db';
import type { ImportProgress } from '../../shared/ipcTypes';
import type { SplicePack, SpliceSample } from './spliceDb';
import { normalizeSample, relPathToAbs } from './transform';
import { rebuildSearch } from '../catalog/search';
import { readSplice, snapshotSpliceDb, type DownloadedSpliceSample } from './spliceDb';
import { downloadCovers, COVER_CANDIDATE_WHERE } from './covers';
import { pendingPeakIds } from '../catalog/queries';

interface IdRow {
  id: number;
}

interface SampleRelPathRow {
  id: number;
  rel_path: string;
}

interface PackUpsertParams {
  uuid: string;
  name: string;
  genre: string | null;
  provider_name: string | null;
  cover_url: string | null;
}

interface SampleUpsertParams {
  file_hash: string;
  rel_path: string;
  filename: string;
  pack_id: number | null;
  sample_type: string;
  bpm: number | null;
  audio_key: string | null;
  chord_type: string | null;
  duration_ms: number | null;
}

/**
 * Transactional upsert of one Splice snapshot read (`{ samples, packs }`, per Task 5's
 * `readSplice`) into Ntwine's catalog (spec §5 step 3). Idempotent by construction:
 *
 *  - packs upsert keyed on `splice_uuid` (the catalog schema's own UNIQUE column).
 *  - samples upsert keyed on `file_hash` (UNIQUE, NOT NULL) — `ON CONFLICT DO UPDATE`, so a
 *    re-run updates the existing row in place rather than deleting/reinserting. That matters:
 *    `sample_tags` and (later) `waveforms` reference `samples.id`, and Task 8's `missing` flag
 *    lives on the same row — none of that may get invalidated just by re-running import.
 *  - `missing` is deliberately left out of the UPDATE SET list: it's Task 8's existence-check
 *    column, and an upsert must never resurrect a row Task 8 already flagged missing=1 just
 *    because Splice's metadata for it happens not to have changed.
 *  - tags: `INSERT OR IGNORE` on `tags.name` (UNIQUE) so the tag vocabulary never duplicates,
 *    then each sample's `sample_tags` links are fully rebuilt (delete-then-reinsert) every
 *    run — not just appended — so a tag list that shrinks between imports doesn't leave stale
 *    links behind.
 *
 * `libraryRoot` and per-row normalization (null-sentinel mapping, rel_path, the
 * unknown-sample_type/out-of-root throws) are `normalizeSample`'s job; this function just
 * upserts what comes back. `normalizeSample` runs inside the same transaction, so one bad row
 * aborts the whole import atomically rather than leaving a half-written catalog.
 */
export function buildCatalog(
  catalog: Catalog,
  data: { samples: SpliceSample[]; packs: SplicePack[] },
  libraryRoot: string,
): void {
  const { db } = catalog;

  const upsertPack = db.prepare<PackUpsertParams>(
    `INSERT INTO packs (splice_uuid, name, genre, provider_name, cover_url)
     VALUES (@uuid, @name, @genre, @provider_name, @cover_url)
     ON CONFLICT(splice_uuid) DO UPDATE SET
       name = excluded.name,
       genre = excluded.genre,
       provider_name = excluded.provider_name,
       cover_url = excluded.cover_url`,
  );
  const findPackIdByUuid = db.prepare<[string], IdRow>(
    'SELECT id FROM packs WHERE splice_uuid = ?',
  );

  const upsertSample = db.prepare<SampleUpsertParams>(
    `INSERT INTO samples
       (file_hash, rel_path, filename, pack_id, sample_type, bpm, audio_key, chord_type, duration_ms)
     VALUES
       (@file_hash, @rel_path, @filename, @pack_id, @sample_type, @bpm, @audio_key, @chord_type, @duration_ms)
     ON CONFLICT(file_hash) DO UPDATE SET
       rel_path = excluded.rel_path,
       filename = excluded.filename,
       pack_id = excluded.pack_id,
       sample_type = excluded.sample_type,
       bpm = excluded.bpm,
       audio_key = excluded.audio_key,
       chord_type = excluded.chord_type,
       duration_ms = excluded.duration_ms`,
  );
  const findSampleIdByHash = db.prepare<[string], IdRow>(
    'SELECT id FROM samples WHERE file_hash = ?',
  );

  const upsertTagName = db.prepare<[string]>('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const findTagIdByName = db.prepare<[string], IdRow>('SELECT id FROM tags WHERE name = ?');
  const clearSampleTags = db.prepare<[number]>('DELETE FROM sample_tags WHERE sample_id = ?');
  const linkSampleTag = db.prepare<[number, number]>(
    'INSERT OR IGNORE INTO sample_tags (sample_id, tag_id) VALUES (?, ?)',
  );

  const run = db.transaction((input: { samples: SpliceSample[]; packs: SplicePack[] }) => {
    for (const pack of input.packs) {
      upsertPack.run({
        uuid: pack.uuid,
        name: pack.name,
        genre: pack.genre,
        provider_name: pack.provider_name,
        cover_url: pack.cover_url,
      });
    }

    // A mid-sync Splice DB really contains rows whose local_path is still NULL (file not yet
    // downloaded — proven live 2026-08-19: 46 of 4,197). Nothing to import for those: no path
    // to store, stat, play, or drag. Skipped, not fatal; the next (idempotent) re-import picks
    // them up once Splice fills the path in.
    const downloaded = input.samples.filter(
      (s): s is DownloadedSpliceSample => s.local_path !== null,
    );
    for (const sample of downloaded) {
      const n = normalizeSample(sample, libraryRoot);
      const packRow = n.packUuid !== null ? findPackIdByUuid.get(n.packUuid) : undefined;

      upsertSample.run({
        file_hash: n.fileHash,
        rel_path: n.relPath,
        filename: n.filename,
        pack_id: packRow ? packRow.id : null,
        sample_type: n.sampleType,
        bpm: n.bpm,
        audio_key: n.audioKey,
        chord_type: n.chordType,
        duration_ms: n.durationMs,
      });

      const sampleRow = findSampleIdByHash.get(n.fileHash);
      if (!sampleRow) {
        throw new Error(`buildCatalog: upserted sample "${n.fileHash}" but couldn't read it back`);
      }
      const sampleId = sampleRow.id;

      clearSampleTags.run(sampleId);
      for (const tag of n.tags) {
        upsertTagName.run(tag);
        const tagRow = findTagIdByName.get(tag);
        if (!tagRow) {
          throw new Error(`buildCatalog: upserted tag "${tag}" but couldn't read it back`);
        }
        linkSampleTag.run(sampleId, tagRow.id);
      }
    }

    rebuildSearch(catalog);
  });

  run(data);
}

/**
 * Existence pass (spec §5 step 4): stat every sample's file under `libraryRoot` and set/clear
 * `samples.missing` accordingly. Resolves each row's stored `rel_path` back to a native absolute
 * path via `transform.ts`'s `relPathToAbs` (shared with `queue.ts`'s `absPathsFor` — Task 10
 * review round 1 hoisted this out of two independently-maintained copies).
 *
 * Unconditional, not delta-only: every row gets its `missing` column freshly SET to the
 * just-observed 0/1 on every call, never merely set-when-newly-missing. That is what makes this
 * idempotent (`present`/`missing` counts and every row's flag are identical across repeat calls
 * with no filesystem change) *and* self-healing (a file that reappears — e.g. a reconnected
 * drive — flips its row's `missing` back to 0 on the very next pass, not just on the next
 * import).
 */
export function statPass(
  catalog: Catalog,
  libraryRoot: string,
): { present: number; missing: number } {
  const { db } = catalog;

  const rows = db.prepare<[], SampleRelPathRow>('SELECT id, rel_path FROM samples').all();
  const setMissing = db.prepare<[number, number]>('UPDATE samples SET missing = ? WHERE id = ?');

  let present = 0;
  let missing = 0;

  const run = db.transaction((toStat: SampleRelPathRow[]) => {
    for (const row of toStat) {
      const absPath = relPathToAbs(libraryRoot, row.rel_path);
      const exists = existsSync(absPath);
      setMissing.run(exists ? 0 : 1, row.id);
      if (exists) present++;
      else missing++;
    }
  });
  run(rows);

  return { present, missing };
}

// Named alias for `downloadCovers`'s own `fetchFn` parameter shape (covers.ts is the source of
// truth for the real signature; this is purely a convenience type for `ImportDeps` and its
// callers, so Task 11 doesn't have to repeat the structural type by hand when building one).
export type CoversFetch = (
  url: string,
) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;

// The real Splice metadata db is named this on every platform verified so far (spec §2.2;
// `paths.ts`'s own resolver glob ends in the same literal). `snapshotSpliceDb` preserves the
// source filename via `basename(src)`, so a prior snapshot in `snapshotDir` always lands at
// this same name too — which is what makes the fallback lookup below a plain `existsSync` on
// one known path rather than a directory scan.
const SPLICE_DB_FILENAME = 'sounds.db';

export interface ImportDeps {
  catalog: Catalog;
  libraryRoot: string;
  spliceDbPath: string | null;
  snapshotDir: string;
  coversDir: string;
  fetchFn: CoversFetch;
  // Injected clock for `meta.imported_at` (an ISO string) — defaults to the real wall clock.
  // Tests pin a fixed value so the meta round-trip assertion isn't a moving target.
  now?: () => string;
}

interface CoverCandidateCountRow {
  n: number;
}

/**
 * Count of packs `downloadCovers` might actually call `fetchFn` for, so the covers phase's
 * reported `total` means "candidates downloadCovers would consider," not just "every pack in
 * the catalog." Built from `COVER_CANDIDATE_WHERE` — covers.ts's own exported fragment — rather
 * than a second hand-written copy of the same condition (owner's "one question, two gates"
 * rule: this count and `downloadCovers`'s own query must answer "is this pack a candidate" from
 * ONE shared definition, not two independently-maintained ones that could silently drift). A
 * skip-existing candidate (already cached on disk) still counts here — this is "how many are
 * worth considering," not "how many will actually hit the network" — which is why the
 * covers-phase completion event below always reports `done === total` regardless of how many of
 * those candidates turned out to be skip-existing.
 */
function countCoverCandidates(catalog: Catalog): number {
  const row = catalog.db
    .prepare<[], CoverCandidateCountRow>(
      `SELECT COUNT(*) AS n FROM packs WHERE ${COVER_CANDIDATE_WHERE}`,
    )
    .get();
  return row ? row.n : 0;
}

/**
 * Runs the whole import pipeline (spec §5 steps 2-5) in order — snapshot, catalog build,
 * existence check, covers — reporting one start and one completion `ImportProgress` event per
 * phase via `onProgress` (`covers` additionally ticks once per pack it actually attempts a
 * fetch for). Resolves with the ids of every non-missing sample that has no `waveforms` row yet
 * (`pendingPeakIds`) — the seam Task 10's background decode queue consumes. This function never
 * decodes audio or touches the `waveforms` table itself.
 *
 * `runImport`/`ImportDeps` IS the `LibraryImporter` seam spec §3.2 promises ("the importer is
 * behind a LibraryImporter interface so a second strategy slots in without surgery"): there is
 * no separate marker interface to implement — a second strategy (e.g. a future NI-expansions
 * importer) is simply another `runImport`-shaped async function accepting the same `ImportDeps`
 * shape, swappable wherever Task 11's IPC handler calls this one.
 *
 * Snapshot resolution (spec §5 step 2): `deps.spliceDbPath` wins when given — copied into
 * `snapshotDir` via `snapshotSpliceDb`. When it's `null` (the live Splice db couldn't be
 * located this run), a snapshot already sitting in `snapshotDir` from a previous run is read in
 * place instead — NOT re-copied onto itself, which would be both unnecessary (it already IS the
 * snapshot) and unsafe (`copyFileSync` with an identical source/destination path is not a
 * defined no-op). Only when neither exists does this reject, naming the one path it looked for
 * so the caller can surface something better than a bare ENOENT.
 *
 * Any failure — including the neither-source case above — is reported as one final
 * `{ phase: 'error' }` progress event before the promise rejects, so a progress-only listener
 * (e.g. the renderer's ImportStore) can learn why a run stopped without wrapping every call in
 * its own try/catch.
 */
export async function runImport(
  deps: ImportDeps,
  onProgress: (p: ImportProgress) => void,
): Promise<number[]> {
  const now = deps.now ?? (() => new Date().toISOString());

  try {
    // --- snapshot (spec §5 step 2) -----------------------------------------
    const priorSnapshotPath = join(deps.snapshotDir, SPLICE_DB_FILENAME);
    onProgress({
      phase: 'snapshot',
      done: 0,
      total: 1,
      message:
        deps.spliceDbPath !== null
          ? `Copying Splice database from "${deps.spliceDbPath}"…`
          : `No Splice database path given — looking for a prior snapshot at "${priorSnapshotPath}"…`,
    });

    let snapshotPath: string;
    if (deps.spliceDbPath !== null) {
      snapshotPath = snapshotSpliceDb(deps.spliceDbPath, deps.snapshotDir);
    } else if (existsSync(priorSnapshotPath)) {
      snapshotPath = priorSnapshotPath; // already the snapshot — read in place, don't re-copy.
    } else {
      throw new Error(
        `runImport: no Splice database available — no path was given, and no prior snapshot ` +
          `exists at "${priorSnapshotPath}"`,
      );
    }
    onProgress({
      phase: 'snapshot',
      done: 1,
      total: 1,
      message: `Snapshot ready: "${snapshotPath}"`,
    });

    // --- catalog (spec §5 step 3) -------------------------------------------
    onProgress({ phase: 'catalog', done: 0, total: 1, message: 'Reading Splice metadata…' });
    const data = readSplice(snapshotPath);
    buildCatalog(deps.catalog, data, deps.libraryRoot);
    // Count what buildCatalog actually imported vs the rows Splice hasn't downloaded yet
    // (local_path NULL, skipped there) — mid-sync, the honest number is both.
    const pending = data.samples.filter((s) => s.local_path === null).length;
    onProgress({
      phase: 'catalog',
      done: 1,
      total: 1,
      message:
        `Imported ${data.samples.length - pending} samples, ${data.packs.length} packs` +
        (pending > 0 ? ` (${pending} not downloaded yet — re-run import once Splice finishes)` : ''),
    });

    // --- stat (spec §5 step 4) -----------------------------------------------
    onProgress({ phase: 'stat', done: 0, total: 1, message: 'Checking files on disk…' });
    const { present, missing } = statPass(deps.catalog, deps.libraryRoot);
    onProgress({
      phase: 'stat',
      done: 1,
      total: 1,
      message: `${present} present, ${missing} missing`,
    });

    // --- covers (spec §5 step 5) -----------------------------------------------
    const coverTotal = countCoverCandidates(deps.catalog);
    onProgress({
      phase: 'covers',
      done: 0,
      total: coverTotal,
      message: 'Downloading pack covers…',
    });
    let coverTicks = 0;
    // Wraps the caller's fetchFn purely to observe each attempt as a progress tick —
    // downloadCovers itself has no progress hook, so this is the only seam available without
    // reaching into (or duplicating) its skip/tolerate logic. try/finally ticks on both a
    // resolved AND a rejected fetch, since downloadCovers's own try/catch is what turns a
    // rejection into a counted `failed` — this wrapper must not swallow or alter that.
    const tickingFetch: CoversFetch = async (url) => {
      try {
        return await deps.fetchFn(url);
      } finally {
        coverTicks++;
        onProgress({ phase: 'covers', done: coverTicks, total: coverTotal, message: url });
      }
    };
    const { ok, failed } = await downloadCovers(deps.catalog, deps.coversDir, tickingFetch);
    onProgress({
      phase: 'covers',
      done: coverTotal,
      total: coverTotal,
      message: `${ok} covers downloaded, ${failed} failed`,
    });

    // Meta stamps land only after every phase above has actually completed (per the brief: "after
    // the covers phase completes") — a run that throws partway through must never look imported.
    deps.catalog.setMeta('imported', '1');
    deps.catalog.setMeta('library_root', deps.libraryRoot);
    deps.catalog.setMeta('imported_at', now());

    return pendingPeakIds(deps.catalog);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', done: 0, total: 0, message });
    throw err;
  }
}
