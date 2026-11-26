import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTags, normalizeSample, relPathToAbs } from './transform';

describe('parseTags', () => {
  it('splits, trims, lowercases, dedupes, drops empties', () => {
    expect(parseTags('Drums, kicks ,drums,,  HIP HOP ')).toEqual(['drums', 'kicks', 'hip hop']);
  });
});
describe('normalizeSample', () => {
  const base = {
    local_path: '/root/sounds/packs/P/kick.wav',
    file_hash: 'h',
    filename: 'kick.wav',
    pack_uuid: 'u',
    sample_type: 'oneshot',
    bpm: 0,
    audio_key: '',
    chord_type: '',
    duration: 1395,
    tags: 'drums',
  };
  it('maps zero/empty to null and keeps ms duration verbatim', () => {
    const n = normalizeSample(base as any, '/root');
    expect(n).toMatchObject({
      bpm: null,
      audioKey: null,
      chordType: null,
      durationMs: 1395,
      relPath: 'sounds/packs/P/kick.wav',
    });
  });
  it('keeps real bpm/key/chord', () => {
    const n = normalizeSample(
      { ...base, bpm: 140, audio_key: 'c#', chord_type: 'minor' } as any,
      '/root',
    );
    expect(n).toMatchObject({ bpm: 140, audioKey: 'c#', chordType: 'minor' });
  });
  // Manual testing against a REAL Splice sounds.db found this is not
  // hypothetical: `sqlite3 sounds.db "SELECT chord_type, typeof(chord_type), COUNT(*) FROM
  // samples GROUP BY 1,2"` on the real 4,197-row library shows chord_type is genuine SQL NULL
  // (typeof = 'null') for 3,737 rows and audio_key is genuine SQL NULL for 2,977 rows — NOT the
  // empty string '' every existing fixture/test in this file assumed. `toChordType` threw `unknown chord_type "null"` on the very first
  // real import, aborting the whole buildCatalog transaction. A real NULL must be treated
  // identically to '' (both mean "unknown"), not surfaced as a third, unrecognized value.
  it('maps a genuine SQL NULL chord_type/audio_key to null, same as empty string (real-world shape)', () => {
    const n = normalizeSample({ ...base, audio_key: null, chord_type: null } as any, '/root');
    expect(n).toMatchObject({ audioKey: null, chordType: null });
  });
  it('throws on an unknown sample_type instead of guessing', () => {
    expect(() => normalizeSample({ ...base, sample_type: 'granular' } as any, '/root')).toThrow(
      /sample_type/,
    );
  });
  it('throws when local_path is outside the library root (both paths in the message)', () => {
    expect(() => normalizeSample(base as any, '/other-root')).toThrow(
      /\/other-root.*\/root|\/root.*\/other-root/,
    );
  });
});

// chord_type carries the same persisted-enum contract in the catalog schema
// (`CHECK (chord_type IN ('major','minor'))`, src/main/catalog/db.ts) that sample_type does.
// This pins the chord_type throw symmetric to the sample_type one,
// so it doesn't surface three transaction-steps downstream as an opaque SQLite CHECK failure.
describe('normalizeSample — additional', () => {
  const base = {
    local_path: '/root/sounds/packs/P/kick.wav',
    file_hash: 'h',
    filename: 'kick.wav',
    pack_uuid: 'u',
    sample_type: 'oneshot',
    bpm: 0,
    audio_key: '',
    chord_type: '',
    duration: 1395,
    tags: 'drums',
  };
  it('throws on an unknown chord_type instead of guessing', () => {
    expect(() => normalizeSample({ ...base, chord_type: 'phrygian' } as any, '/root')).toThrow(
      /chord_type/,
    );
  });
});

describe('parseTags — additional', () => {
  it('returns an empty array for an empty tags string', () => {
    expect(parseTags('')).toEqual([]);
  });
});

// relPathToAbs is the one shared definition behind importer.ts's statPass and queue.ts's
// absPathsFor (one-question-two-gates).
describe('relPathToAbs — additional', () => {
  it('rejoins a multi-segment POSIX rel_path under libraryRoot', () => {
    // relPathToAbs returns a HOST-NATIVE absolute path by contract (its doc comment), so the
    // expectation is built with the host separator — POSIX-hardcoding this broke on Windows.
    expect(relPathToAbs('/root', 'sounds/packs/P/kick.wav')).toBe(
      ['', 'root', 'sounds', 'packs', 'P', 'kick.wav'].join(sep),
    );
  });

  it('is the true inverse of toRelPath — round-trips through normalizeSample back to local_path', () => {
    // Native input path (not hardcoded POSIX) so the inverse property is exercised on every
    // host: toRelPath takes a native local_path, relPathToAbs must hand the same one back.
    const root = join(sep, 'root');
    const base = {
      local_path: join(root, 'sounds', 'packs', 'P', 'kick.wav'),
      file_hash: 'h',
      filename: 'kick.wav',
      pack_uuid: 'u',
      sample_type: 'oneshot',
      bpm: 0,
      audio_key: '',
      chord_type: '',
      duration: 1395,
      tags: 'drums',
    };
    const n = normalizeSample(base as any, root);

    expect(relPathToAbs(root, n.relPath)).toBe(base.local_path);
  });
});
