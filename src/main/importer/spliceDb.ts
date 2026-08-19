import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// Shape read off the real `samples` table (spec §2.2) — only the columns the importer needs,
// not every column the table has (fixtureSpliceDb.ts's SCHEMA carries the rest for fidelity).
// `audio_key`/`chord_type` are `string | null`, not bare `string` — confirmed against the REAL
// sounds.db (Task 13 hand-QA, 2026-08-17): `SELECT typeof(chord_type), COUNT(*) FROM samples
// GROUP BY 1` shows genuine SQL NULL (not '') for 3,737 of 4,197 rows on chord_type, and 2,977
// on audio_key. Spec §2.2's "'' x3737" characterization described the same rows loosely; the
// wire value that actually comes back from better-sqlite3 for a NULL cell is JS `null`, not `''`
// — a `string`-typed field would silently lie about a shape the real driver really returns.
export interface SpliceSample {
  local_path: string;
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

// Shape read off the real `packs` table (spec §2.2) — same "named columns only" reasoning.
export interface SplicePack {
  uuid: string;
  name: string;
  genre: string | null;
  provider_name: string | null;
  cover_url: string | null;
}

/**
 * Copies `src` (a Splice sounds.db, or a previously-taken snapshot of one) into `destDir`,
 * preserving its filename, and returns the destination path. Unconditional overwrite — no
 * mtime/freshness check, ever: `copyFileSync` always replaces whatever is at the destination,
 * so repeated calls (even with something else having since overwritten the destination) leave
 * it byte-identical to the current `src` every time. That's what makes this idempotent: not
 * "skips redundant work," but "last write always wins, so calling it again changes nothing."
 */
export function snapshotSpliceDb(src: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(src));
  copyFileSync(src, dest);
  return dest;
}

/**
 * Opens a Splice sounds.db snapshot read-only and reads back `samples` + `packs`. Selects
 * named columns rather than `SELECT *` — that column list is the boundary that keeps every
 * Splice-internal column this codebase doesn't use out of everything downstream. `ORDER BY id`
 * on both queries makes the result deterministic for callers/tests rather than relying on
 * SQLite's incidental physical row order.
 */
/** Sanity-check a hand-picked file before persisting it as the Splice DB (the picker fallback
 * for when detection's glob misses — Windows-port audit blocker). Light on purpose: opens
 * read-only and checks the two tables `readSplice` will query. Returns null when usable, or a
 * user-facing reason when not — a random file must produce a clear error at pick time, not a
 * broken import later. */
export function validateSpliceDb(path: string): string | null {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return 'That file could not be opened as a SQLite database.';
  }
  try {
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('samples', 'packs')`,
      )
      .all();
    if (tables.length < 2) {
      return 'That is a SQLite database, but not a Splice sounds.db (no samples/packs tables).';
    }
    return null;
  } catch {
    // e.g. SQLITE_NOTADB surfacing at first query rather than at open.
    return 'That file could not be read as a SQLite database.';
  } finally {
    db.close();
  }
}

export function readSplice(snapshotPath: string): { samples: SpliceSample[]; packs: SplicePack[] } {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const samples = db
      .prepare<[], SpliceSample>(
        `SELECT local_path, file_hash, filename, pack_uuid, sample_type, bpm, audio_key, chord_type, duration, tags
         FROM samples ORDER BY id`,
      )
      .all();
    const packs = db
      .prepare<[], SplicePack>(
        `SELECT uuid, name, genre, provider_name, cover_url FROM packs ORDER BY id`,
      )
      .all();
    return { samples, packs };
  } finally {
    db.close();
  }
}
