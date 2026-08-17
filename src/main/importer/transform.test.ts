import { describe, expect, it } from 'vitest';
import { parseTags, normalizeSample } from './transform';

describe('parseTags', () => {
  it('splits, trims, lowercases, dedupes, drops empties', () => {
    expect(parseTags('Drums, kicks ,drums,,  HIP HOP ')).toEqual(['drums', 'kicks', 'hip hop']);
  });
});
describe('normalizeSample', () => {
  const base = { local_path: '/root/sounds/packs/P/kick.wav', file_hash: 'h', filename: 'kick.wav',
    pack_uuid: 'u', sample_type: 'oneshot', bpm: 0, audio_key: '', chord_type: '', duration: 1395, tags: 'drums' };
  it('maps zero/empty to null and keeps ms duration verbatim (spec §2.3 pin)', () => {
    const n = normalizeSample(base as any, '/root');
    expect(n).toMatchObject({ bpm: null, audioKey: null, chordType: null, durationMs: 1395, relPath: 'sounds/packs/P/kick.wav' });
  });
  it('keeps real bpm/key/chord', () => {
    const n = normalizeSample({ ...base, bpm: 140, audio_key: 'c#', chord_type: 'minor' } as any, '/root');
    expect(n).toMatchObject({ bpm: 140, audioKey: 'c#', chordType: 'minor' });
  });
  it('throws on an unknown sample_type instead of guessing', () => {
    expect(() => normalizeSample({ ...base, sample_type: 'granular' } as any, '/root')).toThrow(/sample_type/);
  });
  it('throws when local_path is outside the library root (both paths in the message)', () => {
    expect(() => normalizeSample(base as any, '/other-root')).toThrow(/\/other-root.*\/root|\/root.*\/other-root/);
  });
});

// --- Additional tests below this line — not part of the brief's Step 1 verbatim block. ---
//
// chord_type carries the same persisted-enum contract in the catalog schema
// (`CHECK (chord_type IN ('major','minor'))`, src/main/catalog/db.ts) that sample_type does.
// The brief only mandates the sample_type throw; this pins the symmetric chord_type behavior
// so it doesn't surface three transaction-steps downstream as an opaque SQLite CHECK failure.
describe('normalizeSample — additional (not in brief)', () => {
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

describe('parseTags — additional (not in brief)', () => {
  it('returns an empty array for an empty tags string', () => {
    expect(parseTags('')).toEqual([]);
  });
});
