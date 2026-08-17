import type { Catalog } from './db';
import type { PackRow, QueryFilters, SampleRow, TagFacet } from '../../shared/ipcTypes';
import { searchIds } from './search';

// Driver-row shape for querySamples's row SELECT: camelCase output names (`AS`-aliased in the
// SQL itself) so the only translation left for the JS side is the boolean/tags fixups SQLite has
// no native type for. `sampleType`/`chordType` are narrowed to the schema's own CHECK-constraint
// values rather than left as `string` — the DB enforces them (db.test.ts pins the CHECK), so
// trusting them on the way back out is the same trust boundary `normalizeSample` establishes on
// the way in, not a second re-validation of the same fact.
interface SampleQueryRow {
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
  missing: number;
  hasPeaks: number;
  peaksFailed: number;
}

interface TagLinkRow {
  sampleId: number;
  name: string;
}

type Bound = string | number;

/**
 * Runs the samples list query used by browse + search (spec §7): composes `f`'s filters with
 * AND, and returns rows shaped for the UI (`missing`/`hasPeaks`/`peaksFailed` coerced to real
 * booleans, `tags` gathered into an array) rather than raw driver output.
 *
 * Two queries, not one: the row query (LEFT JOIN packs for `packName`, LEFT JOIN waveforms for
 * `hasPeaks`/`peaksFailed`) can't also carry tags without a sample_tags/tags join fanning every
 * multi-tag sample out into duplicate rows. So tags are fetched separately — `sample_id, name`
 * for exactly the ids the first query already returned — and grouped onto each row in JS.
 *
 * `hasPeaks`/`peaksFailed` read `waveforms.format`, not just row presence: Task 10 writes a
 * `format = 0` row for a failed decode specifically so "failed" is distinguishable from
 * "pending, no row yet" (spec §8's corrupt-file badge needs the distinction) — a bare
 * `sample_id IS NULL` check would have shown a failed decode as succeeded, since a `format = 0`
 * row still has a `sample_id`.
 *
 * BPM/key filters exclude unknown values for free: `s.bpm >= ?` (etc.) is SQL, and SQL's
 * three-valued logic means a NULL `bpm` makes the comparison NULL, not TRUE — WHERE only keeps
 * TRUE rows, so an unknown-bpm/-key row silently drops out of the result the moment either
 * filter is actually active (spec §3.1). No explicit `IS NOT NULL` is added, so as not to imply
 * the exclusion needs help it doesn't.
 */
export function querySamples(catalog: Catalog, f: QueryFilters): SampleRow[] {
  const { db } = catalog;

  // A blank/whitespace-only search is treated as "no search filter" rather than forwarded to
  // searchIds, which throws on exactly that input (its contract: "callers guard"). Once a real
  // query string IS present, a zero-match result must short-circuit here — a literal `id IN ()`
  // is a SQLite syntax error, not an empty result set — so the rest of the WHERE clause is never
  // even built, let alone run, for a search with no hits.
  let matchedIds: number[] | null = null;
  if (f.search !== undefined && f.search.trim() !== '') {
    matchedIds = searchIds(catalog, f.search);
    if (matchedIds.length === 0) return [];
  }

  const where: string[] = [];
  const params: Bound[] = [];

  if (f.packId !== undefined) {
    where.push('s.pack_id = ?');
    params.push(f.packId);
  }
  if (f.sampleType !== undefined) {
    where.push('s.sample_type = ?');
    params.push(f.sampleType);
  }
  if (f.bpmMin !== undefined) {
    where.push('s.bpm >= ?');
    params.push(f.bpmMin);
  }
  if (f.bpmMax !== undefined) {
    where.push('s.bpm <= ?');
    params.push(f.bpmMax);
  }
  if (f.audioKey !== undefined) {
    where.push('s.audio_key = ?');
    params.push(f.audioKey);
  }
  if (f.tags !== undefined && f.tags.length > 0) {
    // ALL listed tags, not any: a sample only qualifies if the junction join produces one
    // matching row per distinct wanted tag name. De-duped so a caller accidentally repeating a
    // tag name in the filter can't inflate the required count past what a real sample could ever
    // satisfy.
    const wanted = [...new Set(f.tags)];
    const placeholders = wanted.map(() => '?').join(', ');
    where.push(
      `s.id IN (
         SELECT st.sample_id FROM sample_tags st
         JOIN tags t ON t.id = st.tag_id
         WHERE t.name IN (${placeholders})
         GROUP BY st.sample_id
         HAVING COUNT(DISTINCT t.name) = ?
       )`,
    );
    params.push(...wanted, wanted.length);
  }
  if (matchedIds !== null) {
    where.push(`s.id IN (${matchedIds.map(() => '?').join(', ')})`);
    params.push(...matchedIds);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare<Bound[], SampleQueryRow>(
      `SELECT s.id AS id, s.filename AS filename, s.rel_path AS relPath, s.pack_id AS packId,
              p.name AS packName, s.sample_type AS sampleType, s.bpm AS bpm,
              s.audio_key AS audioKey, s.chord_type AS chordType, s.duration_ms AS durationMs,
              s.missing AS missing,
              CASE WHEN w.sample_id IS NOT NULL AND w.format != 0 THEN 1 ELSE 0 END AS hasPeaks,
              CASE WHEN w.sample_id IS NOT NULL AND w.format = 0 THEN 1 ELSE 0 END AS peaksFailed
       FROM samples s
       LEFT JOIN packs p ON p.id = s.pack_id
       LEFT JOIN waveforms w ON w.sample_id = s.id
       ${whereSql}
       ORDER BY p.name, s.filename, s.id`,
    )
    .all(...params);

  const tagsBySample = new Map<number, string[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const tagRows = db
      .prepare<number[], TagLinkRow>(
        `SELECT st.sample_id AS sampleId, t.name AS name
         FROM sample_tags st
         JOIN tags t ON t.id = st.tag_id
         WHERE st.sample_id IN (${ids.map(() => '?').join(', ')})
         ORDER BY t.name`,
      )
      .all(...ids);
    for (const tr of tagRows) {
      const tags = tagsBySample.get(tr.sampleId);
      if (tags) tags.push(tr.name);
      else tagsBySample.set(tr.sampleId, [tr.name]);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    relPath: r.relPath,
    packId: r.packId,
    packName: r.packName,
    sampleType: r.sampleType,
    bpm: r.bpm,
    audioKey: r.audioKey,
    chordType: r.chordType,
    durationMs: r.durationMs,
    missing: r.missing === 1,
    tags: tagsBySample.get(r.id) ?? [],
    hasPeaks: r.hasPeaks === 1,
    peaksFailed: r.peaksFailed === 1,
  }));
}

/**
 * Left-rail pack list (spec §7): only packs with at least one non-missing sample (spec §2.2 —
 * "the UI hides packs with zero present samples"). The inner join's `AND s.missing = 0` does
 * double duty as both that filter (a pack with none present has no join rows at all, so it
 * disappears from the GROUP BY entirely) and the definition of `sampleCount` — deliberately a
 * count of *present* samples, not every row ever imported for that pack, so the number next to a
 * pack name always matches what selecting it actually shows as playable/draggable.
 */
export function listPacks(catalog: Catalog): PackRow[] {
  return catalog.db
    .prepare<[], PackRow>(
      `SELECT p.id AS id, p.name AS name, p.cover_file AS coverFile, COUNT(*) AS sampleCount
       FROM packs p
       JOIN samples s ON s.pack_id = p.id AND s.missing = 0
       GROUP BY p.id
       ORDER BY p.name, p.id`,
    )
    .all();
}

/**
 * Tag-chip facet (spec §7): every tag name in use, with a count of the non-missing samples
 * carrying it (same "present, not merely imported" reasoning as `listPacks`'s `sampleCount`),
 * highest-count first. Ties break alphabetically so the ordering is fully deterministic rather
 * than falling back to whatever order SQLite happens to visit rows in.
 */
export function listTags(catalog: Catalog): TagFacet[] {
  return catalog.db
    .prepare<[], TagFacet>(
      `SELECT t.name AS name, COUNT(*) AS count
       FROM sample_tags st
       JOIN tags t ON t.id = st.tag_id
       JOIN samples s ON s.id = st.sample_id AND s.missing = 0
       GROUP BY t.id
       ORDER BY count DESC, t.name ASC`,
    )
    .all();
}

interface PendingPeakIdRow {
  id: number;
}

/**
 * Ids of every non-missing sample with no `waveforms` row yet — Task 9's `runImport` calls this
 * once per pipeline run to hand off exactly the ids Task 10's background decode queue still
 * needs to process, and Task 10 will re-query it the same way on later runs. Lives here (not
 * inline in importer.ts) because both tasks need it.
 *
 * "No row" is the only pending signal: a sample with ANY `waveforms` row — succeeded
 * (`format != 0`) or a recorded failed decode (`format = 0`, the same distinction
 * `querySamples`'s `peaksFailed` column reads, added for Task 7 review round 1) — already has
 * an answer and is excluded either way. Retrying a failed decode is a deliberate future action
 * (Task 10's), never an accidental side effect of calling this again. `missing` samples are
 * excluded too — there is no file left to decode.
 */
export function pendingPeakIds(catalog: Catalog): number[] {
  return catalog.db
    .prepare<[], PendingPeakIdRow>(
      `SELECT s.id AS id
       FROM samples s
       LEFT JOIN waveforms w ON w.sample_id = s.id
       WHERE s.missing = 0 AND w.sample_id IS NULL
       ORDER BY s.id`,
    )
    .all()
    .map((r) => r.id);
}

// `waveforms.format` markers (schema comment, db.ts: "bump to invalidate/recompute"). 1 is the
// only real format so far; 0 is Task 10's own reserved "decode failed" marker — same row shape
// (the column is NOT NULL either way), just semantically empty. Named here so
// writePeaks/writePeaksFailed never repeat the bare literals without the explanation living next
// to them.
const PEAKS_FORMAT_CURRENT = 1;
const PEAKS_FORMAT_FAILED = 0;

// A failed decode still needs a NOT-NULL-satisfying `peaks` blob even though there's no real
// bucket data — 400 zero bytes (200 zeroed [min, max] pairs) at bucket_count 200, matching the
// exact fixture shape this file's own `pendingPeakIds`/`hasPeaks` tests already pinned for a
// format=0 row before this function existed (Task 7 review round 1).
const FAILED_PEAKS_PLACEHOLDER = Buffer.alloc(400);
const FAILED_BUCKET_COUNT = 200;

interface WaveformUpsertParams {
  sample_id: number;
  peaks: Buffer;
  bucket_count: number;
  format: number;
}

// Upsert, not a plain INSERT: `waveforms.sample_id` is the table's PRIMARY KEY, and a retried
// decode — most notably a previously-`writePeaksFailed` sample processed again by a later queue
// run, which `pendingPeakIds`'s own doc comment calls out as "a deliberate future action" — must
// be able to overwrite its own row (format 0 -> 1) rather than fail on the PK conflict a bare
// `INSERT` would raise.
const UPSERT_WAVEFORM_SQL = `
  INSERT INTO waveforms (sample_id, peaks, bucket_count, format)
  VALUES (@sample_id, @peaks, @bucket_count, @format)
  ON CONFLICT(sample_id) DO UPDATE SET
    peaks = excluded.peaks,
    bucket_count = excluded.bucket_count,
    format = excluded.format
`;

/**
 * Writes a successful decode's peak buckets (Task 10's `computePeaks` output) into the
 * `waveforms` table, keyed by `sample_id`. `bucket_count` is read off `peaks.length / 2` (two
 * bytes — one min, one max — per bucket) rather than hardcoded to 200, so a future non-default
 * `buckets` argument to `computePeaks` is recorded accurately instead of silently mislabeled.
 *
 * `peaks.length` must be even (whole [min, max] pairs) and > 0 — guarded here (review round 1)
 * rather than trusted, since `computePeaks` is the only producer today but this function has no
 * way to enforce that at the type level; an empty or odd-length array would otherwise silently
 * write a nonsensical `bucket_count` (0, or a fractional pair count truncated by `/ 2`).
 */
export function writePeaks(catalog: Catalog, sampleId: number, peaks: Int8Array): void {
  if (peaks.length === 0 || peaks.length % 2 !== 0) {
    throw new Error(
      `writePeaks: peaks.length must be even and > 0 (one [min, max] byte pair per bucket), got length ${peaks.length}`,
    );
  }
  const buf = Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength);
  catalog.db.prepare<WaveformUpsertParams>(UPSERT_WAVEFORM_SQL).run({
    sample_id: sampleId,
    peaks: buf,
    bucket_count: peaks.length / 2,
    format: PEAKS_FORMAT_CURRENT,
  });
}

/**
 * Records a failed decode as a `format = 0` waveforms row — the mechanism that makes "failed"
 * distinguishable from "pending, no row yet" (spec §8's corrupt-file badge; `SampleRow.hasPeaks`/
 * `peaksFailed`, Task 7 review round 1). The placeholder peaks/bucket_count values are never read
 * as real data: `querySamples`/`pendingPeakIds` both key off `format`, not `peaks` content, for
 * exactly this row.
 */
export function writePeaksFailed(catalog: Catalog, sampleId: number): void {
  catalog.db.prepare<WaveformUpsertParams>(UPSERT_WAVEFORM_SQL).run({
    sample_id: sampleId,
    peaks: FAILED_PEAKS_PLACEHOLDER,
    bucket_count: FAILED_BUCKET_COUNT,
    format: PEAKS_FORMAT_FAILED,
  });
}

interface PeaksRow {
  sample_id: number;
  peaks: Buffer;
}

/**
 * Raw peak bytes for the given sample ids, keyed by id — whatever `waveforms.peaks` currently
 * holds, `format` unfiltered (a failed decode's zeroed placeholder comes back too, same as a
 * real one). Filtering by success is `hasPeaks`/`peaksFailed`'s job (`querySamples`), not this
 * function's: a caller that already has those flags knows which ids are worth asking for, and a
 * `Record` has no clean way to say "excluded" apart from "absent" — which would collide with
 * "not decoded yet" if this function silently dropped failed rows too.
 *
 * `new Uint8Array(row.peaks).buffer` (not `row.peaks.buffer` directly): better-sqlite3 hands
 * back a Node `Buffer`, whose own `.buffer` may be a slice of a larger pooled ArrayBuffer (Node's
 * small-buffer allocator) — reading it directly could expose neighboring bytes. Constructing a
 * fresh `Uint8Array` from it copies into a new, exactly-sized buffer first.
 */
export function getPeaks(catalog: Catalog, sampleIds: number[]): Record<number, ArrayBuffer> {
  if (sampleIds.length === 0) return {};
  const rows = catalog.db
    .prepare<number[], PeaksRow>(
      `SELECT sample_id, peaks FROM waveforms WHERE sample_id IN (${sampleIds.map(() => '?').join(', ')})`,
    )
    .all(...sampleIds);

  const result: Record<number, ArrayBuffer> = {};
  for (const row of rows) {
    result[row.sample_id] = new Uint8Array(row.peaks).buffer;
  }
  return result;
}
