import { app } from 'electron';
import { join } from 'node:path';
import { globSync } from 'node:fs'; // Node 22+: fs.globSync

export function dataDirFrom(userData: string): string {
  return join(userData, 'ntwine-data');
}

// The zero-arg entry point — only called from main. Tests use dataDirFrom directly
// with an injected root instead, since app.getPath('userData') needs a live app.
export function dataDir(): string {
  return dataDirFrom(app.getPath('userData'));
}

export function resolveSpliceDbCandidates(
  appDataDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // appDataDir = app.getPath('appData') — cross-platform per spec §5.1.
  // Glob PATTERNS are POSIX-only: a Windows path.join would inject backslashes, which
  // glob treats as ESCAPES. So the pattern stays literal and the root goes in cwd.
  //
  // win32 (VERIFIED on a real Windows Splice install, 2026-08-19): the DB lives at
  // %LOCALAPPDATA%\SpliceSettings\users\default\<user>\sounds.db — Splice's Electron userData
  // dir is "SpliceSettings" under LOCAL AppData, while Electron's app.getPath('appData') is
  // ROAMING. Stepping ..\Local from the GIVEN dir (rather than reading env LOCALAPPDATA) keeps
  // an E2E NTWINE_APP_DATA override hermetic: env would leak the developer's real sounds.db
  // into runs that assert "not found".
  const roots: Record<string, { root: string; pattern: string }> = {
    darwin: {
      root: appDataDir,
      pattern: 'com.splice.Splice/users/default/*/sounds.db', // verified on disk (spec §2.2)
    },
    win32: {
      root: join(appDataDir, '..', 'Local'),
      pattern: 'SpliceSettings/users/default/*/sounds.db',
    },
  };
  const entry = roots[platform];
  if (!entry) return []; // linux etc.: picker-only until verified
  return globSync(entry.pattern, { cwd: entry.root }).map((p) => join(entry.root, p));
}
