import type { Catalog } from './db';

interface SearchHitRow {
  sample_id: number;
}

/**
 * Rebuilds `sample_search` (spec §6) from the current `samples`/`packs`/`tags` state: DELETE
 * every existing row, then re-INSERT one row per sample. Whole-table delete-then-reinsert
 * rather than incremental sync — v1 only ever rebuilds at import time (db.ts's DDL comment:
 * "No live sync triggers in v1"), so there is no drift to reconcile incrementally, and a full
 * rebuild can never leave a stale/orphaned FTS row behind. Wrapped in its own `db.transaction`,
 * which better-sqlite3 automatically runs as a SAVEPOINT when called from inside another
 * already-open transaction (`db.inTransaction`, see node_modules/better-sqlite3's
 * lib/methods/transaction.js) — so this is safe to call both standalone (as tests do) and
 * nested inside `buildCatalog`'s transaction (as importer.ts does), and calling it twice in a
 * row never duplicates rows: the DELETE clears the slate every time.
 *
 * `pack_name`/`tag_text` are `COALESCE`d to `''` rather than left NULL: `pack_name` is NULL for
 * a sample whose `pack_id` is NULL (unmatched `pack_uuid`, see importer.ts), and `GROUP_CONCAT`
 * over a tag-less sample's (nonexistent) tag rows returns NULL too. An explicit `''` keeps every
 * inserted value a real string, matching `filename` (`NOT NULL` in the schema).
 */
export function rebuildSearch(catalog: Catalog): void {
  const { db } = catalog;

  const rebuild = db.transaction(() => {
    db.prepare('DELETE FROM sample_search').run();
    db.prepare(
      `INSERT INTO sample_search (filename, pack_name, tag_text, sample_id)
       SELECT s.filename, COALESCE(p.name, ''), COALESCE(GROUP_CONCAT(t.name, ' '), ''), s.id
       FROM samples s
       LEFT JOIN packs p ON p.id = s.pack_id
       LEFT JOIN sample_tags st ON st.sample_id = s.id
       LEFT JOIN tags t ON t.id = st.tag_id
       GROUP BY s.id`,
    ).run();
  });

  rebuild();
}

/**
 * Resolves a free-text search-box query to the `samples.id` values it matches, via
 * `sample_search MATCH` against `filename`/`pack_name`/`tag_text` (the columns actually
 * indexed — `sample_id` is UNINDEXED and never part of MATCH, per db.ts's DDL comment). Each
 * whitespace-separated token becomes its own quoted, prefix-matched phrase (`"tok"*`), joined
 * with FTS5's implicit AND — so `'kic drum'` requires both a "kic*" hit and a "drum*" hit in the
 * SAME row, matching the "narrows as you type more words" feel spec §7 wants from the search
 * box. The `sample_search` table's default tokenizer (unicode61 — no `tokenize=` override in
 * the DDL) case-folds both indexed text and query tokens, which is what makes matches
 * case-insensitive with no extra work here.
 *
 * A double-quote inside a token is escaped by doubling it (`"` -> `""`), the same rule SQL
 * string literals use — that's what lets a query like `ki"ck` reach FTS5 as a syntactically
 * valid quoted phrase (`"ki""ck"*`) instead of throwing a query-syntax error.
 *
 * Throws on an empty (or whitespace-only) query: there is no sensible "match nothing" vs.
 * "match everything" FTS5 spelling for a blank MATCH string, so this makes the caller decide.
 * `querySamples` is the only caller today, and it treats a blank `f.search` as "no search
 * filter" rather than ever reaching this throw (see queries.ts).
 */
export function searchIds(catalog: Catalog, query: string): number[] {
  const tokens = query.split(/\s+/).filter((tok) => tok.length > 0);
  if (tokens.length === 0) {
    throw new Error('searchIds: empty query — callers must guard against a blank search string');
  }

  const matchQuery = tokens.map((tok) => `"${tok.replaceAll('"', '""')}"*`).join(' ');

  const rows = catalog.db
    .prepare<[string], SearchHitRow>(
      'SELECT sample_id FROM sample_search WHERE sample_search MATCH ?',
    )
    .all(matchQuery);

  return rows.map((r) => r.sample_id);
}
