import Database from 'better-sqlite3';

export interface Catalog {
  db: Database.Database;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// DDL written out in full from spec §6 ("Catalog schema (Ntwine's own DB)")'s SQL
// shorthand — every column, type, constraint and comment preserved. `IF NOT EXISTS`
// on every statement is what makes a catalog file reopenable (spec-6 test name).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
); -- schema_version, library_root, imported_at

CREATE TABLE IF NOT EXISTS packs (
  id INTEGER PRIMARY KEY,
  splice_uuid TEXT UNIQUE,
  name TEXT,
  genre TEXT,
  provider_name TEXT,
  cover_url TEXT,
  cover_file TEXT
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  file_hash TEXT UNIQUE NOT NULL,
  rel_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  pack_id INTEGER REFERENCES packs(id),
  -- Persisted-enum law: TEXT, never a bare renumberable integer.
  sample_type TEXT NOT NULL CHECK (sample_type IN ('oneshot','loop')),
  bpm INTEGER,            -- NULL = unknown (Splice's 0 maps to NULL)
  audio_key TEXT,         -- lowercase pitch class, NULL = unknown
  chord_type TEXT CHECK (chord_type IN ('major','minor')),  -- NULL = unknown
  duration_ms INTEGER,    -- direct copy; source is ms (spec §2.3)
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_tags (
  sample_id INTEGER REFERENCES samples(id),
  tag_id INTEGER REFERENCES tags(id),
  PRIMARY KEY (sample_id, tag_id)
);

CREATE TABLE IF NOT EXISTS waveforms (
  sample_id INTEGER PRIMARY KEY REFERENCES samples(id),
  peaks BLOB NOT NULL,               -- spec §5.1: 200 min/max pairs, Int8
  bucket_count INTEGER NOT NULL,
  format INTEGER NOT NULL DEFAULT 1  -- bump to invalidate/recompute
);

-- Search: FTS5 table holding denormalized text, rebuilt TRANSACTIONALLY during
-- import. No live sync triggers in v1 — the catalog only changes at import time,
-- and import-time rebuild is where trigger-desync bugs can't exist.
--
-- Declared column order (THIS DDL is authoritative — not spec §6's prose, which
-- lists sample_id first): 0 filename, 1 pack_name, 2 tag_text, 3 sample_id
-- (UNINDEXED). FTS5's highlight()/snippet() auxiliary functions address columns
-- by absolute 0-based index across ALL declared columns, UNINDEXED included —
-- e.g. highlight(sample_search, 0, ...) targets filename, not pack_name, and
-- index 3 is sample_id even though it's excluded from MATCH. Any future
-- search-highlighting code must read the column index from here, not re-derive
-- it from the spec doc's listing order.
CREATE VIRTUAL TABLE IF NOT EXISTS sample_search USING fts5(
  filename,
  pack_name,
  tag_text,
  sample_id UNINDEXED
);
`;

export function openCatalog(dbPath: string): Catalog {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const getMeta = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? row.value : null;
  };

  const setMeta = (key: string, value: string): void => {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  };

  // schema_version goes into meta on create only — a reopen of an existing catalog
  // must never stomp a schema_version a future migration task has already bumped.
  if (getMeta('schema_version') === null) setMeta('schema_version', '1');

  return { db, getMeta, setMeta };
}
