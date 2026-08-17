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
  // glob treats as ESCAPES. So the pattern stays literal and appDataDir goes in cwd.
  const subpath: Record<string, string> = {
    darwin: 'com.splice.Splice/users/default/*/sounds.db', // verified on disk (spec §2.2)
    win32: 'com.splice.Splice/users/default/*/sounds.db', // best-guess mirror; TODO verify on a Windows box
  };
  const pattern = subpath[platform];
  if (!pattern) return []; // linux etc.: picker-only until verified
  return globSync(pattern, { cwd: appDataDir }).map((p) => join(appDataDir, p));
}
