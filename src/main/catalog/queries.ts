import type { Catalog } from './db';
import type { PackRow, QueryFilters, SampleRow, TagFacet } from '../../shared/ipcTypes';
import { searchIdsForToken } from './search';
import { normalizeUserName } from '../../shared/userNames';

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

// Row shape for `readUserTextWithIds`'s join — one row per (sample, user-tag) pair, fanned out
// by `user.sample_tags` exactly like `UserTagLinkRow` above, but keyed by `samples.id` (not
// `fileHash`) since the search composition below works in the same id-space `searchIdsForToken`
// returns. `nickname`/`tagNormalizedName` are both nullable: LEFT JOINed so a sample with no
// nickname and/or no user tags still produces a row (nulls) rather than vanishing from the join.
interface UserTextRow {
  id: number;
  nickname: string | null;
  tagNormalizedName: string | null;
}

/**
 * Per-`samples.id` normalized text fragments contributed by the user layer — a sample's nickname
 * plus each of its user-tag names — for the search composition below (spec §3.4) to word-boundary
 * match search tokens against, the same way `searchIdsForToken` matches them against FTS text.
 * Only called when `hasUser` (querySamples's own gate): the `user` schema alias must be ATTACHed
 * for `user.sample_state`/`user.sample_tags`/`user.tags` to exist at all.
 *
 * One SQL join from `samples` through `file_hash` to `user.sample_state` (nickname) and
 * `user.sample_tags`/`user.tags` (tag names), LEFT JOINed throughout so a sample with neither
 * still round-trips as a joined row (nulls) instead of disappearing — grouped into one entry per
 * id in JS afterward, same "separate query, group in JS" shape `querySamples` already uses for
 * `tags`/`userTags` below. A multiply-tagged sample fans out to one row per tag (same reason
 * `userTagRows` does); the nickname is simply repeated across those rows, which is harmless here
 * since every fragment is only ever read with `.some()`, never counted.
 *
 * Nicknames are normalized here, at READ time (`normalizeUserName`, `../../shared/userNames`),
 * not at write time — `setNickname` (userDb.ts) stores the trimmed string exactly as typed, the
 * same "store raw, fold at query time" split `sample_search`'s FTS columns already use. Tag
 * fragments are already normalized on disk (`user.tags.normalized_name`, userDb.ts's own SCHEMA)
 * and are used as-is.
 */
function readUserTextWithIds(db: Catalog['db']): Map<number, { text: string[] }> {
  const rows = db
    .prepare<[], UserTextRow>(
      `SELECT s.id AS id, us.nickname AS nickname, t.normalized_name AS tagNormalizedName
       FROM samples s
       LEFT JOIN user.sample_state us ON us.sample_file_hash = s.file_hash
       LEFT JOIN user.sample_tags st ON st.sample_file_hash = s.file_hash
       LEFT JOIN user.tags t ON t.id = st.tag_id`,
    )
    .all();

  const result = new Map<number, { text: string[] }>();
  for (const row of rows) {
    if (row.nickname === null && row.tagNormalizedName === null) continue;
    let entry = result.get(row.id);
    if (!entry) {
      entry = { text: [] };
      result.set(row.id, entry);
    }
    if (row.nickname !== null) entry.text.push(normalizeUserName(row.nickname));
    if (row.tagNormalizedName !== null) entry.text.push(row.tagNormalizedName);
  }
  return result;
}

/**
 * Word-boundary prefix test (spec §3.4) between one normalized search token and one normalized
 * user-text fragment (a nickname or a user-tag name): true when the token starts the fragment, or
 * starts a word inside it. `' ' + tokenNorm` rather than a regex `\b` is enough because both sides
 * are already `normalizeUserName`d — internal whitespace is already collapsed to single spaces, so
 * the only word boundaries that can exist are "start of string" and "right after one of those
 * single spaces." This gives a nickname/tag hit the same "narrows as you type more words" prefix
 * feel `searchIdsForToken`'s FTS5 `"tok"*` already gives filename/pack/tag hits (spec §7) — so a
 * search box user can't tell which source answered their query from the matching behavior alone.
 */
function wordPrefixMatch(text: string, tokenNorm: string): boolean {
  return text.startsWith(tokenNorm) || text.includes(` ${tokenNorm}`);
}

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
  // searchIdsForToken, which throws on exactly that input (its contract: "callers guard"). Once a
  // real query string IS present, a zero-match result must short-circuit here — a literal
  // `id IN ()` is a SQLite syntax error, not an empty result set — so the rest of the WHERE clause
  // is never even built, let alone run, for a search with no hits.
  //
  // Per-token search union (spec §3.4): a sample matches when EVERY token prefix-matches, at a
  // word boundary, at least one of FTS text (searchIdsForToken), its nickname, or one of its
  // user-tag names — sources union PER token, tokens AND together. `userText` is read once per
  // call (not once per token): it's the same per-sample fragment set every token gets compared
  // against, and reading it inside the loop would just re-run the same join once per token for no
  // benefit.
  let matchedIds: number[] | null = null;
  if (f.search !== undefined && f.search.trim() !== '') {
    const tokens = f.search.split(/\s+/).filter((t) => t.length > 0);
    const userText = hasUser ? readUserTextWithIds(db) : new Map<number, { text: string[] }>();
    let acc: Set<number> | null = null;
    for (const token of tokens) {
      const ftsIds = new Set(searchIdsForToken(catalog, token));
      const norm = normalizeUserName(token);
      for (const [id, { text }] of userText) {
        if (text.some((t) => wordPrefixMatch(t, norm))) ftsIds.add(id);
      }
      // `(id: number)` is an explicit type, not a stylistic choice: without it, tsc's inference
      // for this self-referential `acc = acc === null ? … : new Set([...acc].filter(…))` shape
      // circularly resolves the callback parameter to `never` (reproduced in isolation outside
      // this file too) — a real tsc inference limit on this exact "reassign through a ternary
      // whose else-branch spreads-then-filters the narrowed variable" pattern, not a sign
      // anything here is actually `never`.
      acc = acc === null ? ftsIds : new Set([...acc].filter((id: number) => ftsIds.has(id)));
      if (acc.size === 0) return [];
    }
    matchedIds = [...(acc ?? new Set<number>())];
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
    // ALL listed tags, not any — same contract as before the user layer, now extended per name
    // to either source (spec §3.3): a sample qualifies for one wanted name if EITHER its Splice
    // tags OR (when `hasUser`) its user tags contain that name, and must qualify for EVERY
    // wanted name. One parenthesized `EXISTS ... OR EXISTS ...` is pushed per name — ANDed
    // together by the shared `where.join(' AND ')` below — replacing the old single
    // HAVING-count subquery, since a plain count can no longer tell "matched, from either
    // source" apart from "matched twice, once per source" without double-counting a name a
    // sample carries on both sides. De-duped so a caller accidentally repeating a tag name in
    // the filter can't push the same clause twice.
    const wanted = [...new Set(f.tags)];
    for (const name of wanted) {
      // User-side EXISTS compares `ut.normalized_name` against `normalizeUserName(name)` — the
      // same merge key `mergeTagFacets` unions on below — never the raw `name`, since a user
      // tag's only guaranteed-unique/comparable column is its normalized one (userDb.ts
      // SCHEMA); the Splice-side EXISTS compares `t.name` directly, unchanged, since Splice tag
      // names arrive already-lowercase from import and need no folding.
      const userClause = hasUser
        ? `OR EXISTS (SELECT 1 FROM user.sample_tags ust JOIN user.tags ut ON ut.id = ust.tag_id
                WHERE ust.sample_file_hash = s.file_hash AND ut.normalized_name = ?)`
        : '';
      where.push(`(
        EXISTS (SELECT 1 FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                WHERE st.sample_id = s.id AND t.name = ?)
        ${userClause}
      )`);
      params.push(name);
      if (hasUser) params.push(normalizeUserName(name));
    }
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
 * Unions two `(name, sampleId)` tag-link row sets — one from Splice's `tags`, one from the user
 * layer's `user.tags` — into the merged facet list `listTags` returns once the user schema is
 * attached (spec §3.3). Merge key is `normalizeUserName(name)`, never the raw name: a user tag's
 * only guaranteed-unique/comparable column is its `normalized_name` (userDb.ts SCHEMA), and
 * folding Splice's own already-lowercase names through the same normalizer costs nothing — it's
 * idempotent on them — while giving both sides one shared comparison rule instead of two.
 *
 * Splice rows are folded in FIRST, each planting its own name as that facet's `display` the
 * first time its key is seen; user rows only ever ADD a sample id to an existing entry, never
 * overwrite a `display` a Splice row already set. That one-way rule — never reassign `display`
 * once set — is what makes "the Splice display form wins when both sources carry the name, else
 * the user display form" fall out of iteration order, with no explicit source-priority check
 * needed per row.
 *
 * `count` is `ids.size`, not two separate counts summed: `ids` is a `Set<sampleId>`, so a sample
 * carrying the same normalized name from BOTH sources still contributes exactly one id, and
 * therefore counts once — the "distinct matching samples from either source" contract spec §3.3
 * and this task's brief both call for, not a sum that would double-count it.
 *
 * Sort is JS, not SQL, for the same reason the merge itself is JS: count DESC then name ASC via
 * `localeCompare` (the Global Constraints' one display-sort comparator) — the same deterministic
 * tie-break `listTags`'s pre-existing SQL `ORDER BY` already gave the splice-only path, just
 * computed after the union instead of inside a single-source `GROUP BY`.
 */
function mergeTagFacets(spliceRows: TagLinkRow[], userRows: TagLinkRow[]): TagFacet[] {
  const facets = new Map<string, { display: string; ids: Set<number> }>();
  for (const row of spliceRows) {
    const key = normalizeUserName(row.name);
    let entry = facets.get(key);
    if (!entry) {
      entry = { display: row.name, ids: new Set() };
      facets.set(key, entry);
    }
    entry.ids.add(row.sampleId);
  }
  for (const row of userRows) {
    const key = normalizeUserName(row.name);
    let entry = facets.get(key);
    if (!entry) {
      entry = { display: row.name, ids: new Set() };
      facets.set(key, entry);
    }
    entry.ids.add(row.sampleId);
  }
  return [...facets.values()]
    .map((e) => ({ name: e.display, count: e.ids.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Tag-chip facet (spec §7 baseline; either-source union spec §3.3): every tag name in use across
 * BOTH Splice's own tags and — once the user schema is attached — the user layer's tags, with a
 * count of the DISTINCT non-missing samples carrying it from EITHER source (same "present, not
 * merely imported" reasoning as `listPacks`'s `sampleCount`), highest-count first, ties broken
 * alphabetically.
 *
 * `!hasUser`: unchanged from before the user layer existed — same single-source SQL, same
 * `ORDER BY count DESC, t.name ASC`. Nothing to union when there is nothing to union with, so
 * this path stays byte-identical rather than routing a no-op merge through `mergeTagFacets`.
 *
 * `hasUser`: two flat, ungrouped `(name, sampleId)` queries — one per source, both already
 * filtered to present (`missing = 0`) samples and both resolving `sampleId` to the SAME identity
 * (the user-side query joins back through `samples.file_hash` to get there), so a sample tagged
 * from both sources collapses to one id in `mergeTagFacets`'s `Set` — merged and sorted in JS,
 * since only JS can key two separate SQL result sets by a normalized name neither source table
 * stores in a directly-joinable form together.
 */
export function listTags(catalog: Catalog): TagFacet[] {
  // Same computed-per-call reasoning as `querySamples`'s own `hasUser` gate above: never cached
  // on `Catalog`, since ATTACH could happen after a `Catalog` is already held elsewhere.
  const hasUser = (
    catalog.db.pragma('database_list', { simple: false }) as { name: string }[]
  ).some((d) => d.name === 'user');

  if (!hasUser) {
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

  const spliceRows = catalog.db
    .prepare<[], TagLinkRow>(
      `SELECT t.name AS name, s.id AS sampleId
       FROM sample_tags st
       JOIN tags t ON t.id = st.tag_id
       JOIN samples s ON s.id = st.sample_id AND s.missing = 0`,
    )
    .all();
  const userRows = catalog.db
    .prepare<[], TagLinkRow>(
      `SELECT ut.name AS name, s.id AS sampleId
       FROM user.sample_tags ust
       JOIN user.tags ut ON ut.id = ust.tag_id
       JOIN samples s ON s.file_hash = ust.sample_file_hash AND s.missing = 0`,
    )
    .all();

  return mergeTagFacets(spliceRows, userRows);
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
