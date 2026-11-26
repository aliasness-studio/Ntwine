// tests/e2e/fixture/library.ts — builds a Splice-shaped synthetic library under a caller-supplied
// temp root: an empty userData/, a real sounds.db (via the unit-tested buildFixtureSpliceDb), and
// real WAV/AIFF audio for every row but one (the deliberate "missing file" case). Every count on
// the returned FixtureLibrary is DERIVED from SAMPLES below by `filter(...).length` (or, for
// keyText/bpmText/durationText/tags, by calling the SAME formatKey/formatDuration/parseTags the
// real UI renders with) — never hand-typed a second time, so a spec's expectation can never drift
// from what this fixture actually wrote to disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFixtureSpliceDb, type FixtureRow } from '../../../src/main/importer/fixtureSpliceDb';
import { parseTags } from '../../../src/main/importer/transform';
import { formatDuration, formatKey } from '../../../src/shared/keyDisplay';
import { writeSineAiff, writeSineWav } from '../../support/sineAudio';

const PACKS = [
  { uuid: 'pack-alpha', name: 'Alpha Drums', covered: true },
  { uuid: 'pack-beta', name: 'Beta Keys', covered: true },
  { uuid: 'pack-gamma', name: 'Gamma FX', covered: false },
] as const;

// 12 rows. Every count the specs assert is derived from THIS table, never hardcoded elsewhere.
// bpm 0 = none (5 rows) · 90 (3) · 128 (4)  →  100–140 matches 4
// audio_key NULL (4) · 'c#' (3) · 'a' (5)  — passed as an EXPLICIT null (see below)
// sample_type oneshot (8) · loop (4)
// tags: kick ×4, snare ×2, drums ×6, kick∧snare ×1 (AD_Snare_02), kick∨snare ×5 (case/space variants exercise parseTags: trim+lowercase+dedupe)
// ms is the DB `duration` value formatDuration renders (ms) — unrelated to the generated audio length;
// `null` is a real SQL NULL (→ '—').
// The NFD filename (the accented e as U+0065 + combining acute U+0301) is on a PRESENT row so statPass proves the on-disk name round-trips
// on APFS and NTFS; the missing row is plain ASCII — the two claims must never share a row.
const SAMPLES: Array<{ file: string; pack: 0 | 1 | 2; type: 'oneshot' | 'loop'; bpm: number; key: string | null; chord: 'major' | 'minor' | null; ms: number | null; tags: string; audioMs: number; kind: 'wav' | 'aiff' | 'missing' }> = [
  { file: 'AD_Kick_01.wav',        pack: 0, type: 'oneshot', bpm: 0,   key: null, chord: null,    ms: 412,  tags: 'Drums, kick',            audioMs: 400,  kind: 'wav' },
  { file: 'AD_Kick_02.wav',        pack: 0, type: 'oneshot', bpm: 0,   key: 'c#', chord: 'minor', ms: 1395, tags: 'drums,Kick ,punchy',     audioMs: 1400, kind: 'wav' },  // durationRow: 1.4s · tags drums,kick,punchy
  { file: 'AD_Snare_01.wav',       pack: 0, type: 'oneshot', bpm: 0,   key: null, chord: null,    ms: null, tags: 'drums, snare',            audioMs: 300,  kind: 'wav' },  // nullDurationFilename: '—'
  { file: 'AD_Snare_02.wav',       pack: 0, type: 'oneshot', bpm: 0,   key: 'a',  chord: null,    ms: 350,  tags: 'Drums,SNARE,kick,tight',  audioMs: 350,  kind: 'wav' },  // the one kick∧snare row
  { file: 'AD_Loop_128_kick.wav',  pack: 0, type: 'loop',    bpm: 128, key: 'c#', chord: 'minor', ms: 1875, tags: 'drums, loop, kick',       audioMs: 1800, kind: 'wav' },  // keyBpmRow: C♯ min · 128
  { file: 'AD_Loop_128_b.wav',     pack: 0, type: 'loop',    bpm: 128, key: 'a',  chord: 'major', ms: 1875, tags: 'drums, loop',             audioMs: 1800, kind: 'wav' },
  { file: 'BK_Chord_90.aiff',      pack: 1, type: 'loop',    bpm: 90,  key: 'a',  chord: 'major', ms: 2500, tags: 'keys, chord',             audioMs: 2500, kind: 'aiff' },
  { file: 'BK_Pluck.aiff',         pack: 1, type: 'oneshot', bpm: 0,   key: 'a',  chord: null,    ms: 800,  tags: 'keys, pluck',             audioMs: 800,  kind: 'aiff' },
  { file: 'BK_Pad_128.wav',        pack: 1, type: 'loop',    bpm: 128, key: 'c#', chord: 'major', ms: 2200, tags: 'keys, pad',               audioMs: 2200, kind: 'wav' },
  { file: 'GF_Café_Riser_90.wav', pack: 2, type: 'oneshot', bpm: 90,  key: null, chord: null,    ms: 2000, tags: 'fx, riser',               audioMs: 2000, kind: 'wav' },   // nfdFilename — PRESENT ('e' U+0065 + combining acute U+0301 = decomposed NFD; deliberately NOT precomposed U+00E9 — the decomposition is the whole point of this row)
  { file: 'GF_Impact_128.wav',     pack: 2, type: 'oneshot', bpm: 128, key: 'a',  chord: null,    ms: 900,  tags: 'fx, impact',              audioMs: 900,  kind: 'wav' },
  { file: 'GF_Hit_90.wav',         pack: 2, type: 'oneshot', bpm: 90,  key: null, chord: null,    ms: 1500, tags: 'fx, hit',                 audioMs: 100,  kind: 'missing' }, // missingFilename — plain ASCII, no file written
];

// 1×1 transparent PNG (68 bytes) — the standard minimal PNG; fixture.spec pins its signature + IHDR.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Sample = (typeof SAMPLES)[number];

// searchKick's "FTS model": a token is a maximal run of [a-z0-9] (case-folded); a row
// matches if some token in its filename, its parsed tags, or its pack name starts with "kick" —
// the `kick*` SQLite FTS5 prefix-query shape this fixture stands in for.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasKickToken(sample: Sample, packName: string): boolean {
  const tokens = [
    ...tokenize(sample.file),
    ...parseTags(sample.tags).flatMap(tokenize),
    ...tokenize(packName),
  ];
  return tokens.some((t) => t.startsWith('kick'));
}

function hasTag(sample: Sample, tag: string): boolean {
  return parseTags(sample.tags).includes(tag);
}

export interface FixtureLibrary {
  root: string;
  userData: string;
  appData: string;
  spliceDbPath: string; // where the fixture planted sounds.db (per-platform; matches the host's real detection glob)
  libraryRoot: string;
  totalSamples: number; // 12 — every row (querySamples / top-bar count)
  presentSamples: number; // 11 — rows whose file exists (listPacks / listTags counts)
  packs: string[]; // ['Alpha Drums', 'Beta Keys', 'Gamma FX'] (rail order = name asc)
  coveredPacks: string[]; // ['Alpha Drums', 'Beta Keys']
  uncoveredPack: string; // 'Gamma FX'
  perPack: Record<string, number>; // all rows      { 'Alpha Drums': 6, 'Beta Keys': 3, 'Gamma FX': 3 }
  perPackPresent: Record<string, number>; // present rows  { 'Alpha Drums': 6, 'Beta Keys': 3, 'Gamma FX': 2 }
  counts: {
    oneshot: number;
    loop: number;
    keyCSharp: number;
    keyA: number;
    keyNull: number;
    bpm100to140: number;
    tagKick: number;
    tagSnare: number;
    tagDrums: number;
    kickAndSnare: number;
    kickOrSnare: number;
    searchKick: number; // rows with a `kick*` token in filename ∪ tags ∪ pack name (FTS model)
  };
  missingFilename: string;
  aiffFilenames: string[];
  nfdFilename: string; // NFD row is PRESENT; missing row is ASCII — never the same row
  keyBpmRow: { filename: string; pack: string; keyText: string; bpmText: string }; // AD_Loop_128_kick.wav · 'C♯ min' · '128'
  durationRow: { filename: string; durationText: string; tags: string[] }; // AD_Kick_02.wav · '1.4s' · ['drums','kick','punchy']
  nullDurationFilename: string; // AD_Snare_01.wav → duration cell '—'
}

export function buildFixtureLibrary(root: string): FixtureLibrary {
  const userData = join(root, 'userData');
  const appData = join(root, 'appData');
  const libraryRoot = join(root, 'library');
  const coversDir = join(root, 'covers-src');
  // Planted where THIS host's real detection glob looks (paths.ts), so first-run.spec exercises
  // the unmodified glob: darwin keeps Splice's dir under appData itself; win32's real install
  // (verified 2026-08-19) uses "SpliceSettings" under LOCAL AppData, which the resolver reaches
  // by stepping ..\Local from the (here: overridden) appData dir — i.e. <root>/Local.
  const soundsDbDir =
    process.platform === 'win32'
      ? join(appData, '..', 'Local', 'SpliceSettings', 'users', 'default', 'e2e')
      : join(appData, 'com.splice.Splice', 'users', 'default', 'e2e');
  const dbPath = join(soundsDbDir, 'sounds.db');

  mkdirSync(userData, { recursive: true }); // empty; exists so app.setPath cannot throw
  mkdirSync(soundsDbDir, { recursive: true });
  mkdirSync(coversDir, { recursive: true });
  for (const pack of PACKS) {
    mkdirSync(join(libraryRoot, 'sounds', 'packs', pack.name, 'vendor'), { recursive: true });
  }

  // Splice's own settings.json, beside sounds.db exactly as a real install carries it (verified
  // 2026-08-20). Main's library-root detection reads `splice_folder` from here, so a launch with
  // NO NTWINE_LIBRARY_ROOT override resolves to THIS fixture's library — never to whatever real
  // Splice folder happens to exist on the machine running the suite, which is what keeps the
  // detection-path specs hermetic.
  writeFileSync(join(soundsDbDir, 'settings.json'), JSON.stringify({ splice_folder: libraryRoot }));

  // Covers: real PNG bytes on disk for the 2 covered packs, addressed by a real file: URL —
  // pathToFileURL owns the platform encoding (never a hand-built `file://` string, which would
  // mishandle a Windows drive letter). The third pack gets a real SQL NULL (fallback-tile path).
  const coverUrlByUuid = new Map<string, string | null>();
  for (const pack of PACKS) {
    if (!pack.covered) {
      coverUrlByUuid.set(pack.uuid, null);
      continue;
    }
    const png = join(coversDir, `${pack.uuid}.png`);
    writeFileSync(png, PNG_1X1);
    coverUrlByUuid.set(pack.uuid, pathToFileURL(png).toString());
  }

  const rows: FixtureRow[] = [];
  for (const pack of PACKS) {
    rows.push({
      table: 'packs',
      uuid: pack.uuid,
      name: pack.name,
      cover_url: coverUrlByUuid.get(pack.uuid) ?? null,
    });
  }

  for (const [i, sample] of SAMPLES.entries()) {
    const pack = PACKS[sample.pack];
    // The NFD filename is joined with its exact decomposed bytes as typed above — no .normalize()
    // anywhere on this path — so the bytes that hit the filesystem are the bytes SAMPLES declares.
    const localPath = join(libraryRoot, 'sounds', 'packs', pack.name, 'vendor', sample.file);

    if (sample.kind === 'wav') writeSineWav(localPath, sample.audioMs);
    else if (sample.kind === 'aiff') writeSineAiff(localPath, sample.audioMs);
    // kind === 'missing': the DB row below still points at this path — deliberately never written.

    rows.push({
      table: 'samples',
      file_hash: `fixture-${i}-${sample.file}`,
      local_path: localPath,
      filename: sample.file,
      pack_uuid: pack.uuid,
      sample_type: sample.type,
      bpm: sample.bpm,
      // Explicit null (never omitted) for the "none" rows: buildFixtureSpliceDb only maps an
      // OMITTED key to the ''/0 sentinel default — an explicit null is what makes it a real SQL
      // NULL, matching what a real Splice row looks like (see `buildFixtureSpliceDb`).
      audio_key: sample.key,
      chord_type: sample.chord,
      duration: sample.ms,
      tags: sample.tags,
    });
  }

  buildFixtureSpliceDb(dbPath, rows);

  const packNames = PACKS.map((p) => p.name).sort((a, b) => a.localeCompare(b));
  const coveredPacks = PACKS.filter((p) => p.covered)
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b));
  const uncoveredPack = PACKS.find((p) => !p.covered)!.name;

  const perPack: Record<string, number> = {};
  const perPackPresent: Record<string, number> = {};
  for (const pack of PACKS) {
    perPack[pack.name] = SAMPLES.filter((s) => PACKS[s.pack].uuid === pack.uuid).length;
    perPackPresent[pack.name] = SAMPLES.filter(
      (s) => PACKS[s.pack].uuid === pack.uuid && s.kind !== 'missing',
    ).length;
  }

  const counts = {
    oneshot: SAMPLES.filter((s) => s.type === 'oneshot').length,
    loop: SAMPLES.filter((s) => s.type === 'loop').length,
    keyCSharp: SAMPLES.filter((s) => s.key === 'c#').length,
    keyA: SAMPLES.filter((s) => s.key === 'a').length,
    keyNull: SAMPLES.filter((s) => s.key === null).length,
    bpm100to140: SAMPLES.filter((s) => s.bpm >= 100 && s.bpm <= 140).length,
    tagKick: SAMPLES.filter((s) => hasTag(s, 'kick')).length,
    tagSnare: SAMPLES.filter((s) => hasTag(s, 'snare')).length,
    tagDrums: SAMPLES.filter((s) => hasTag(s, 'drums')).length,
    kickAndSnare: SAMPLES.filter((s) => hasTag(s, 'kick') && hasTag(s, 'snare')).length,
    kickOrSnare: SAMPLES.filter((s) => hasTag(s, 'kick') || hasTag(s, 'snare')).length,
    searchKick: SAMPLES.filter((s) => hasKickToken(s, PACKS[s.pack].name)).length,
  };

  const missingFilename = SAMPLES.find((s) => s.kind === 'missing')!.file;
  const aiffFilenames = SAMPLES.filter((s) => s.kind === 'aiff').map((s) => s.file);
  // Structural, not a second hand-typed copy of the tricky bytes: "the one filename NFC-normalizing
  // changes" is exactly (and only) the decomposed-accent row — every other filename here is plain ASCII.
  const nfdFilename = SAMPLES.find((s) => s.file.normalize('NFC') !== s.file)!.file;

  const keyBpmSample = SAMPLES.find((s) => s.file === 'AD_Loop_128_kick.wav')!;
  const durationSample = SAMPLES.find((s) => s.file === 'AD_Kick_02.wav')!;
  const nullDurationSample = SAMPLES.find((s) => s.file === 'AD_Snare_01.wav')!;

  return {
    root,
    userData,
    appData,
    spliceDbPath: dbPath,
    libraryRoot,
    totalSamples: SAMPLES.length,
    presentSamples: SAMPLES.filter((s) => s.kind !== 'missing').length,
    packs: packNames,
    coveredPacks,
    uncoveredPack,
    perPack,
    perPackPresent,
    counts,
    missingFilename,
    aiffFilenames,
    nfdFilename,
    keyBpmRow: {
      filename: keyBpmSample.file,
      pack: PACKS[keyBpmSample.pack].name,
      keyText: formatKey(keyBpmSample.key, keyBpmSample.chord),
      bpmText: String(keyBpmSample.bpm),
    },
    durationRow: {
      filename: durationSample.file,
      durationText: formatDuration(durationSample.ms),
      tags: parseTags(durationSample.tags),
    },
    nullDurationFilename: nullDurationSample.file,
  };
}
