import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureLibrary } from './fixture/library';

test('buildFixtureLibrary writes a Splice-shaped tree + sounds.db with the documented counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-fixture-'));
  try {
    const f = buildFixtureLibrary(root);
    expect(existsSync(f.userData)).toBe(true);
    const dbPath = f.spliceDbPath;
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('select local_path, sample_type, bpm, audio_key, duration, tags from samples').all() as {
      local_path: string; sample_type: string; bpm: number; audio_key: string | null; duration: number | null; tags: string;
    }[];
    expect(rows).toHaveLength(f.totalSamples);                                 // 12
    expect(rows.filter((r) => r.sample_type === 'oneshot')).toHaveLength(f.counts.oneshot);
    expect(rows.filter((r) => r.audio_key === 'c#')).toHaveLength(f.counts.keyCSharp);
    expect(rows.filter((r) => r.audio_key === null)).toHaveLength(f.counts.keyNull);   // real NULL, not ''
    expect(rows.filter((r) => r.duration === null)).toHaveLength(1);           // real NULL duration (→ '—')
    expect(rows.filter((r) => r.bpm >= 100 && r.bpm <= 140)).toHaveLength(f.counts.bpm100to140);
    expect(rows.filter((r) => /(^|,)\s*kick\s*(,|$)/i.test(r.tags))).toHaveLength(f.counts.tagKick);   // 4
    // 11 files exist, exactly one row's file is absent, all under libraryRoot
    const present = rows.filter((r) => existsSync(r.local_path));
    expect(present).toHaveLength(f.presentSamples);
    expect(rows.every((r) => r.local_path.startsWith(f.libraryRoot))).toBe(true);
    expect(rows.find((r) => !existsSync(r.local_path))!.local_path.endsWith(f.missingFilename)).toBe(true);
    // the NFD name is on disk under its exact bytes and is NOT the missing row
    const nfdRow = rows.find((r) => r.local_path.endsWith(f.nfdFilename))!;
    expect(f.nfdFilename).not.toBe(f.missingFilename);
    expect(existsSync(nfdRow.local_path)).toBe(true);
    expect(f.nfdFilename.normalize('NFC')).not.toBe(f.nfdFilename);         // it really is decomposed
    // covers: 2 PNGs on disk (signature + 1×1 IHDR), addressed by file URLs
    const pngs = readdirSync(join(root, 'covers-src'));
    expect(pngs).toHaveLength(2);
    for (const name of pngs) {
      const bytes = readFileSync(join(root, 'covers-src', name));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1, 1]);
    }
    const packs = db.prepare('select name, cover_url from packs').all() as { name: string; cover_url: string | null }[];
    expect(packs.filter((p) => p.cover_url?.startsWith('file:'))).toHaveLength(2);
    expect(packs.filter((p) => p.cover_url === null)).toHaveLength(1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
