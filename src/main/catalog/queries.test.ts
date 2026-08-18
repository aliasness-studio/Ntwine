import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, type Catalog } from './db';
import { buildFixtureSpliceDb, type FixtureRow } from '../importer/fixtureSpliceDb';
import { readSplice } from '../importer/spliceDb';
import { buildCatalog } from '../importer/importer';
import { openUserDb } from '../user/userDb';
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

// Same fixture catalog as `setUp`, plus the `user` schema alias ATTACHed (Task 1's `openUserDb`)
// on the SAME connection — the shape every user-layer test below needs, since `querySamples`
// detects the attachment on `catalog.db` itself rather than taking a separate handle.
function setUpWithUser() {
  const { catalog } = setUp();
  const user = openUserDb(catalog, join(tmp(), 'user.db'));
  return { catalog, user };
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
      // No `openUserDb` on this connection — the three user-layer fields must still be present,
      // at their zero value, rather than absent (Task 3).
      favorite: false,
      nickname: null,
      userTags: [],
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

  it('scope { kind: pack } filters rows down to that pack only', () => {
    const { catalog } = setUp();
    const fixturePackId = packIdOf(catalog, 'pack-fixture');

    const result = querySamples(catalog, { scope: { kind: 'pack', packId: fixturePackId } });

    expect(result.map((r) => r.filename).sort()).toEqual([
      'bass.wav',
      'kick.wav',
      'loop.wav',
      'tom.wav',
    ]);
  });

  it('scope { kind: pack } for a DIFFERENT pack returns only that other pack’s sample', () => {
    const { catalog } = setUp();
    const ghostPackId = packIdOf(catalog, 'pack-ghost');

    const result = querySamples(catalog, { scope: { kind: 'pack', packId: ghostPackId } });

    expect(result.map((r) => r.filename)).toEqual(['boo.wav']);
  });

  it('an explicit scope: undefined returns every sample, same as omitting scope entirely', () => {
    const { catalog } = setUp();

    expect(querySamples(catalog, { scope: undefined })).toEqual(querySamples(catalog, {}));
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

describe('querySamples — user layer (favorite/nickname/userTags, favorites/collection scopes)', () => {
  it('carries favorite/nickname from user.sample_state onto rows; untouched samples default to false/null/[]', () => {
    const { catalog, user } = setUpWithUser();
    user.setFavorite('h-kick', true);
    user.setNickname('h-kick', 'THE snare');

    const rows = querySamples(catalog, {});
    const kick = rows.find((r) => r.filename === 'kick.wav');
    const bass = rows.find((r) => r.filename === 'bass.wav'); // never touched by user.*

    expect(kick).toMatchObject({ favorite: true, nickname: 'THE snare' });
    expect(bass).toMatchObject({ favorite: false, nickname: null, userTags: [] });
  });

  it('userTags are grouped per sample and sorted with localeCompare, never SQL collation', () => {
    const { catalog, user } = setUpWithUser();
    user.addUserTag('h-kick', 'Kick');
    user.addUserTag('h-kick', 'bounce');

    const kick = querySamples(catalog, {}).find((r) => r.filename === 'kick.wav');

    // Plain SQL BINARY collation would sort 'Kick' before 'bounce' (uppercase < lowercase in
    // ASCII); localeCompare orders case-insensitively. This pins a regression to `ORDER BY
    // t.name` in the user-tags query the same way userDb.test.ts pins `listUserTagNames`.
    expect(kick?.userTags).toEqual(['bounce', 'Kick']);
  });

  it('scope { kind: favorites } returns only favorited, catalog-present rows', () => {
    const { catalog, user } = setUpWithUser();
    user.setFavorite('h-kick', true);
    user.setFavorite('h-bass', true);
    user.setFavorite('h-dangling-hash', true); // no matching samples row — must not surface

    const result = querySamples(catalog, { scope: { kind: 'favorites' } });

    expect(result.map((r) => r.filename).sort()).toEqual(['bass.wav', 'kick.wav']);
  });

  it('scope { kind: collection } returns exactly that collection’s members', () => {
    const { catalog, user } = setUpWithUser();
    const { id } = user.createCollection('Drums');
    user.addToCollection(id, 'h-tom');
    user.addToCollection(id, 'h-loop');

    const result = querySamples(catalog, { scope: { kind: 'collection', collectionId: id } });

    expect(result.map((r) => r.filename).sort()).toEqual(['loop.wav', 'tom.wav']);
  });

  it('a pack scope still composes with the favorite field flowing through', () => {
    const { catalog, user } = setUpWithUser();
    const fixturePackId = packIdOf(catalog, 'pack-fixture');
    user.setFavorite('h-kick', true);

    const result = querySamples(catalog, { scope: { kind: 'pack', packId: fixturePackId } });

    expect(result.map((r) => r.filename).sort()).toEqual([
      'bass.wav',
      'kick.wav',
      'loop.wav',
      'tom.wav',
    ]);
    expect(result.find((r) => r.filename === 'kick.wav')?.favorite).toBe(true);
  });

  it('without openUserDb: favorites/collection scopes short-circuit to [], plain rows carry the three defaults', () => {
    const { catalog } = setUp(); // user schema never attached on this connection

    expect(querySamples(catalog, { scope: { kind: 'favorites' } })).toEqual([]);
    expect(
      querySamples(catalog, { scope: { kind: 'collection', collectionId: 'whatever' } }),
    ).toEqual([]);

    const rows = querySamples(catalog, {});
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.favorite).toBe(false);
      expect(r.nickname).toBeNull();
      expect(r.userTags).toEqual([]);
    }
  });
});

describe('querySamples — per-token search union (FTS + nickname + user tags, spec §3.4)', () => {
  it('mixed vocabulary: a token matching only via nickname unions with a token matching only via FTS text, AND across tokens', () => {
    const { catalog, user } = setUpWithUser();
    // Spec §3.4's own example, adapted to this fixture's "kick.wav" (already an FTS hit for
    // "kick" via both filename and its 'kick' tag) rather than inventing a new sample: nicknaming
    // it "THE snare" gives one row reachable by "snare" ONLY through the nickname, and by "kick"
    // ONLY through FTS — so a match on "snare kick" proves the two sources union per token.
    user.setNickname('h-kick', 'THE snare');

    const result = querySamples(catalog, { search: 'snare kick' });

    expect(result.map((r) => r.filename)).toEqual(['kick.wav']);
  });

  it('a user-tag token matches through the tag source, not FTS or nickname', () => {
    const { catalog, user } = setUpWithUser();
    user.addUserTag('h-bass', 'bounce'); // "bounce" appears nowhere in this fixture's FTS text

    const result = querySamples(catalog, { search: 'bounce' });

    expect(result.map((r) => r.filename)).toEqual(['bass.wav']);
  });

  // Note on this test's RED-phase power: any assertion of an EMPTY result here is structurally
  // unable to fail against the OLD (pre-Task-4) implementation — old FTS-only matching is a strict
  // subset of the new union matching (it can only find FEWER rows, never more), so a token that
  // only matches via nickname/tag returns [] under BOTH old and new code, for different reasons.
  // This test's real job is a falsifier for a specific bug class the new union logic invites —
  // unioning ACROSS tokens instead of per-token (turning "tokens AND" into "tokens OR") — verified
  // by temporarily swapping the intersection for a union in queries.ts during self-review, which
  // does turn this red.
  it('tokens AND, not OR, across sources: two tokens each matching a different row (via different sources) match neither', () => {
    const { catalog, user } = setUpWithUser();
    user.setNickname('h-kick', 'THE snare'); // 'snare' -> kick.wav, nickname-only
    user.addUserTag('h-bass', 'bounce'); // 'bounce' -> bass.wav, tag-only

    // Each token alone has a real, non-empty match, but on DIFFERENT rows — a buggy
    // union-ACROSS-tokens implementation would wrongly return both.
    expect(querySamples(catalog, { search: 'snare bounce' })).toEqual([]);
    // The brief's own phrasing of the case (spec §3.4): a garbage second token empties an
    // otherwise-matching single-token result too.
    expect(querySamples(catalog, { search: 'snare nosuch' })).toEqual([]);
  });

  it('an NFD search token matches an NFC-stored nickname (JS normalization); a plain ASCII prefix matches the same row', () => {
    const { catalog, user } = setUpWithUser();
    user.setNickname('h-tom', 'Café Hit');

    const nfdQuery = 'café'.normalize('NFD');
    // Prove this is byte-genuine NFD (5 UTF-16 units: c,a,f,e,COMBINING ACUTE ACCENT U+0301) and
    // not silently re-composed back to NFC (4 units, one precomposed 'é') by a source-file save —
    // .normalize('NFD') is called at runtime on a fresh literal specifically so the on-disk
    // encoding of this test file can never be the thing making the assertion pass.
    expect(nfdQuery.length).toBe(5);
    expect(nfdQuery).not.toBe('café');

    expect(querySamples(catalog, { search: nfdQuery }).map((r) => r.filename)).toEqual(['tom.wav']);
    // Word-boundary prefix, no unicode involved: 'caf' still reaches the same nickname.
    expect(querySamples(catalog, { search: 'caf' }).map((r) => r.filename)).toEqual(['tom.wav']);
  });

  it('word-boundary prefix: a token starting a word inside the nickname matches; a token starting mid-word does not', () => {
    const { catalog, user } = setUpWithUser();
    user.setNickname('h-kick', 'THE snare');

    expect(querySamples(catalog, { search: 'sna' }).map((r) => r.filename)).toEqual(['kick.wav']);
    // "nare" is a real suffix of "snare" but starts mid-word — must NOT match.
    expect(querySamples(catalog, { search: 'nare' })).toEqual([]);
  });

  it('FTS-only search is unaffected on a connection without openUserDb', () => {
    const { catalog } = setUp(); // user schema never attached

    const result = querySamples(catalog, { search: 'drums' });

    expect(result.map((r) => r.filename).sort()).toEqual([
      'bass.wav',
      'kick.wav',
      'loop.wav',
      'tom.wav',
    ]);
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

  it('rejects a peaks array that is empty or an odd length, naming the length in the error', () => {
    const { catalog } = setUp();
    const id = idOf(catalog, 'h-kick');

    // Tight, not `/length.*0/`: the message's static "...and > 0..." clause contains a literal
    // "0" regardless of the interpolated value, so a loose `.*0` pattern would pass even if the
    // interpolation were broken. Pin the actual "got length N" tail instead — matches the
    // `/got length 3/` sibling below (which happens not to be vacuous today, since no OTHER "3"
    // appears in the message, but is written the same tight way on purpose).
    expect(() => writePeaks(catalog, id, new Int8Array(0))).toThrow(/got length 0/);
    expect(() => writePeaks(catalog, id, new Int8Array(3))).toThrow(/got length 3/);
    // Neither rejected call left a row behind.
    expect(waveformRow(catalog, id)).toBeUndefined();
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

  // Review round 1, Finding 1: a `format = 0` row (writePeaksFailed) still has a `sample_id`, and
  // the unfiltered SQL used to hand its 400-zero-byte placeholder back exactly like a real decode.
  // A stale renderer snapshot (`row.peaksFailed` from the last `querySamples()`, not refreshed
  // until the next re-query) would then draw that placeholder as a thin, quiet-but-normal
  // waveform — silently misrepresenting a corrupt file as a real sample, with no corrupt badge.
  // Fixed at the root so this is enforced once regardless of renderer staleness: `getPeaks` must
  // never return an entry for a failed id at all, the same "omitted, not a zeroed placeholder"
  // contract the no-row-yet case above already has.
  it('omits an id whose decode failed (format = 0) — never hands back the zeroed placeholder blob', () => {
    const { catalog } = setUp();
    const kickId = idOf(catalog, 'h-kick');
    const loopId = idOf(catalog, 'h-loop');
    writePeaks(catalog, kickId, new Int8Array(400).fill(7));
    writePeaksFailed(catalog, loopId);

    const result = getPeaks(catalog, [kickId, loopId]);

    expect(Object.keys(result)).toEqual([String(kickId)]);
  });
});
