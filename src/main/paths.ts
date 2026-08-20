import { app } from 'electron';
import { dirname, join } from 'node:path';
import { globSync, readFileSync, statSync } from 'node:fs'; // Node 22+: fs.globSync

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

/**
 * Splice's OWN answer to "where do my samples live": the `splice_folder` key of the settings.json
 * that sits in the same directory as sounds.db. Verified on a real Windows install (2026-08-20):
 * `%LOCALAPPDATA%\SpliceSettings\users\default\<user>\settings.json` holds
 * `"splice_folder": "C:\\Users\\<user>\\Documents\\Splice"`, and every `samples.local_path` in the
 * DB beside it is `<splice_folder>\Samples\packs\...` — i.e. the setting is an ancestor of every
 * sample, which is exactly what `normalizeSample`'s containment check requires of a library root.
 *
 * Preferred over any platform guess because it is reported rather than assumed: it already
 * accounts for a relocated library, a localized/redirected Documents folder, and whatever
 * per-platform subfolder layout Splice happens to use.
 *
 * Returns null for everything that isn't a usable answer — no settings.json, unparseable JSON, a
 * non-object payload, the key absent or not a non-empty string, or a path that isn't an existing
 * DIRECTORY — so callers fall through to their own default rather than adopting a path that can't
 * work.
 */
export function readSpliceFolderSetting(spliceDbPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dirname(spliceDbPath), 'settings.json'), 'utf8'));
  } catch {
    return null; // missing file, unreadable, or invalid JSON — all "no answer here"
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const folder = (parsed as { splice_folder?: unknown }).splice_folder;
  if (typeof folder !== 'string' || folder.trim() === '') return null;
  // A DIRECTORY specifically, not merely something that exists (review, PR #13): a library root
  // that happens to be a file would be adopted here and only fail much later, at import, where
  // every single sample reads as "outside library root" — a baffling error a mile from its cause.
  // Falling through to the platform default instead keeps the failure local and recoverable.
  try {
    return statSync(folder).isDirectory() ? folder : null;
  } catch {
    return null; // gone between read and stat, a broken symlink, or unreadable
  }
}

export interface DefaultLibraryRootOptions {
  /** Whatever `resolveSpliceDb` settled on, or null when detection found nothing. */
  spliceDbPath: string | null;
  homeDir: string;
  /** `app.getPath('documents')` — Windows' real Documents folder, which is localized and can be
   * redirected (OneDrive, a different drive), so it must be asked for rather than string-built. */
  documentsDir: string;
  platform?: NodeJS.Platform;
}

/**
 * The library root to use when the user hasn't picked one — Splice's own `splice_folder` when we
 * can read it, otherwise the platform's stock install location. Only ever a DEFAULT: a persisted
 * `meta.library_root` (from an import or the Change… picker) always wins over this.
 *
 * The platform arm matters because Splice's stock location genuinely differs — `~/Splice` on
 * macOS, `<Documents>\Splice` on Windows (verified 2026-08-20). Shipping the macOS path as the
 * cross-platform default is what made first-run refuse every row on Windows with
 * "local_path ... is outside library root".
 */
export function resolveDefaultLibraryRoot(opts: DefaultLibraryRootOptions): string {
  if (opts.spliceDbPath !== null) {
    const reported = readSpliceFolderSetting(opts.spliceDbPath);
    if (reported !== null) return reported;
  }
  const platform = opts.platform ?? process.platform;
  return platform === 'win32'
    ? join(opts.documentsDir, 'Splice')
    : join(opts.homeDir, 'Splice');
}
