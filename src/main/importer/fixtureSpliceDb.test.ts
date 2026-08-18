import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFixtureSpliceDb } from './fixtureSpliceDb';

describe('buildFixtureSpliceDb duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ntwine-fixture-db-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('omitted → 0 (the documented sentinel), explicit null → SQL NULL, number → number', () => {
    const dbPath = join(dir, 'sounds.db');
    buildFixtureSpliceDb(dbPath, [
      { table: 'samples', file_hash: 'a', filename: 'a.wav' },
      { table: 'samples', file_hash: 'b', filename: 'b.wav', duration: null },
      { table: 'samples', file_hash: 'c', filename: 'c.wav', duration: 1395 },
    ]);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('select file_hash, duration from samples order by file_hash').all();
    db.close();
    expect(rows).toEqual([
      { file_hash: 'a', duration: 0 },
      { file_hash: 'b', duration: null },
      { file_hash: 'c', duration: 1395 },
    ]);
  });
});
