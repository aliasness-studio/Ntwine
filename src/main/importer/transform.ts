import { isAbsolute, join, relative, sep } from 'node:path';
import type { DownloadedSpliceSample } from './spliceDb';

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
//
// `raw === null` is treated exactly like `raw === ''` (both mean "unknown"), not as a third,
// unrecognized value — the real sounds.db stores a genuine SQL NULL here for the large majority
// of "no chord type" rows (Task 13 hand-QA, 2026-08-17: 3,737 of 4,197), not the empty string
// spec §2.2's own characterization implied. Confirmed firsthand via `sqlite3 sounds.db "SELECT
// chord_type, typeof(chord_type), COUNT(*) FROM samples GROUP BY 1,2"`. This was the exact crash
// on the very first real import (`buildCatalog`'s transaction aborted whole): `unknown chord_type
// "null"` — the quoted "null" there is `${raw}` template-stringifying the JS value `null`, not a
// stored 4-character string.
function toChordType(raw: string | null): 'major' | 'minor' | null {
  if (raw === '' || raw === null) return null;
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
 * Inverse of `toRelPath`: resolves a stored `rel_path` (always POSIX-separated, per
 * `toRelPath` above) back to a native absolute path under `libraryRoot`. Rejoined by splitting
 * on `/` and passing each segment through `path.join` individually, rather than
 * `join(libraryRoot, relPath)` as one string — the latter would resolve wrong on a Windows host
 * for a POSIX-separated `rel_path` (backslash vs. forward-slash).
 *
 * Shared by `statPass` (importer.ts) and `runPeaksQueue`'s `absPathsFor` (queue.ts) — both
 * answer the same question ("where is this sample's file on disk"), so they compute it from
 * this ONE definition rather than two independently-maintained copies that could drift (owner's
 * "one question, two gates" rule; `COVER_CANDIDATE_WHERE`, Task 9 review round 1, hoisted for
 * the identical reason). Task 10 review round 1 hoisted this one, having initially left it
 * duplicated between `statPass` and `absPathsFor`.
 */
export function relPathToAbs(libraryRoot: string, relPath: string): string {
  return join(libraryRoot, ...relPath.split('/'));
}

/**
 * Maps one raw Splice `samples` row onto Ntwine's normalized shape: null-sentinels resolved
 * (bpm 0, audio_key/chord_type '' -> null), tags parsed, local_path rewritten to a rel_path
 * under `libraryRoot`. Duration is milliseconds in both the source and `durationMs` — copied
 * verbatim, never rescaled (spec §2.3 pin). Throws — never guesses — on an unrecognized
 * sample_type/chord_type or a local_path outside the library root.
 */
export function normalizeSample(s: DownloadedSpliceSample, libraryRoot: string): NormalizedSample {
  return {
    fileHash: s.file_hash,
    relPath: toRelPath(s.local_path, libraryRoot),
    filename: s.filename,
    packUuid: s.pack_uuid,
    sampleType: toSampleType(s.sample_type),
    bpm: s.bpm === 0 ? null : s.bpm,
    // Explicit `null` check alongside `''`, not left to `null === '' ? null : s.audio_key`'s
    // accidental correctness (that expression's false-branch happens to already be `null` when
    // `s.audio_key` itself is `null` — true today, but a trap for a future edit that doesn't
    // realize it's depended on). Same real-world NULL shape as chord_type (see `toChordType`'s
    // comment) — audio_key just has no dedicated validator to have thrown on it, so this one
    // stayed silently "correct by luck" rather than crashing on the same real data.
    audioKey: s.audio_key === '' || s.audio_key === null ? null : s.audio_key,
    chordType: toChordType(s.chord_type),
    durationMs: s.duration,
    tags: parseTags(s.tags),
  };
}
