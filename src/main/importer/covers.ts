import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Catalog } from '../catalog/db';

// The single definition of "is this pack a candidate for a cover fetch" (owner's "one question,
// two gates" rule): a pack needs BOTH `cover_url` (something to fetch) and `splice_uuid`
// (something stable to name the file after — see downloadCovers's own doc comment). Exported so
// importer.ts's `countCoverCandidates` (the covers-phase progress total) computes the exact same
// condition from this fragment instead of maintaining its own hand-written copy — a mismatch
// between the two would silently desync "how many covers total" from "how many covers
// downloadCovers actually considers."
export const COVER_CANDIDATE_WHERE = 'cover_url IS NOT NULL AND splice_uuid IS NOT NULL';

// Narrowed to non-null `splice_uuid`/`cover_url`: every row this query can return already
// satisfies COVER_CANDIDATE_WHERE, so the two columns it exists to guard are never null here —
// same "trust what the WHERE clause already enforces" reasoning queries.ts's SampleQueryRow
// uses for its DB-enforced CHECK-constraint columns.
interface CoverCandidateRow {
  id: number;
  splice_uuid: string;
  cover_url: string;
  cover_file: string | null;
}

/**
 * Covers pass (spec §5 step 5): download each pack's `cover_url` into `coversDir`, named
 * `<splice_uuid>.jpg`, and record that bare filename in `packs.cover_file`. `cover_file` stores
 * a filename, never a path — `coversDir` supplies the directory at resolve time, the same
 * "root + stored-relative-leaf" split `libraryRoot`/`samples.rel_path` uses (transform.ts's
 * `toRelPath`) — so the covers directory can move (e.g. userData relocating) without
 * invalidating every row. `packs.cover_file` is written ONLY here: `buildCatalog`'s pack upsert
 * deliberately never touches it (mirrors `missing` being left out of the samples upsert, per
 * importer.ts's own comment) — an existence/covers pass must never be undone by a re-import.
 *
 * Tolerant by design (spec §5 step 5 — "failures are logged and non-fatal; missing cover
 * renders a generic tile"): `fetchFn` resolving `{ ok: false }` *or* throwing/rejecting is
 * caught, logged, and counted in `failed` rather than aborting the pass — one broken pack must
 * never block every other pack's cover from downloading. A pack with no `cover_url` (Splice
 * simply didn't supply one) or no `splice_uuid` (nothing stable to name the file after) never
 * even reaches the loop below: `COVER_CANDIDATE_WHERE` excludes it at the query level, so there
 * is nothing to fetch and it is not a failure.
 *
 * Skip-existing: a pack whose `cover_file` is already set AND whose file still exists on disk is
 * skipped without calling `fetchFn` at all — re-running the import pipeline must not re-hit the
 * network for covers already on disk. A `cover_file` pointing at a file that's since vanished
 * (e.g. the user emptied the covers dir by hand) is NOT skipped — it's retried like any other
 * pending cover, same as every pack that has never succeeded.
 */
export async function downloadCovers(
  catalog: Catalog,
  coversDir: string,
  fetchFn: (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>,
): Promise<{ ok: number; failed: number }> {
  const { db } = catalog;
  mkdirSync(coversDir, { recursive: true });

  const packs = db
    .prepare<[], CoverCandidateRow>(
      `SELECT id, splice_uuid, cover_url, cover_file FROM packs WHERE ${COVER_CANDIDATE_WHERE}`,
    )
    .all();
  const setCoverFile = db.prepare<[string, number]>('UPDATE packs SET cover_file = ? WHERE id = ?');

  let ok = 0;
  let failed = 0;

  for (const pack of packs) {
    const filename = `${pack.splice_uuid}.jpg`;
    if (pack.cover_file !== null && existsSync(join(coversDir, pack.cover_file))) {
      continue; // skip-existing
    }

    try {
      const res = await fetchFn(pack.cover_url);
      if (!res.ok) {
        console.error(`downloadCovers: pack ${pack.id} — fetch responded not-ok, skipping`);
        failed++;
        continue;
      }
      const bytes = await res.arrayBuffer();
      writeFileSync(join(coversDir, filename), Buffer.from(bytes));
      setCoverFile.run(filename, pack.id);
      ok++;
    } catch (err) {
      // Non-fatal by contract (spec §5 step 5) — logged so a real run's console shows which
      // pack failed and why, without aborting the rest of the pass.
      console.error(`downloadCovers: pack ${pack.id} — fetch threw`, err);
      failed++;
    }
  }

  return { ok, failed };
}
