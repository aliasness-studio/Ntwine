import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openCatalog, type Catalog } from '../catalog/db';
import type { ImportProgress } from '../../shared/ipcTypes';
import { buildFixtureSpliceDb, type FixtureRow } from './fixtureSpliceDb';
import { readSplice, snapshotSpliceDb } from './spliceDb';
import { buildCatalog, statPass, runImport, type CoversFetch, type ImportDeps } from './importer';

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

// Task 8 Step 1 (brief prose only, same as Task 6's own prose-only steps): "create temp library
// root with one real file matching one row; assert that row missing=0, others missing=1; run
// twice = same result." The interface line's parenthetical — "(sets/clears samples.missing)" —
// is a second, distinct claim from "run twice = same result": a bug that only ever sets
// missing=1 and never clears it back to 0 would still pass a same-filesystem rerun (it would be
// stably wrong both times). The reappear test below exercises the "clears" half directly rather
// than leaving it to be implied by the other two.
describe('statPass', () => {
  const STAT_PACK_UUID = 'pack-stat-uuid';

  // Three samples sharing one pack, distinct multi-segment rel_paths (matches the "sounds/packs/
  // <name>/<file>" shape every other importer fixture uses) — only "present.wav"'s resolved path
  // gets a real file written to it in setUpStat below.
  function buildStatFixtureRows(libraryRoot: string): FixtureRow[] {
    const sample = (fileHash: string, filename: string) => ({
      table: 'samples' as const,
      file_hash: fileHash,
      local_path: join(libraryRoot, 'sounds/packs/Stat Pack', filename),
      filename,
      pack_uuid: STAT_PACK_UUID,
      sample_type: 'oneshot' as const,
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 500,
      tags: '',
    });
    return [
      { table: 'packs', uuid: STAT_PACK_UUID, name: 'Stat Pack' },
      sample('stat-present', 'present.wav'),
      sample('stat-missing-1', 'missing-1.wav'),
      sample('stat-missing-2', 'missing-2.wav'),
    ];
  }

  function presentSamplePath(libraryRoot: string): string {
    return join(libraryRoot, 'sounds/packs/Stat Pack/present.wav');
  }

  function missingSample1Path(libraryRoot: string): string {
    return join(libraryRoot, 'sounds/packs/Stat Pack/missing-1.wav');
  }

  function writeRealFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'real-audio-bytes');
  }

  function setUpStat() {
    const libraryRoot = tmp();
    const dbPath = join(tmp(), 'sounds.db');
    buildFixtureSpliceDb(dbPath, buildStatFixtureRows(libraryRoot));
    const data = readSplice(dbPath);
    const catalog = freshCatalog();
    buildCatalog(catalog, data, libraryRoot);

    // Only present.wav's rel_path resolves to a file that actually exists on disk; the other
    // two rows' resolved paths were never written to.
    writeRealFile(presentSamplePath(libraryRoot));

    return { libraryRoot, catalog };
  }

  function missingFlagByHash(catalog: Catalog, fileHash: string): number {
    const row = catalog.db
      .prepare('SELECT missing FROM samples WHERE file_hash = ?')
      .get(fileHash) as { missing: number } | undefined;
    if (!row) throw new Error(`no such sample: ${fileHash}`);
    return row.missing;
  }

  it('sets missing=0 for the row whose file exists on disk and missing=1 for every other row', () => {
    const { libraryRoot, catalog } = setUpStat();

    const result = statPass(catalog, libraryRoot);

    expect(result).toEqual({ present: 1, missing: 2 });
    expect(missingFlagByHash(catalog, 'stat-present')).toBe(0);
    expect(missingFlagByHash(catalog, 'stat-missing-1')).toBe(1);
    expect(missingFlagByHash(catalog, 'stat-missing-2')).toBe(1);
  });

  it('running twice with no filesystem change produces the same result', () => {
    const { libraryRoot, catalog } = setUpStat();

    const first = statPass(catalog, libraryRoot);
    const second = statPass(catalog, libraryRoot);

    expect(second).toEqual(first);
    expect(missingFlagByHash(catalog, 'stat-present')).toBe(0);
    expect(missingFlagByHash(catalog, 'stat-missing-1')).toBe(1);
    expect(missingFlagByHash(catalog, 'stat-missing-2')).toBe(1);
  });

  it('clears missing back to 0 when a previously-absent file reappears on disk', () => {
    const { libraryRoot, catalog } = setUpStat();
    statPass(catalog, libraryRoot);
    expect(missingFlagByHash(catalog, 'stat-missing-1')).toBe(1);

    // The file shows up later (e.g. a reconnected drive) — reuse the exact path statPass itself
    // would resolve the rel_path to, not a hand-rolled second path.
    writeRealFile(missingSample1Path(libraryRoot));

    const result = statPass(catalog, libraryRoot);

    expect(result).toEqual({ present: 2, missing: 1 });
    expect(missingFlagByHash(catalog, 'stat-missing-1')).toBe(0);
    // The still-absent row is untouched by the reappearance of an unrelated file.
    expect(missingFlagByHash(catalog, 'stat-missing-2')).toBe(1);
  });
});

// Task 9 Step 1 (brief prose only, same as Tasks 5/6/8's own prose-only steps): "full pipeline
// over fixture db + temp dirs emits phases in order snapshot -> catalog -> stat -> covers and
// returns ids missing peaks; with spliceDbPath: null but an existing prior snapshot, still
// succeeds (spec §5.2); with neither, rejects with a message naming the searched path."
describe('runImport', () => {
  const RUN_PACK_UUID = 'pack-run-import-1';
  const RUN_PACK_UUID_2 = 'pack-run-import-2';
  const COVER_URL = 'https://cdn.example.com/covers/run-import-1.jpg';
  const COVER_URL_2 = 'https://cdn.example.com/covers/run-import-2.jpg';

  // Two packs (both carrying a cover_url, so the covers phase has two real fetch candidates —
  // needed to observe a genuine mid-phase tick, not just a start/completion bookend that a
  // single-candidate run would make look identical) and two samples under the first pack: one
  // whose resolved path is a real file on disk, one that is not.
  function buildRunImportRows(libraryRoot: string): FixtureRow[] {
    const sample = (fileHash: string, filename: string) => ({
      table: 'samples' as const,
      file_hash: fileHash,
      local_path: join(libraryRoot, 'sounds/packs/Run Import Pack', filename),
      filename,
      pack_uuid: RUN_PACK_UUID,
      sample_type: 'oneshot' as const,
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 500,
      tags: '',
    });
    return [
      { table: 'packs', uuid: RUN_PACK_UUID, name: 'Run Import Pack', cover_url: COVER_URL },
      {
        table: 'packs',
        uuid: RUN_PACK_UUID_2,
        name: 'Run Import Pack Two',
        cover_url: COVER_URL_2,
      },
      sample('hash-present', 'present.wav'),
      sample('hash-absent', 'absent.wav'),
    ];
  }

  function presentSamplePath(libraryRoot: string): string {
    return join(libraryRoot, 'sounds/packs/Run Import Pack/present.wav');
  }

  function writeRealFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'real-audio-bytes');
  }

  function idOf(catalog: Catalog, fileHash: string): number {
    const row = catalog.db.prepare('SELECT id FROM samples WHERE file_hash = ?').get(fileHash) as
      { id: number } | undefined;
    if (!row) throw new Error(`fixture sample "${fileHash}" not found`);
    return row.id;
  }

  // Always ok, tiny body — these tests are about orchestration/progress, not cover-fetch
  // outcomes (those are covers.test.ts's job).
  function okFetch(): CoversFetch {
    return async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  }

  // Builds the "live Splice db" fixture and its libraryRoot; does NOT touch snapshotDir/coversDir
  // — each test wires those itself so the snapshot-fallback/rejection cases can control them.
  function setUpSource() {
    const libraryRoot = tmp();
    const sourceDbPath = join(tmp(), 'sounds.db');
    buildFixtureSpliceDb(sourceDbPath, buildRunImportRows(libraryRoot));
    writeRealFile(presentSamplePath(libraryRoot));
    return { libraryRoot, sourceDbPath };
  }

  it('runs snapshot -> catalog -> stat -> covers in order, ticks covers per pack, stamps meta, and returns ids still needing peaks', async () => {
    const { libraryRoot, sourceDbPath } = setUpSource();
    const catalog = freshCatalog();
    const snapshotDir = join(tmp(), 'snapshot');
    const coversDir = join(tmp(), 'covers');
    const events: ImportProgress[] = [];
    const FIXED_NOW = '2026-08-16T00:00:00.000Z';

    const deps: ImportDeps = {
      catalog,
      libraryRoot,
      spliceDbPath: sourceDbPath,
      snapshotDir,
      coversDir,
      fetchFn: okFetch(),
      now: () => FIXED_NOW,
    };

    const ids = await runImport(deps, (p) => events.push(p));

    // Phase order: first-seen order of distinct phases. Each phase's own events are contiguous
    // (a phase's start is immediately followed later by its own completion, never interleaved
    // with another phase's events), so de-duplicating consecutive-by-first-occurrence gives
    // exactly the phase sequence the brief asks for.
    const phaseOrder = [...new Set(events.map((e) => e.phase))];
    expect(phaseOrder).toEqual(['snapshot', 'catalog', 'stat', 'covers']);

    // Start/completion shape: the very first event is snapshot's start (0 of 1); the very last
    // is covers' completion (done === total).
    expect(events[0]).toMatchObject({ phase: 'snapshot', done: 0, total: 1 });
    const last = events[events.length - 1];
    expect(last.phase).toBe('covers');
    expect(last.done).toBe(last.total);

    // hash-present has a real file on disk and no waveforms row yet -> still needs peaks.
    // hash-absent has no real file (statPass marks it missing) -> excluded even though it also
    // has no waveforms row. pendingPeakIds' own exclusion matrix (missing / succeeded / failed)
    // is pinned directly in queries.test.ts; this only proves runImport is wired to read it
    // against the real post-pipeline catalog state.
    expect(ids).toEqual([idOf(catalog, 'hash-present')]);

    // Covers: two packs both carry a cover_url and coversDir starts empty, so both are real
    // fetch attempts -> start, two ticks, completion. The mid-phase tick assertion below is the
    // falsifier that actually distinguishes "ticks per pack" from "only start+completion" — with
    // total 2, an event at done:1 cannot be either bookend.
    const coversEvents = events.filter((e) => e.phase === 'covers');
    expect(coversEvents[0]).toMatchObject({ done: 0, total: 2 });
    expect(coversEvents.some((e) => e.done === 1 && e.total === 2)).toBe(true);
    expect(coversEvents[coversEvents.length - 1]).toMatchObject({ done: 2, total: 2 });

    // Meta stamps land only after the covers phase completes, using the injected clock rather
    // than the real one — so this pins the exact value, not just "is a string".
    expect(catalog.getMeta('imported')).toBe('1');
    expect(catalog.getMeta('library_root')).toBe(libraryRoot);
    expect(catalog.getMeta('imported_at')).toBe(FIXED_NOW);
  });

  it('falls back to an existing prior snapshot when spliceDbPath is null (spec §5.2)', async () => {
    const { libraryRoot, sourceDbPath } = setUpSource();
    const catalog = freshCatalog();
    const snapshotDir = join(tmp(), 'snapshot');
    const coversDir = join(tmp(), 'covers');
    // Plant the "prior snapshot" the way a REAL earlier run would have produced it: via
    // snapshotSpliceDb itself, not a hand-rolled file copy.
    snapshotSpliceDb(sourceDbPath, snapshotDir);
    const events: ImportProgress[] = [];

    const deps: ImportDeps = {
      catalog,
      libraryRoot,
      spliceDbPath: null,
      snapshotDir,
      coversDir,
      fetchFn: okFetch(),
    };

    const ids = await runImport(deps, (p) => events.push(p));

    expect([...new Set(events.map((e) => e.phase))]).toEqual([
      'snapshot',
      'catalog',
      'stat',
      'covers',
    ]);
    expect(catalog.db.prepare('SELECT COUNT(*) AS n FROM packs').get()).toEqual({ n: 2 });
    expect(ids).toEqual([idOf(catalog, 'hash-present')]);
  });

  it('rejects, naming the searched path, when spliceDbPath is null and no prior snapshot exists', async () => {
    const catalog = freshCatalog();
    const snapshotDir = join(tmp(), 'snapshot'); // never populated
    const coversDir = join(tmp(), 'covers');
    const events: ImportProgress[] = [];

    const deps: ImportDeps = {
      catalog,
      libraryRoot: tmp(),
      spliceDbPath: null,
      snapshotDir,
      coversDir,
      fetchFn: okFetch(),
    };

    await expect(runImport(deps, (p) => events.push(p))).rejects.toThrow(
      join(snapshotDir, 'sounds.db'),
    );

    // The reject path still reports through onProgress — a listener watching only the progress
    // stream (not a try/catch around the call) can still learn why the run stopped.
    const last = events[events.length - 1];
    expect(last.phase).toBe('error');
    expect(last.message ?? '').toContain(join(snapshotDir, 'sounds.db'));
  });
});
