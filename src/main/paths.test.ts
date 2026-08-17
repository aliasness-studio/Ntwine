import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirFrom, resolveSpliceDbCandidates } from './paths';

describe('dataDirFrom', () => {
  it('joins userData with ntwine-data', () => {
    expect(dataDirFrom('/x/y')).toBe(join('/x/y', 'ntwine-data'));
  });
});

describe('resolveSpliceDbCandidates', () => {
  const plantFixture = () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'ntwine-appdata-'));
    const userDir = join(appDataDir, 'com.splice.Splice', 'users', 'default', 'someuser');
    mkdirSync(userDir, { recursive: true });
    const dbPath = join(userDir, 'sounds.db');
    writeFileSync(dbPath, '');
    return { appDataDir, dbPath };
  };

  it('finds a planted sounds.db under a temp appData dir (darwin)', () => {
    const { appDataDir, dbPath } = plantFixture();
    expect(resolveSpliceDbCandidates(appDataDir, 'darwin')).toEqual([dbPath]);
  });

  it('finds the same fixture under the win32 mirror pattern', () => {
    const { appDataDir, dbPath } = plantFixture();
    expect(resolveSpliceDbCandidates(appDataDir, 'win32')).toEqual([dbPath]);
  });

  it('returns [] on a platform with no known Splice location, even though the fixture exists', () => {
    const { appDataDir } = plantFixture();
    expect(resolveSpliceDbCandidates(appDataDir, 'linux')).toEqual([]);
  });
});
