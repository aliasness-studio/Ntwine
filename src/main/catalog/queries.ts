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
}

interface TagLinkRow {
  sampleId: number;
  name: string;
}

type Bound = string | number;

/**
 * Runs the samples list query used by browse + search (spec §7): composes `f`'s filters with
 * AND, and returns rows shaped for the UI (`missing`/`hasPeaks` coerced to real booleans, `tags`
 * gathered into an array) rather than raw driver output.
 *
 * Two queries, not one: the row query (LEFT JOIN packs for `packName`, LEFT JOIN waveforms only
 * to test `sample_id IS NULL` for `hasPeaks`) can't also carry tags without a sample_tags/tags
 * join fanning every multi-tag sample out into duplicate rows. So tags are fetched separately —
 * `sample_id, name` for exactly the ids the first query already returned — and grouped onto each
 * row in JS.
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
              CASE WHEN w.sample_id IS NULL THEN 0 ELSE 1 END AS hasPeaks
       FROM samples s
       LEFT JOIN packs p ON p.id = s.pack_id
       LEFT JOIN waveforms w ON w.sample_id = s.id
       ${whereSql}
       ORDER BY p.name, s.filename`,
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
       ORDER BY p.name`,
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
