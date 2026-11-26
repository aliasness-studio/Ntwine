import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

// Shape read off the real `samples` table — only the columns the importer needs,
// not every column the table has (fixtureSpliceDb.ts's SCHEMA carries the rest for fidelity).
// `audio_key`/`chord_type` are `string | null`, not bare `string` — confirmed against a REAL
// sounds.db: `SELECT typeof(chord_type), COUNT(*) FROM samples
// GROUP BY 1` shows genuine SQL NULL (not '') for 3,737 of 4,197 rows on chord_type, and 2,977
// on audio_key. The wire value that actually comes back from better-sqlite3 for a NULL cell is JS `null`, not `''`
// — a `string`-typed field would silently lie about a shape the real driver really returns.
export interface SpliceSample {
  // NULL until Splice finishes downloading the file (proven against a live mid-sync Windows DB:
  // 46 of 4,197 rows) — a bare `string` here would lie about a shape the driver
  // really returns, exactly like audio_key/chord_type below. buildCatalog skips NULL rows; a
  // later re-import (idempotent) picks them up once downloaded.
  local_path: string | null;
  file_hash: string;
  filename: string;
  pack_uuid: string | null;
  sample_type: string;
  bpm: number;
  audio_key: string | null;
  chord_type: string | null;
  duration: number;
  tags: string;
}

/** A sample whose file Splice has actually downloaded — the only kind the catalog imports.
 * The narrowing happens ONCE, in buildCatalog's filter; everything downstream of it
 * (normalizeSample, toRelPath) works on a real string path by type, not by hope. */
export type DownloadedSpliceSample = SpliceSample & { local_path: string };

// Shape read off the real `packs` table — same "named columns only" reasoning.
export interface SplicePack {
  uuid: string;
  name: string;
  genre: string | null;
  provider_name: string | null;
  cover_url: string | null;
}

/**
 * Snapshots `src` (a Splice sounds.db, or a previously-taken snapshot of one) into `destDir`,
 * preserving its filename, and returns the destination path. NOT a file copy: Splice runs
 * SQLite in WAL mode, and while the Splice app is open a large slice of recent writes lives
 * only in the `-wal` sidecar (measured on a live install: a 4.7 MB WAL next to a 6.4 MB main
 * file — a `copyFileSync` snapshot was missing 46 rows' local_path updates and broke the
 * import). `VACUUM INTO` runs through SQLite itself on a read-only connection, so the output
 * is a single consistent database with the WAL fully applied, safe to take while Splice is
 * running, and still write-free on Splice's own files. Idempotent the same way the old copy
 * was: the previous destination is removed and fully rewritten every call — last write wins.
 */
export function snapshotSpliceDb(src: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(src));
  rmSync(dest, { force: true }); // VACUUM INTO refuses an existing file — remove, don't reuse
  const db = new Database(src, { readonly: true });
  try {
    // SQL string literal: single quotes double; both slash styles are fine in a filename.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return dest;
}

// The exact projections readSplice runs — shared with validateSpliceDb below so "valid" can
// never drift from "what readSplice actually needs": one column added here is one column
// validated there, automatically.
const SAMPLES_PROJECTION = `SELECT local_path, file_hash, filename, pack_uuid, sample_type, bpm, audio_key, chord_type, duration, tags
   FROM samples ORDER BY id`;
const PACKS_PROJECTION = `SELECT uuid, name, genre, provider_name, cover_url FROM packs ORDER BY id`;

/** Sanity-check a hand-picked file before persisting it as the Splice DB (the picker fallback
 * for when detection's glob misses). Compiles `readSplice`'s own
 * projections with `LIMIT 0`: checking table NAMES alone would accept
 * a right-named/wrong-shaped database, persist it, and only fail at import — the exact
 * late-failure this validation exists to prevent. A missing table OR column throws at prepare,
 * so success here means `readSplice` can actually run. Returns null when usable, or a
 * user-facing reason when not. */
export function validateSpliceDb(path: string): string | null {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return 'That file could not be opened as a SQLite database.';
  }
  try {
    // LIMIT 0: compile + execute the projections without reading rows — prepare alone catches
    // missing tables/columns, the empty run keeps this a full "readSplice would work" proof.
    db.prepare(`${SAMPLES_PROJECTION} LIMIT 0`).all();
    db.prepare(`${PACKS_PROJECTION} LIMIT 0`).all();
    return null;
  } catch (err) {
    // better-sqlite3 opens lazily enough that a non-SQLite file often survives `new Database`
    // and only explodes at the first statement — SQLITE_NOTADB there means "not SQLite at
    // all", anything else means real SQLite with the wrong schema. Two different user mistakes,
    // two different messages.
    return (err as { code?: string }).code === 'SQLITE_NOTADB'
      ? 'That file could not be read as a SQLite database.'
      : 'That is a SQLite database, but not a usable Splice sounds.db (its samples/packs tables are missing or have the wrong shape).';
  } finally {
    db.close();
  }
}

/**
 * Opens a Splice sounds.db snapshot read-only and reads back `samples` + `packs`. Selects
 * named columns rather than `SELECT *` — that column list is the boundary that keeps every
 * Splice-internal column this codebase doesn't use out of everything downstream. `ORDER BY id`
 * on both queries makes the result deterministic for callers/tests rather than relying on
 * SQLite's incidental physical row order.
 */
export function readSplice(snapshotPath: string): { samples: SpliceSample[]; packs: SplicePack[] } {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const samples = db.prepare<[], SpliceSample>(SAMPLES_PROJECTION).all();
    const packs = db.prepare<[], SplicePack>(PACKS_PROJECTION).all();
    return { samples, packs };
  } finally {
    db.close();
  }
}
