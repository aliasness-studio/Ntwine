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
  // `fileHash` is `samples.file_hash` itself — always present regardless of `hasUser`, needed to
  // key the userTags lookup below. `favorite`/`nickname` are `0`/`NULL` on a connection without
  // the `user` schema attached (see `querySamples`'s `hasUser` gate).
  fileHash: string;
  favorite: number;
  nickname: string | null;
}

interface TagLinkRow {
  sampleId: number;
  name: string;
}

// Row shape for the userTags lookup query — same `sample_file_hash`/tag-name join `TagLinkRow`
// does for catalog tags, keyed by hash instead of id since `user.*` tables key off
// `sample_file_hash`, not the catalog's integer `samples.id`.
interface UserTagLinkRow {
  hash: string;
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
 *
 * User layer (Task 3, gated on `hasUser` — whether this connection ever ran `openUserDb`,
 * src/main/user/userDb.ts): `favorite`/`nickname` are a 1:1 LEFT JOIN inlined into the row query
 * (`user.sample_state`'s PK is `sample_file_hash`, so unlike tags it can never fan a row out).
 * `userTags` gets its own third query for the same fan-out reason `tags` does, over exactly the
 * hashes the row query returned, then grouped and sorted with `localeCompare` in JS — never SQL
 * `ORDER BY`, which would sort by BINARY collation instead (Global Constraints). Without
 * `hasUser`, every row reads its zero value (`favorite: false`, `nickname: null`,
 * `userTags: []`) and a `favorites`/`collection` scope short-circuits to `[]` before any SQL
 * referencing the `user` schema alias would run.
 */
export function querySamples(catalog: Catalog, f: QueryFilters): SampleRow[] {
  const { db } = catalog;

  // Whether this connection ever ran `openUserDb` (src/main/user/userDb.ts) — computed once per
  // call, not cached on `Catalog`, since ATTACH could in principle happen after a `Catalog` is
  // already held elsewhere and a cached answer would go stale silently. Gates the
  // favorite/nickname/userTags columns below AND the favorites/collection scope arms: neither can
  // run against a connection that never ATTACHed the `user` schema alias.
  const hasUser = (db.pragma('database_list', { simple: false }) as { name: string }[]).some(
    (d) => d.name === 'user',
  );

  // A favorites/collection scope is meaningless without the user schema attached — short-circuit
  // to [] rather than let the SQL below reference `user.sample_state`/`user.collection_items` and
  // throw "no such table" on a connection that only ever ran `openCatalog`. Nothing sends these
  // scopes before a caller has actually opened the user db, so an unattached connection seeing
  // one is "asked for a view onto data that was never opened," not "asked for an existing empty
  // result" — but the practical contract callers get is the same either way: `[]`.
  if (
    f.scope !== undefined &&
    (f.scope.kind === 'favorites' || f.scope.kind === 'collection') &&
    !hasUser
  ) {
    return [];
  }

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

  // All three `Scope` kinds (ipcTypes.ts) produce a WHERE arm. `favorites`/`collection` only
  // reach this point when `hasUser` is true — the `!hasUser` case already returned `[]` above —
  // so their SQL can reference `user.sample_state`/`user.collection_items` unconditionally.
  if (f.scope !== undefined) {
    if (f.scope.kind === 'pack') {
      where.push('s.pack_id = ?');
      params.push(f.scope.packId);
    } else if (f.scope.kind === 'favorites') {
      where.push(
        's.file_hash IN (SELECT sample_file_hash FROM user.sample_state WHERE favorite = 1)',
      );
    } else if (f.scope.kind === 'collection') {
      where.push(
        's.file_hash IN (SELECT sample_file_hash FROM user.collection_items WHERE collection_id = ?)',
      );
      params.push(f.scope.collectionId);
    }
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

  // `COALESCE(us.favorite, 0)` rather than the bare joined column: the LEFT JOIN below leaves
  // `us.favorite` NULL (not 0) for a sample with no `user.sample_state` row at all, and this
  // column is declared `number` — same "never a type the column claims it isn't" reasoning
  // `hasPeaks`/`peaksFailed`'s CASE expressions already apply to their own LEFT JOIN. `nickname`
  // stays nullable either way, so it needs no such guard.
  const userColumns = hasUser
    ? 'COALESCE(us.favorite, 0) AS favorite, us.nickname AS nickname'
    : '0 AS favorite, NULL AS nickname';
  const userJoin = hasUser
    ? 'LEFT JOIN user.sample_state us ON us.sample_file_hash = s.file_hash'
    : '';

  const rows = db
    .prepare<Bound[], SampleQueryRow>(
      `SELECT s.id AS id, s.filename AS filename, s.rel_path AS relPath, s.pack_id AS packId,
              p.name AS packName, s.sample_type AS sampleType, s.bpm AS bpm,
              s.audio_key AS audioKey, s.chord_type AS chordType, s.duration_ms AS durationMs,
              s.missing AS missing, s.file_hash AS fileHash,
              CASE WHEN w.sample_id IS NOT NULL AND w.format != 0 THEN 1 ELSE 0 END AS hasPeaks,
              CASE WHEN w.sample_id IS NOT NULL AND w.format = 0 THEN 1 ELSE 0 END AS peaksFailed,
              ${userColumns}
       FROM samples s
       LEFT JOIN packs p ON p.id = s.pack_id
       LEFT JOIN waveforms w ON w.sample_id = s.id
       ${userJoin}
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

  // userTags: same "separate query, grouped in JS" shape as tags above, and for the same reason
  // (a sample_tags/tags join would fan a multi-tag sample out into duplicate rows) — keyed by
  // `fileHash` since `user.sample_tags` keys off `sample_file_hash`, not the catalog's integer
  // `samples.id`. Only run when `hasUser`: without the `user` schema attached this table doesn't
  // exist, and every row's `userTags` is `[]` regardless (the map stays empty, `?? []` below
  // supplies it). No `ORDER BY` here — sorted with `localeCompare` in JS after grouping, never
  // SQL's BINARY collation (Global Constraints).
  const userTagsByHash = new Map<string, string[]>();
  if (hasUser && rows.length > 0) {
    const hashes = rows.map((r) => r.fileHash);
    const userTagRows = db
      .prepare<string[], UserTagLinkRow>(
        `SELECT st.sample_file_hash AS hash, t.name AS name
         FROM user.sample_tags st
         JOIN user.tags t ON t.id = st.tag_id
         WHERE st.sample_file_hash IN (${hashes.map(() => '?').join(', ')})`,
      )
      .all(...hashes);
    for (const tr of userTagRows) {
      const tags = userTagsByHash.get(tr.hash);
      if (tags) tags.push(tr.name);
      else userTagsByHash.set(tr.hash, [tr.name]);
    }
    for (const tags of userTagsByHash.values()) tags.sort((a, b) => a.localeCompare(b));
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
    favorite: r.favorite === 1,
    nickname: r.nickname,
    userTags: userTagsByHash.get(r.fileHash) ?? [],
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
 * Raw peak bytes for the given sample ids, keyed by id — `format = 0` (failed decode) rows
 * excluded, same as "no row yet": both come back simply absent from the result, never a value.
 *
 * Review round 1, Finding 1 (previously this function returned a failed decode's zeroed
 * placeholder unfiltered, on the reasoning that filtering by success was `querySamples`'s
 * `hasPeaks`/`peaksFailed` flags' job, not this one's). That reasoning didn't hold up: those
 * flags are a query-time snapshot the renderer's `LibraryStore.peaksCache` doesn't refresh except
 * on an explicit re-query, so a sample whose decode fails strictly AFTER its row was last fetched
 * — the common case for a first-ever import, where every row's `peaksFailed` starts `false`
 * before the background decode queue has run at all — would sail past the renderer's own
 * `!row.peaksFailed` guard and get its placeholder cached and drawn as if it were a real, if
 * quiet, waveform. Filtering here instead of (only) in the renderer means correctness doesn't
 * depend on the caller's flags being fresh — the same reasoning `querySamples`'s own `hasPeaks`/
 * `peaksFailed` CASE expressions already apply by keying off `format`, not row presence.
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
      `SELECT sample_id, peaks FROM waveforms
       WHERE sample_id IN (${sampleIds.map(() => '?').join(', ')}) AND format != 0`,
    )
    .all(...sampleIds);

  const result: Record<number, ArrayBuffer> = {};
  for (const row of rows) {
    result[row.sample_id] = new Uint8Array(row.peaks).buffer;
  }
  return result;
}
