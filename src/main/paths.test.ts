import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dataDirFrom,
  readSpliceFolderSetting,
  resolveDefaultLibraryRoot,
  resolveSpliceDbCandidates,
} from './paths';

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

// Plants a sounds.db-shaped file with an optional settings.json BESIDE it — the real layout
// (verified 2026-08-20): both live in the same per-user Splice directory. Nothing here opens the
// db file; only its directory matters to the code under test.
function plantSpliceDir(): {
  dbPath: string;
  libraryDir: string;
  writeSettings: (raw: unknown) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ntwine-splicedir-'));
  const libraryDir = join(dir, 'Splice');
  mkdirSync(libraryDir, { recursive: true });
  const dbPath = join(dir, 'sounds.db');
  writeFileSync(dbPath, '');
  // A raw string is written verbatim (so a test can plant malformed JSON); anything else is
  // serialized, which is how a real settings.json arrives.
  const writeSettings = (raw: unknown): void => {
    writeFileSync(join(dir, 'settings.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
  };
  return { dbPath, libraryDir, writeSettings };
}

describe('readSpliceFolderSetting', () => {
  it('reads splice_folder from the settings.json beside sounds.db', () => {
    const { dbPath, libraryDir, writeSettings } = plantSpliceDir();
    writeSettings({ splice_folder: libraryDir });
    expect(readSpliceFolderSetting(dbPath)).toBe(libraryDir);
  });

  it('returns null when there is no settings.json at all', () => {
    expect(readSpliceFolderSetting(plantSpliceDir().dbPath)).toBeNull();
  });

  it('returns null on unparseable JSON rather than throwing', () => {
    const { dbPath, writeSettings } = plantSpliceDir();
    writeSettings('{ not json');
    expect(readSpliceFolderSetting(dbPath)).toBeNull();
  });

  it('returns null when the payload is valid JSON but not an object', () => {
    const { dbPath, writeSettings } = plantSpliceDir();
    writeSettings('null');
    expect(readSpliceFolderSetting(dbPath)).toBeNull();
  });

  it('returns null when splice_folder is absent, blank, or the wrong type', () => {
    for (const payload of [{ presets: null }, { splice_folder: '   ' }, { splice_folder: 42 }]) {
      const { dbPath, writeSettings } = plantSpliceDir();
      writeSettings(payload);
      expect(readSpliceFolderSetting(dbPath)).toBeNull();
    }
  });

  it('returns null when the reported folder is no longer on disk (a stale setting is not an answer)', () => {
    const { dbPath, libraryDir, writeSettings } = plantSpliceDir();
    writeSettings({ splice_folder: join(libraryDir, 'moved-away') });
    expect(readSpliceFolderSetting(dbPath)).toBeNull();
  });
});

describe('resolveDefaultLibraryRoot', () => {
  const HOME = join('/home', 'someone');
  const DOCS = join('/home', 'someone', 'Documents');

  it("prefers Splice's own reported folder over the platform default", () => {
    const { dbPath, libraryDir, writeSettings } = plantSpliceDir();
    writeSettings({ splice_folder: libraryDir });
    for (const platform of ['win32', 'darwin'] as const) {
      expect(
        resolveDefaultLibraryRoot({ spliceDbPath: dbPath, homeDir: HOME, documentsDir: DOCS, platform }),
      ).toBe(libraryDir);
    }
  });

  it('falls back to <Documents>\\Splice on win32 — the real stock location (verified 2026-08-20)', () => {
    expect(
      resolveDefaultLibraryRoot({ spliceDbPath: null, homeDir: HOME, documentsDir: DOCS, platform: 'win32' }),
    ).toBe(join(DOCS, 'Splice'));
  });

  it('falls back to ~/Splice on darwin', () => {
    expect(
      resolveDefaultLibraryRoot({ spliceDbPath: null, homeDir: HOME, documentsDir: DOCS, platform: 'darwin' }),
    ).toBe(join(HOME, 'Splice'));
  });

  it('falls back to the platform default when a DB exists but its settings.json does not', () => {
    expect(
      resolveDefaultLibraryRoot({
        spliceDbPath: plantSpliceDir().dbPath,
        homeDir: HOME,
        documentsDir: DOCS,
        platform: 'win32',
      }),
    ).toBe(join(DOCS, 'Splice'));
  });
});
