import { isAbsolute, relative, sep } from 'node:path';
import type { SpliceSample } from './spliceDb';

// Ntwine's normalized shape for one sample row — field names transcribed verbatim from the
// brief's Interfaces line, same order.
export interface NormalizedSample {
  fileHash: string;
  relPath: string;
  filename: string;
  packUuid: string | null;
  sampleType: 'oneshot' | 'loop';
  bpm: number | null;
  audioKey: string | null;
  chordType: 'major' | 'minor' | null;
  durationMs: number | null;
  tags: string[];
}

/**
 * Splits a Splice `tags` cell ("Drums, kicks ,drums,,  HIP HOP ") into a clean tag list:
 * comma-split, trimmed, lowercased, empties dropped, duplicates removed (first occurrence
 * wins the resulting order).
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of raw.split(',')) {
    const tag = piece.trim().toLowerCase();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function toSampleType(raw: string): 'oneshot' | 'loop' {
  if (raw === 'oneshot' || raw === 'loop') return raw;
  throw new Error(
    `normalizeSample: unknown sample_type "${raw}" — expected 'oneshot' or 'loop'; refusing to guess`,
  );
}

// chord_type carries the same persisted-enum contract in the catalog schema
// (`CHECK (chord_type IN ('major','minor'))`, src/main/catalog/db.ts) that sample_type does,
// so it gets the same "throw, never coerce" treatment — failing here beats surfacing as an
// opaque SQLite CHECK-constraint error deep inside buildCatalog's transaction.
function toChordType(raw: string): 'major' | 'minor' | null {
  if (raw === '') return null;
  if (raw === 'major' || raw === 'minor') return raw;
  throw new Error(
    `normalizeSample: unknown chord_type "${raw}" — expected '', 'major', or 'minor'; refusing to guess`,
  );
}

// Containment check: `path.relative` + a `..`/absolute test, not a string-prefix test (a
// prefix test would wrongly pass a sibling directory that merely starts with the same
// characters, e.g. root "/lib" against a path under "/lib-evil/"). Same idiom Task 11's
// protocol resolver uses for the same reason (spec plan, Task 11).
function toRelPath(localPath: string, libraryRoot: string): string {
  const rel = relative(libraryRoot, localPath);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!inside) {
    // Both paths named, per the brief: a silent ../ rel_path would poison every row
    // downstream (Task 11's containment check would then null every one out, one at a
    // time, with no explanation) — fail loud at import instead.
    throw new Error(
      `normalizeSample: local_path "${localPath}" is outside library root "${libraryRoot}" — ` +
        'refusing to import a row whose stored path could never resolve back to a real file',
    );
  }
  // Stored with POSIX separators regardless of host OS: rel_path must stay readable if the
  // library root moves to (or is mounted from) a different platform (spec §2.3 — "so the
  // library can move... without re-import"). `sep` here always matches whatever `relative`
  // just used (both come from the platform-default `node:path`), so this is a no-op on
  // POSIX hosts and a real backslash->slash rewrite on Windows.
  return rel.split(sep).join('/');
}

/**
 * Maps one raw Splice `samples` row onto Ntwine's normalized shape: null-sentinels resolved
 * (bpm 0, audio_key/chord_type '' -> null), tags parsed, local_path rewritten to a rel_path
 * under `libraryRoot`. Duration is milliseconds in both the source and `durationMs` — copied
 * verbatim, never rescaled (spec §2.3 pin). Throws — never guesses — on an unrecognized
 * sample_type/chord_type or a local_path outside the library root.
 */
export function normalizeSample(s: SpliceSample, libraryRoot: string): NormalizedSample {
  return {
    fileHash: s.file_hash,
    relPath: toRelPath(s.local_path, libraryRoot),
    filename: s.filename,
    packUuid: s.pack_uuid,
    sampleType: toSampleType(s.sample_type),
    bpm: s.bpm === 0 ? null : s.bpm,
    audioKey: s.audio_key === '' ? null : s.audio_key,
    chordType: toChordType(s.chord_type),
    durationMs: s.duration,
    tags: parseTags(s.tags),
  };
}
