import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../catalog/db';
import { buildFixtureSpliceDb, type FixtureRow } from './fixtureSpliceDb';
import { readSplice } from './spliceDb';
import { buildCatalog } from './importer';

// Step 6 (brief prose only, no verbatim code given — authored per Task 5's own precedent for
// prose-only steps): "using fixture db from Task 5: buildCatalog twice is idempotent (same row
// counts, no duplicate tags/sample_tags); pack rows land; a sample whose pack_uuid is unknown
// still imports with pack_id NULL; unicode filename survives byte-exact."

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-importer-'));
const freshCatalog = () => openCatalog(join(tmp(), 'catalog.db'));

const PACK_UUID = 'pack-aaaa-1111';
// Unicode/NFD edge case (spec §10), same shape as Task 5's own fixture.
const NFD_FILENAME = 'café_kick.wav'.normalize('NFD');

// One pack + four samples: two ordinary samples sharing tags (proves tag rows are shared, not
// duplicated, even within a single run), one with an unmatched pack_uuid (orphan), one with an
// NFD filename. All local_paths sit under `libraryRoot` so normalizeSample's containment check
// never trips here — that throw path is already pinned in transform.test.ts.
function buildFixtureRows(libraryRoot: string): FixtureRow[] {
  return [
    {
      table: 'packs',
      uuid: PACK_UUID,
      name: 'Fixture Pack',
      genre: 'hip hop',
      provider_name: 'Fixture Provider',
      cover_url: 'https://cdn.example.com/covers/fixture-pack.jpg',
    },
    {
      table: 'samples',
      file_hash: 'hash-kick',
      local_path: join(libraryRoot, 'sounds/packs/Fixture Pack/kick.wav'),
      filename: 'kick.wav',
      pack_uuid: PACK_UUID,
      sample_type: 'oneshot',
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 1395,
      tags: 'kick,drums',
    },
    {
      table: 'samples',
      file_hash: 'hash-loop',
      local_path: join(libraryRoot, 'sounds/packs/Fixture Pack/loop.wav'),
      filename: 'loop.wav',
      pack_uuid: PACK_UUID,
      sample_type: 'loop',
      bpm: 140,
      audio_key: 'c#',
      chord_type: 'minor',
      duration: 9600,
      tags: 'drums,loop',
    },
    {
      table: 'samples',
      file_hash: 'hash-orphan',
      local_path: join(libraryRoot, 'sounds/orphan.wav'),
      filename: 'orphan.wav',
      pack_uuid: 'no-such-pack-uuid',
      sample_type: 'oneshot',
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 500,
      tags: '',
    },
    {
      table: 'samples',
      file_hash: 'hash-cafe',
      local_path: join(libraryRoot, `sounds/packs/Fixture Pack/${NFD_FILENAME}`),
      filename: NFD_FILENAME,
      pack_uuid: PACK_UUID,
      sample_type: 'oneshot',
      bpm: 128,
      audio_key: 'f#',
      chord_type: '',
      duration: 12830,
      tags: 'café,kick',
    },
  ];
}

// Builds a Splice fixture db + reads it back once per test, so each test gets its own
// libraryRoot/catalog/data triple (mirrors the mkdtempSync-per-test convention every other
// importer test file in this repo already uses).
function setUp() {
  const libraryRoot = tmp();
  const dbPath = join(tmp(), 'sounds.db');
  buildFixtureSpliceDb(dbPath, buildFixtureRows(libraryRoot));
  const data = readSplice(dbPath);
  const catalog = freshCatalog();
  return { libraryRoot, data, catalog };
}

describe('buildCatalog', () => {
  it('lands pack rows', () => {
    const { libraryRoot, data, catalog } = setUp();

    buildCatalog(catalog, data, libraryRoot);

    const packs = catalog.db
      .prepare('SELECT splice_uuid, name, genre, provider_name, cover_url FROM packs')
      .all();
    expect(packs).toEqual([
      {
        splice_uuid: PACK_UUID,
        name: 'Fixture Pack',
        genre: 'hip hop',
        provider_name: 'Fixture Provider',
        cover_url: 'https://cdn.example.com/covers/fixture-pack.jpg',
      },
    ]);
  });

  it('imports a sample whose pack_uuid matches no pack with pack_id NULL', () => {
    const { libraryRoot, data, catalog } = setUp();

    buildCatalog(catalog, data, libraryRoot);

    const row = catalog.db
      .prepare('SELECT pack_id FROM samples WHERE file_hash = ?')
      .get('hash-orphan') as { pack_id: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.pack_id).toBeNull();
  });

  it('imports an NFD unicode filename byte-exact', () => {
    const { libraryRoot, data, catalog } = setUp();

    buildCatalog(catalog, data, libraryRoot);

    const row = catalog.db
      .prepare('SELECT filename FROM samples WHERE file_hash = ?')
      .get('hash-cafe') as { filename: string } | undefined;
    // Falsifier: prove the NFD code points survived, not just that *a* string with visually
    // identical characters did (same discipline as Task 5's readSplice NFD assertion).
    expect(row?.filename).toBe(NFD_FILENAME);
    expect(row?.filename).not.toBe('café_kick.wav'.normalize('NFC'));
  });

  it('is idempotent: same row counts and stable sample ids across two runs, no duplicate tags/sample_tags', () => {
    const { libraryRoot, data, catalog } = setUp();

    const counts = () => {
      const one = (sql: string) => (catalog.db.prepare(sql).get() as { n: number }).n;
      return {
        packs: one('SELECT COUNT(*) AS n FROM packs'),
        samples: one('SELECT COUNT(*) AS n FROM samples'),
        tags: one('SELECT COUNT(*) AS n FROM tags'),
        sampleTags: one('SELECT COUNT(*) AS n FROM sample_tags'),
      };
    };
    const kickSampleId = () =>
      (
        catalog.db.prepare('SELECT id FROM samples WHERE file_hash = ?').get('hash-kick') as {
          id: number;
        }
      ).id;

    buildCatalog(catalog, data, libraryRoot);
    const firstCounts = counts();
    const firstKickId = kickSampleId();

    // 1 pack. 4 samples (kick, loop, orphan, cafe). 4 distinct tag names (kick, drums, loop,
    // café) even though 3 samples carry tags — "kick" and "drums" are each reused across two
    // samples, so this alone proves tag rows are shared, not duplicated, before the rerun
    // below even happens. 6 sample_tags links: kick(2) + loop(2) + orphan(0) + cafe(2).
    expect(firstCounts).toEqual({ packs: 1, samples: 4, tags: 4, sampleTags: 6 });

    buildCatalog(catalog, data, libraryRoot);
    const secondCounts = counts();

    expect(secondCounts).toEqual(firstCounts);
    // Stable id proves the upsert is a real UPDATE-in-place on conflict, not a delete+reinsert
    // — later tasks key `waveforms`/`sample_tags` off this id and must survive a re-import.
    expect(kickSampleId()).toBe(firstKickId);
  });

  // Fix round 1 (review): the identical-data rerun above can't distinguish a real
  // delete-then-reinsert junction rebuild from a no-op `INSERT OR IGNORE`-only implementation
  // — re-inserting the same (sample_id, tag_id) pairs is a no-op either way. This test changes
  // the data between runs so only a real rebuild passes.
  it('rebuilds sample_tags on a shrinking tag list — a dropped tag link is actually gone', () => {
    const { libraryRoot, data, catalog } = setUp();

    const linkExists = (fileHash: string, tagName: string): boolean =>
      (
        catalog.db
          .prepare(
            `SELECT COUNT(*) AS n FROM sample_tags
             JOIN samples ON samples.id = sample_tags.sample_id
             JOIN tags ON tags.id = sample_tags.tag_id
             WHERE samples.file_hash = ? AND tags.name = ?`,
          )
          .get(fileHash, tagName) as { n: number }
      ).n === 1;

    buildCatalog(catalog, data, libraryRoot);
    // hash-kick starts with tags 'kick,drums' (see buildFixtureRows above).
    expect(linkExists('hash-kick', 'drums')).toBe(true);

    // Rebuild the input with hash-kick's tag string shrunk: 'kick,drums' -> 'kick'.
    const shrunk = {
      ...data,
      samples: data.samples.map((s) => (s.file_hash === 'hash-kick' ? { ...s, tags: 'kick' } : s)),
    };
    buildCatalog(catalog, shrunk, libraryRoot);

    // The dropped 'drums' link is gone for hash-kick specifically...
    expect(linkExists('hash-kick', 'drums')).toBe(false);
    // ...hash-kick keeps the tag it still carries...
    expect(linkExists('hash-kick', 'kick')).toBe(true);
    // ...and hash-loop (untouched, also tagged 'drums') keeps its own link — this is a
    // per-sample junction rebuild, not a global purge of the 'drums' tag.
    expect(linkExists('hash-loop', 'drums')).toBe(true);
    // Per the review: "the tag row itself may remain in tags — assert only the junction." It
    // does (hash-loop still references it); asserted for completeness, not the point of the test.
    const tagRow = catalog.db.prepare('SELECT id FROM tags WHERE name = ?').get('drums');
    expect(tagRow).toBeDefined();
  });
});
