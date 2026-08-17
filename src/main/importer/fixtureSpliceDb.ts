import Database from 'better-sqlite3';

// DDL copied verbatim from the REAL Splice sounds.db schema (spec §2.2, read firsthand off the
// production file) — every column, not just the ones readSplice selects. This is what makes
// readSplice's SELECTs against a fixture behave exactly as they will against the real file:
// extra columns this codebase never reads (samples: attr_hash, dir, sas_id, sample-level genre,
// popularity, purchased_at, last_modified_at, waveform_url; packs: id, description, permalink)
// still exist, still take part in `SELECT *`-shaped mistakes, and still get NULL/default values
// for fixture rows that don't set them.
const SCHEMA = `
CREATE TABLE samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_path TEXT, attr_hash TEXT, dir TEXT, audio_key TEXT,
  bpm INTEGER, chord_type INTEGER, duration INTEGER,
  file_hash TEXT NOT NULL UNIQUE, sas_id TEXT, filename TEXT,
  genre INTEGER, pack_uuid TEXT, sample_type TEXT, tags TEXT,
  popularity INTEGER, purchased_at timestamp, last_modified_at timestamp,
  waveform_url TEXT, provider_name TEXT,
  FOREIGN KEY (pack_uuid) REFERENCES packs(uuid)
);
CREATE TABLE packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE, name TEXT, description TEXT,
  cover_url TEXT, genre TEXT, permalink TEXT, provider_name TEXT
);
`;

export interface FixturePackRow {
  table: 'packs';
  uuid: string;
  name?: string | null;
  description?: string | null;
  cover_url?: string | null;
  genre?: string | null;
  permalink?: string | null;
  provider_name?: string | null;
}

export interface FixtureSampleRow {
  table: 'samples';
  file_hash: string;
  local_path?: string | null;
  attr_hash?: string | null;
  dir?: string | null;
  // `string | null`, not bare `string`: the real sounds.db stores genuine SQL NULL here for the
  // large majority of "unknown" rows (Task 13 hand-QA, 2026-08-17 — see transform.ts's
  // `toChordType` comment), not the empty string every OTHER fixture row in this codebase had
  // assumed until that bug surfaced. Omitting the field still defaults to `''` below (unchanged
  // behavior for every existing fixture row); passing `null` explicitly inserts a real NULL cell.
  audio_key?: string | null;
  bpm?: number;
  chord_type?: string | null;
  duration?: number | null;
  sas_id?: string | null;
  filename?: string | null;
  genre?: number | null;
  pack_uuid?: string | null;
  sample_type?: string;
  tags?: string;
  popularity?: number | null;
  purchased_at?: string | null;
  last_modified_at?: string | null;
  waveform_url?: string | null;
  provider_name?: string | null;
}

// A flat, heterogeneous list rather than `{ packs, samples }`: callers (this task's own test,
// and every importer test after it) build one ordered sequence of "insert this row" instructions,
// which is what lets a single sample and its pack read side by side wherever they're declared.
export type FixtureRow = FixturePackRow | FixtureSampleRow;

type FixturePackParams = Required<Omit<FixturePackRow, 'table'>>;
type FixtureSampleParams = Required<Omit<FixtureSampleRow, 'table'>>;

/**
 * Builds a fixture sounds.db at `dbPath` from `rows`, on the REAL Splice schema (spec §2.2) —
 * mirrors production closely enough that `readSplice`'s SELECTs exercise exactly the shape
 * they will against a real file. Columns a row's caller doesn't set fall back to the "none"
 * sentinel spec §2.2 documents for that column where one exists (bpm 0, audio_key/chord_type/
 * tags '') or plain NULL otherwise — never `undefined` (better-sqlite3 rejects that as a bind
 * value). `duration` follows the same explicit-null rule as `audio_key`/`chord_type`: an omitted
 * field falls back to the `0` sentinel, an explicit `null` inserts a real SQL NULL.
 *
 * `PRAGMA foreign_keys = OFF`: confirmed empirically (better-sqlite3 13.0.3 / SQLite 3.53.4,
 * this repo's installed versions) that a fresh connection defaults `foreign_keys` ON, unlike
 * the historical SQLite default of OFF. Left ON, the `FOREIGN KEY (pack_uuid)` clause above
 * would reject a sample row whose `pack_uuid` matches no `packs` row — exactly the "pack_uuid
 * unknown" shape a later importer task's fixtures need to construct on purpose. Explicit so
 * this doesn't quietly depend on whichever default a given platform's SQLite build ships with.
 */
export function buildFixtureSpliceDb(dbPath: string, rows: FixtureRow[]): void {
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(SCHEMA);

    const insertPack = db.prepare<FixturePackParams>(
      `INSERT INTO packs (uuid, name, description, cover_url, genre, permalink, provider_name)
       VALUES (@uuid, @name, @description, @cover_url, @genre, @permalink, @provider_name)`,
    );
    const insertSample = db.prepare<FixtureSampleParams>(
      `INSERT INTO samples (
         local_path, attr_hash, dir, audio_key, bpm, chord_type, duration, file_hash, sas_id,
         filename, genre, pack_uuid, sample_type, tags, popularity, purchased_at,
         last_modified_at, waveform_url, provider_name
       ) VALUES (
         @local_path, @attr_hash, @dir, @audio_key, @bpm, @chord_type, @duration, @file_hash,
         @sas_id, @filename, @genre, @pack_uuid, @sample_type, @tags, @popularity, @purchased_at,
         @last_modified_at, @waveform_url, @provider_name
       )`,
    );

    const insert = db.transaction((toInsert: FixtureRow[]) => {
      for (const row of toInsert) {
        if (row.table === 'packs') {
          insertPack.run({
            uuid: row.uuid,
            name: row.name ?? null,
            description: row.description ?? null,
            cover_url: row.cover_url ?? null,
            genre: row.genre ?? null,
            permalink: row.permalink ?? null,
            provider_name: row.provider_name ?? null,
          });
        } else {
          insertSample.run({
            local_path: row.local_path ?? null,
            attr_hash: row.attr_hash ?? null,
            dir: row.dir ?? null,
            // `=== undefined`, not `??`: `??` would fold an EXPLICIT `null` into the same '='
            // default as an omitted field, making it impossible for a fixture row to ask for a
            // real NULL cell at all (`null ?? ''` is `''`, same as `undefined ?? ''`). Only an
            // omitted key means "use the '' sentinel default" — every other fixture row in this
            // codebase omits these fields and is unaffected; a row that explicitly writes
            // `audio_key: null` / `chord_type: null` gets the real-world NULL shape instead.
            audio_key: row.audio_key === undefined ? '' : row.audio_key,
            bpm: row.bpm ?? 0,
            chord_type: row.chord_type === undefined ? '' : row.chord_type,
            duration: row.duration === undefined ? 0 : row.duration,
            file_hash: row.file_hash,
            sas_id: row.sas_id ?? null,
            filename: row.filename ?? null,
            genre: row.genre ?? null,
            pack_uuid: row.pack_uuid ?? null,
            sample_type: row.sample_type ?? 'oneshot',
            tags: row.tags ?? '',
            popularity: row.popularity ?? null,
            purchased_at: row.purchased_at ?? null,
            last_modified_at: row.last_modified_at ?? null,
            waveform_url: row.waveform_url ?? null,
            provider_name: row.provider_name ?? null,
          });
        }
      }
    });
    insert(rows);
  } finally {
    db.close();
  }
}
