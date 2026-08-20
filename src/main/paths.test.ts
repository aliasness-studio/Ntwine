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

  it('win32: finds the VERIFIED layout — SpliceSettings under Local, given the Roaming dir Electron reports', () => {
    // Verified on a real Windows Splice install (2026-08-19): the DB lives at
    // %LOCALAPPDATA%\SpliceSettings\users\default\<user>\sounds.db, while Electron's
    // app.getPath('appData') is ROAMING. The resolver must step ..\Local itself.
    const base = mkdtempSync(join(tmpdir(), 'ntwine-appdata-'));
    const roaming = join(base, 'Roaming');
    const userDir = join(base, 'Local', 'SpliceSettings', 'users', 'default', 'someuser');
    mkdirSync(roaming, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    const dbPath = join(userDir, 'sounds.db');
    writeFileSync(dbPath, '');
    expect(resolveSpliceDbCandidates(roaming, 'win32')).toEqual([dbPath]);
  });

  it('win32: the old com.splice.Splice-under-Roaming guess no longer matches (it never existed on a real install)', () => {
    const { appDataDir } = plantFixture(); // plants com.splice.Splice under the given dir
    expect(resolveSpliceDbCandidates(appDataDir, 'win32')).toEqual([]);
  });

  it('returns [] on a platform with no known Splice location, even though the fixture exists', () => {
    const { appDataDir } = plantFixture();
    expect(resolveSpliceDbCandidates(appDataDir, 'linux')).toEqual([]);
  });
});
