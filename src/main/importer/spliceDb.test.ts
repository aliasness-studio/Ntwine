import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureSpliceDb, type FixtureRow } from './fixtureSpliceDb';
import { readSplice, snapshotSpliceDb } from './spliceDb';

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-splicedb-'));

// 2 packs / 3 samples. Each sample carries one of the brief's named edge cases; the third
// sample's filename AND its own pack's name are both NFD-normalized (spec §10: "unicode/NFD
// filename + pack name — APFS normalization and tag lower-casing diverge exactly there").
// Durations reuse the exact ms values spec §2.3 verified firsthand against the real library
// (1395 / 9600 / 12830 ms) so this fixture stays traceable to the numbers that pin the unit.
const PACK_ONE_UUID = 'pack-aaaa-1111';
const PACK_TWO_UUID = 'pack-bbbb-2222';
const NFD_PACK_NAME = 'Café Kicks'.normalize('NFD');
const NFD_FILENAME = 'café_kick.wav'.normalize('NFD');

const FIXTURE_ROWS: FixtureRow[] = [
  {
    table: 'packs',
    uuid: PACK_ONE_UUID,
    name: 'Fixture Pack One',
    genre: 'hip hop',
    provider_name: 'Fixture Provider',
    cover_url: 'https://cdn.example.com/covers/pack-one.jpg',
  },
  {
    table: 'packs',
    uuid: PACK_TWO_UUID,
    name: NFD_PACK_NAME,
    genre: null,
    provider_name: null,
    cover_url: null,
  },
  // Edge case 1 (brief): bpm 0 / audio_key '' / chord_type '' — the "none" sentinel trio.
  {
    table: 'samples',
    file_hash: 'hash-0001-kick',
    local_path: '/fixtures/splice/Fixture Pack One/kick_909.wav',
    filename: 'kick_909.wav',
    pack_uuid: PACK_ONE_UUID,
    sample_type: 'oneshot',
    bpm: 0,
    audio_key: '',
    chord_type: '',
    duration: 1395,
    tags: 'kick,drums,909',
  },
  // Edge case 2 (brief): ragged comma-separated tags, raw and unparsed at this layer.
  {
    table: 'samples',
    file_hash: 'hash-0002-loop',
    local_path: '/fixtures/splice/Fixture Pack One/loop_140.wav',
    filename: 'loop_140.wav',
    pack_uuid: PACK_ONE_UUID,
    sample_type: 'loop',
    bpm: 140,
    audio_key: 'c#',
    chord_type: 'minor',
    duration: 9600,
    tags: 'Drums, kicks ,drums',
  },
  // Edge case 3 (brief, spec §10): unicode NFD filename, paired with the NFD pack above.
  {
    table: 'samples',
    file_hash: 'hash-0003-cafe',
    local_path: `/fixtures/splice/${NFD_PACK_NAME}/${NFD_FILENAME}`,
    filename: NFD_FILENAME,
    pack_uuid: PACK_TWO_UUID,
    sample_type: 'oneshot',
    bpm: 128,
    audio_key: 'f#',
    chord_type: '',
    duration: 12830,
    tags: 'café,kick,unicode',
  },
];

describe('readSplice', () => {
  it('reads back 2 packs / 3 samples with exact row fidelity (spec §2.2 + §10 edge cases)', () => {
    const dir = tmp();
    const dbPath = join(dir, 'sounds.db');
    buildFixtureSpliceDb(dbPath, FIXTURE_ROWS);
    const snapPath = snapshotSpliceDb(dbPath, join(dir, 'snapshot'));

    const { samples, packs } = readSplice(snapPath);

    expect(packs).toHaveLength(2);
    expect(samples).toHaveLength(3);

    expect(packs).toEqual([
      {
        uuid: PACK_ONE_UUID,
        name: 'Fixture Pack One',
        genre: 'hip hop',
        provider_name: 'Fixture Provider',
        cover_url: 'https://cdn.example.com/covers/pack-one.jpg',
      },
      {
        uuid: PACK_TWO_UUID,
        name: NFD_PACK_NAME,
        genre: null,
        provider_name: null,
        cover_url: null,
      },
    ]);

    expect(samples).toEqual([
      {
        local_path: '/fixtures/splice/Fixture Pack One/kick_909.wav',
        file_hash: 'hash-0001-kick',
        filename: 'kick_909.wav',
        pack_uuid: PACK_ONE_UUID,
        sample_type: 'oneshot',
        bpm: 0,
        audio_key: '',
        chord_type: '',
        duration: 1395,
        tags: 'kick,drums,909',
      },
      {
        local_path: '/fixtures/splice/Fixture Pack One/loop_140.wav',
        file_hash: 'hash-0002-loop',
        filename: 'loop_140.wav',
        pack_uuid: PACK_ONE_UUID,
        sample_type: 'loop',
        bpm: 140,
        audio_key: 'c#',
        chord_type: 'minor',
        duration: 9600,
        tags: 'Drums, kicks ,drums',
      },
      {
        local_path: `/fixtures/splice/${NFD_PACK_NAME}/${NFD_FILENAME}`,
        file_hash: 'hash-0003-cafe',
        filename: NFD_FILENAME,
        pack_uuid: PACK_TWO_UUID,
        sample_type: 'oneshot',
        bpm: 128,
        audio_key: 'f#',
        chord_type: '',
        duration: 12830,
        tags: 'café,kick,unicode',
      },
    ]);

    // Falsifier: prove the round trip preserved DECOMPOSED code points instead of silently
    // re-normalizing to NFC. SQLite/Node don't normalize Unicode on their own, but that's
    // exactly the assumption spec §10 says not to trust — pin it, don't take it on faith.
    expect(samples[2].filename).toBe(NFD_FILENAME);
    expect(samples[2].filename).not.toBe('café_kick.wav'.normalize('NFC'));
    expect(samples[2].filename.normalize('NFC')).toBe('café_kick.wav'.normalize('NFC'));
  });

  it('tolerates a sample whose pack_uuid matches no packs row, with defaults for unset columns', () => {
    const dbPath = join(tmp(), 'sounds.db');
    buildFixtureSpliceDb(dbPath, [
      {
        table: 'samples',
        file_hash: 'hash-orphan',
        filename: 'orphan.wav',
        pack_uuid: 'no-such-pack-uuid',
      },
    ]);

    const { samples, packs } = readSplice(dbPath);

    expect(packs).toEqual([]);
    expect(samples).toEqual([
      {
        local_path: null,
        file_hash: 'hash-orphan',
        filename: 'orphan.wav',
        pack_uuid: 'no-such-pack-uuid',
        sample_type: 'oneshot',
        bpm: 0,
        audio_key: '',
        chord_type: '',
        duration: 0,
        tags: '',
      },
    ]);
  });
});

describe('snapshotSpliceDb', () => {
  it('is idempotent: identical repeated calls return the same path and byte-identical content', () => {
    const dir = tmp();
    const dbPath = join(dir, 'sounds.db');
    buildFixtureSpliceDb(dbPath, FIXTURE_ROWS);
    const destDir = join(dir, 'snapshot');

    const path1 = snapshotSpliceDb(dbPath, destDir);
    const path2 = snapshotSpliceDb(dbPath, destDir);

    expect(path2).toBe(path1);
    expect(readFileSync(path1)).toEqual(readFileSync(dbPath));
    expect(readFileSync(path2)).toEqual(readFileSync(dbPath));
  });

  it('never refuses to overwrite — last write wins even over a newer-mtime stale snapshot', () => {
    const dir = tmp();
    const dbPath = join(dir, 'sounds.db');
    buildFixtureSpliceDb(dbPath, FIXTURE_ROWS);
    const destDir = join(dir, 'snapshot');

    const path1 = snapshotSpliceDb(dbPath, destDir);
    // Plant a stale snapshot with different content and a mtime in the FUTURE relative to the
    // real source. A naive "skip if dest looks newer" freshness guard would leave this alone;
    // the brief's contract is explicit that no such guard exists.
    writeFileSync(path1, 'STALE-NOT-A-REAL-SQLITE-FILE');
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    utimesSync(path1, future, future);

    const path2 = snapshotSpliceDb(dbPath, destDir);

    expect(path2).toBe(path1);
    expect(readFileSync(path2)).toEqual(readFileSync(dbPath));
    const { samples } = readSplice(path2); // proves the stale garbage was replaced, not just path-equal
    expect(samples).toHaveLength(3);
  });
});
