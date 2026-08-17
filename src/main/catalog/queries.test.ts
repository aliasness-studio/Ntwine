import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, type Catalog } from './db';
import { buildFixtureSpliceDb, type FixtureRow } from '../importer/fixtureSpliceDb';
import { readSplice } from '../importer/spliceDb';
import { buildCatalog } from '../importer/importer';
import {
  getPeaks,
  listPacks,
  listTags,
  pendingPeakIds,
  querySamples,
  writePeaks,
  writePeaksFailed,
} from './queries';

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-queries-'));
const freshCatalog = () => openCatalog(join(tmp(), 'catalog.db'));

// Two packs, five samples. "Fixture Pack" carries the filter-composition cases; "Ghost Pack"
// exists solely to hold the one sample that (once marked missing by a test) empties it entirely.
//
//   kick.wav  oneshot  bpm null   key null  tags: kick, drums
//   loop.wav  loop     bpm 140    key c#    tags: drums, loop     (chord: minor)
//   bass.wav  oneshot  bpm 90     key a     tags: bass, drums
//   tom.wav   oneshot  bpm 100    key g     tags: drums
//   boo.wav   oneshot  bpm null   key null  tags: (none)          — Ghost Pack's only sample
function buildFixtureRows(libraryRoot: string): FixtureRow[] {
  return [
    { table: 'packs', uuid: 'pack-fixture', name: 'Fixture Pack' },
    { table: 'packs', uuid: 'pack-ghost', name: 'Ghost Pack' },
    {
      table: 'samples',
      file_hash: 'h-kick',
      local_path: join(libraryRoot, 'sounds/packs/Fixture Pack/kick.wav'),
      filename: 'kick.wav',
      pack_uuid: 'pack-fixture',
      sample_type: 'oneshot',
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 1000,
      tags: 'kick,drums',
    },
    {
      table: 'samples',
      file_hash: 'h-loop',
      local_path: join(libraryRoot, 'sounds/packs/Fixture Pack/loop.wav'),
      filename: 'loop.wav',
      pack_uuid: 'pack-fixture',
      sample_type: 'loop',
      bpm: 140,
      audio_key: 'c#',
      chord_type: 'minor',
      duration: 9600,
      tags: 'drums,loop',
    },
    {
      table: 'samples',
      file_hash: 'h-bass',
      local_path: join(libraryRoot, 'sounds/packs/Fixture Pack/bass.wav'),
      filename: 'bass.wav',
      pack_uuid: 'pack-fixture',
      sample_type: 'oneshot',
      bpm: 90,
      audio_key: 'a',
      chord_type: '',
      duration: 2000,
      tags: 'bass,drums',
    },
    {
      table: 'samples',
      file_hash: 'h-tom',
      local_path: join(libraryRoot, 'sounds/packs/Fixture Pack/tom.wav'),
      filename: 'tom.wav',
      pack_uuid: 'pack-fixture',
      sample_type: 'oneshot',
      bpm: 100,
      audio_key: 'g',
      chord_type: '',
      duration: 500,
      tags: 'drums',
    },
    {
      table: 'samples',
      file_hash: 'h-boo',
      local_path: join(libraryRoot, 'sounds/packs/Ghost Pack/boo.wav'),
      filename: 'boo.wav',
      pack_uuid: 'pack-ghost',
      sample_type: 'oneshot',
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 300,
      tags: '',
    },
  ];
}

function setUp() {
  const libraryRoot = tmp();
  const dbPath = join(tmp(), 'sounds.db');
  buildFixtureSpliceDb(dbPath, buildFixtureRows(libraryRoot));
  const data = readSplice(dbPath);
  const catalog = freshCatalog();
  buildCatalog(catalog, data, libraryRoot); // wires rebuildSearch — see importer.ts's Task 7 seam
  return { catalog };
}

function idOf(catalog: Catalog, fileHash: string): number {
  const row = catalog.db.prepare('SELECT id FROM samples WHERE file_hash = ?').get(fileHash) as
    { id: number } | undefined;
  if (!row) throw new Error(`fixture sample "${fileHash}" not found`);
  return row.id;
}

function packIdOf(catalog: Catalog, uuid: string): number {
  const row = catalog.db.prepare('SELECT id FROM packs WHERE splice_uuid = ?').get(uuid) as
    { id: number } | undefined;
  if (!row) throw new Error(`fixture pack "${uuid}" not found`);
  return row.id;
}

function markMissing(catalog: Catalog, fileHash: string): void {
  catalog.db.prepare('UPDATE samples SET missing = 1 WHERE file_hash = ?').run(fileHash);
}

describe('querySamples', () => {
  it('shapes a row exactly: camelCase fields, coerced booleans, tags array, pack join', () => {
    const { catalog } = setUp();

    const loop = querySamples(catalog, {}).find((r) => r.filename === 'loop.wav');

    expect(loop).toEqual({
      id: idOf(catalog, 'h-loop'),
      filename: 'loop.wav',
      relPath: 'sounds/packs/Fixture Pack/loop.wav',
      packId: packIdOf(catalog, 'pack-fixture'),
      packName: 'Fixture Pack',
      sampleType: 'loop',
      bpm: 140,
      audioKey: 'c#',
      chordType: 'minor',
      durationMs: 9600,
      missing: false,
      tags: ['drums', 'loop'],
      hasPeaks: false,
      peaksFailed: false,
    });
  });

  it('returns every sample ordered by pack name then filename when no filters are set', () => {
    const { catalog } = setUp();

    const filenames = querySamples(catalog, {}).map((r) => r.filename);

    // "Fixture Pack" (4 samples, alphabetical) before "Ghost Pack" (1 sample).
    expect(filenames).toEqual(['bass.wav', 'kick.wav', 'loop.wav', 'tom.wav', 'boo.wav']);
  });

  it('does not exclude missing rows — the UI needs them to gray out, not disappear', () => {
    const { catalog } = setUp();
    markMissing(catalog, 'h-tom');

    const tom = querySamples(catalog, {}).find((r) => r.filename === 'tom.wav');

    expect(tom).toBeDefined();
    expect(tom?.missing).toBe(true);
  });

  it('hasPeaks/peaksFailed distinguish succeeded, failed (format=0), and no row at all', () => {
    const { catalog } = setUp();
    const insertWaveform = catalog.db.prepare(
      'INSERT INTO waveforms (sample_id, peaks, bucket_count, format) VALUES (?, ?, ?, ?)',
    );
    // loop.wav: a real decode succeeded — format 1 (spec §6's default/current format).
    insertWaveform.run(idOf(catalog, 'h-loop'), Buffer.alloc(400), 200, 1);
    // kick.wav: Task 10 writes format 0 for a decode that failed — a row exists, but it must
    // NOT read as "has peaks". This is the case a bare `sample_id IS NULL` check gets wrong.
    insertWaveform.run(idOf(catalog, 'h-kick'), Buffer.alloc(400), 200, 0);
    // bass.wav: no waveforms row at all — still pending, neither succeeded nor failed.

    const rows = querySamples(catalog, {});
    const loop = rows.find((r) => r.filename === 'loop.wav');
    const kick = rows.find((r) => r.filename === 'kick.wav');
    const bass = rows.find((r) => r.filename === 'bass.wav');

    expect(loop).toMatchObject({ hasPeaks: true, peaksFailed: false });
    expect(kick).toMatchObject({ hasPeaks: false, peaksFailed: true });
    expect(bass).toMatchObject({ hasPeaks: false, peaksFailed: false });
  });

  it('a search with zero matches returns [] without throwing (the empty-IN() guard)', () => {
    const { catalog } = setUp();

    expect(() => querySamples(catalog, { search: 'nonexistentxyz123' })).not.toThrow();
    expect(querySamples(catalog, { search: 'nonexistentxyz123' })).toEqual([]);
  });

  it('treats a blank search as no filter rather than forwarding it to throw', () => {
    const { catalog } = setUp();

    expect(() => querySamples(catalog, { search: '' })).not.toThrow();
    expect(querySamples(catalog, { search: '   ' })).toEqual(querySamples(catalog, {}));
  });

  it('BPM range filter excludes bpm-null rows (unknown-excluding semantics)', () => {
    const { catalog } = setUp();

    const filenames = querySamples(catalog, { bpmMin: 50, bpmMax: 200 })
      .map((r) => r.filename)
      .sort();

    expect(filenames).toEqual(['bass.wav', 'loop.wav', 'tom.wav']);
    // Assert the null-bpm rows are ABSENT, not just that the count is right.
    expect(filenames).not.toContain('kick.wav');
    expect(filenames).not.toContain('boo.wav');
  });

  it('key filter excludes key-null rows (unknown-excluding semantics)', () => {
    const { catalog } = setUp();

    const result = querySamples(catalog, { audioKey: 'c#' });

    expect(result.map((r) => r.filename)).toEqual(['loop.wav']);
    expect(result.find((r) => r.filename === 'kick.wav')).toBeUndefined();
    expect(result.find((r) => r.filename === 'boo.wav')).toBeUndefined();
  });

  it('tags filter requires ALL listed tags, not any', () => {
    const { catalog } = setUp();

    // Only bass.wav carries both 'drums' and 'bass' — kick/loop/tom each carry 'drums' alone
    // (plus one other tag apiece), so a same-any implementation would over-match.
    const result = querySamples(catalog, { tags: ['drums', 'bass'] });

    expect(result.map((r) => r.filename)).toEqual(['bass.wav']);
  });

  it('filters compose with search using AND', () => {
    const { catalog } = setUp();

    // 'drums' (tag prefix) matches kick/loop/bass/tom; sampleType 'loop' narrows to loop.wav alone.
    const result = querySamples(catalog, { search: 'drums', sampleType: 'loop' });

    expect(result.map((r) => r.filename)).toEqual(['loop.wav']);
  });
});

describe('listPacks', () => {
  it('hides a pack whose only sample is missing, keeps one with some present, counts only present', () => {
    const { catalog } = setUp();
    markMissing(catalog, 'h-tom'); // Fixture Pack: 4 samples, 1 now missing -> 3 present
    markMissing(catalog, 'h-boo'); // Ghost Pack's ONLY sample -> the pack should vanish entirely

    const packs = listPacks(catalog);

    expect(packs).toEqual([
      {
        id: packIdOf(catalog, 'pack-fixture'),
        name: 'Fixture Pack',
        coverFile: null,
        sampleCount: 3,
      },
    ]);
  });
});

describe('listTags', () => {
  it('counts non-missing samples only, sorted by count desc then name asc', () => {
    const { catalog } = setUp();
    markMissing(catalog, 'h-tom'); // drops one of drums' four carriers

    const tags = listTags(catalog);

    expect(tags).toEqual([
      { name: 'drums', count: 3 }, // kick, loop, bass — tom excluded (missing)
      { name: 'bass', count: 1 },
      { name: 'kick', count: 1 },
      { name: 'loop', count: 1 },
    ]);
  });
});

describe('pendingPeakIds', () => {
  it('returns non-missing samples with no waveforms row — excludes missing, succeeded, and failed-decode rows', () => {
    const { catalog } = setUp();
    const insertWaveform = catalog.db.prepare(
      'INSERT INTO waveforms (sample_id, peaks, bucket_count, format) VALUES (?, ?, ?, ?)',
    );
    // loop.wav: a real decode succeeded (format 1) — has a row, so it's not pending.
    insertWaveform.run(idOf(catalog, 'h-loop'), Buffer.alloc(400), 200, 1);
    // kick.wav: Task 10 writes format 0 for a failed decode — still has a row, still not
    // "pending" (a bare `no row` check must not resurrect a known-failed sample here).
    insertWaveform.run(idOf(catalog, 'h-kick'), Buffer.alloc(400), 200, 0);
    // tom.wav: missing entirely — excluded even though it also has no waveforms row, since
    // there is no file to decode.
    markMissing(catalog, 'h-tom');
    // bass.wav, boo.wav: non-missing, no waveforms row — the only two that should come back.

    const ids = pendingPeakIds(catalog);

    expect(ids).toEqual([idOf(catalog, 'h-bass'), idOf(catalog, 'h-boo')]);
  });

  it('returns [] once every non-missing sample has a waveforms row', () => {
    const { catalog } = setUp();
    const insertWaveform = catalog.db.prepare(
      'INSERT INTO waveforms (sample_id, peaks, bucket_count, format) VALUES (?, ?, ?, ?)',
    );
    for (const hash of ['h-kick', 'h-loop', 'h-bass', 'h-tom', 'h-boo']) {
      insertWaveform.run(idOf(catalog, hash), Buffer.alloc(400), 200, 1);
    }

    expect(pendingPeakIds(catalog)).toEqual([]);
  });
});

function waveformRow(catalog: Catalog, sampleId: number) {
  return catalog.db
    .prepare('SELECT peaks, bucket_count, format FROM waveforms WHERE sample_id = ?')
    .get(sampleId) as { peaks: Buffer; bucket_count: number; format: number } | undefined;
}

describe('writePeaks', () => {
  it('stores a successful decode as format=1, with bucket_count derived from the peaks length', () => {
    const { catalog } = setUp();
    const id = idOf(catalog, 'h-kick');
    const peaks = new Int8Array(400).fill(5); // 200 buckets' worth, arbitrary non-zero content

    writePeaks(catalog, id, peaks);

    const row = waveformRow(catalog, id);
    expect(row?.format).toBe(1);
    expect(row?.bucket_count).toBe(200);
    expect(Array.from(row?.peaks ?? [])).toEqual(Array.from(peaks));
  });

  it('upserts: a retried decode overwrites a prior writePeaksFailed row (format 0 -> 1)', () => {
    const { catalog } = setUp();
    const id = idOf(catalog, 'h-kick');
    writePeaksFailed(catalog, id);

    writePeaks(catalog, id, new Int8Array(400).fill(1));

    expect(waveformRow(catalog, id)).toMatchObject({ format: 1 });
  });
});

describe('writePeaksFailed', () => {
  it('writes a format=0 row with a NOT-NULL-satisfying zeroed 400-byte placeholder', () => {
    const { catalog } = setUp();
    const id = idOf(catalog, 'h-kick');

    writePeaksFailed(catalog, id);

    const row = waveformRow(catalog, id);
    expect(row).toMatchObject({ bucket_count: 200, format: 0 });
    expect(row?.peaks.length).toBe(400);
    expect(Array.from(row?.peaks ?? []).every((b) => b === 0)).toBe(true);
  });

  it('upserts: a re-failed decode stays format=0 rather than erroring on the PK conflict', () => {
    const { catalog } = setUp();
    const id = idOf(catalog, 'h-kick');
    writePeaksFailed(catalog, id);

    expect(() => writePeaksFailed(catalog, id)).not.toThrow();
    expect(waveformRow(catalog, id)).toMatchObject({ format: 0 });
  });
});

describe('getPeaks', () => {
  it('returns the stored bytes for the requested ids, keyed by sample id', () => {
    const { catalog } = setUp();
    const kickId = idOf(catalog, 'h-kick');
    const loopId = idOf(catalog, 'h-loop');
    const kickPeaks = new Int8Array(400).fill(7);
    const loopPeaks = new Int8Array(400).fill(-7);
    writePeaks(catalog, kickId, kickPeaks);
    writePeaks(catalog, loopId, loopPeaks);

    const result = getPeaks(catalog, [kickId, loopId]);

    expect(Array.from(new Int8Array(result[kickId]))).toEqual(Array.from(kickPeaks));
    expect(Array.from(new Int8Array(result[loopId]))).toEqual(Array.from(loopPeaks));
  });

  it('omits ids with no waveforms row; returns {} for an empty id list without querying', () => {
    const { catalog } = setUp();
    const kickId = idOf(catalog, 'h-kick');
    writePeaks(catalog, kickId, new Int8Array(400));

    expect(getPeaks(catalog, [])).toEqual({});
    const result = getPeaks(catalog, [kickId, idOf(catalog, 'h-bass')]);
    expect(Object.keys(result)).toEqual([String(kickId)]);
  });
});
