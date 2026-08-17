import type { Catalog } from '../catalog/db';
import type { SplicePack, SpliceSample } from './spliceDb';
import { normalizeSample } from './transform';

interface IdRow {
  id: number;
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

    for (const sample of input.samples) {
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

    // Task 7: rebuildSearch(catalog) called here
  });

  run(data);
}
