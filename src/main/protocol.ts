import { net, protocol, type CustomScheme } from 'electron';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Catalog } from './catalog/db';
import type { E2EEmit } from './e2e';
import { relPathToAbs } from './importer/transform';

// Same privileges for both custom schemes (spec §9.1 / §4): `standard` so relative/absolute
// resource resolution and the FileSystem API work; `secure` + `supportFetchAPI` so a page loaded
// over sample:// (there isn't one, but a future dev-tools fetch() from the renderer must work
// too) is treated like https; `stream` so <audio> doesn't insist on buffering the whole response
// before playback can start.
//
// `corsEnabled: true` (Task 14 addition): `supportFetchAPI` alone makes fetch() usable BY a page
// loaded FROM this scheme — it does not exempt a fetch() FROM a different origin (the renderer's
// real origin, `http://localhost:5173` under `yarn start`'s Vite dev server, or `file://` in a
// packaged build) INTO this scheme from ordinary CORS enforcement. previewPlayer.ts's
// `fetch(sampleUrl(id))` is exactly that cross-origin case, and failed with "blocked by CORS
// policy" against a real running app until this flag was added — confirmed by reproducing the
// failure and re-testing after this one-line fix, not by documentation alone.
const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  // INVARIANT: corsEnabled is safe ONLY because this app loads zero remote/untrusted content —
  // no <webview>, no <iframe>, no window.open, no navigation to any origin but the app's own dev
  // server / packaged index.html. Re-read this comment before adding any of those. Enforced in
  // main.ts's createWindow: `setWindowOpenHandler` denies every window.open, and the
  // `will-navigate` handler denies any navigation outside the app's own origin — both exist
  // specifically to hold this line true. Electron's own advisory guidance is that corsEnabled is
  // safe only for apps that "do not load untrusted content" — this is that guarantee, made real.
  corsEnabled: true,
};

export const PROTOCOL_SCHEMES: CustomScheme[] = [
  { scheme: 'sample', privileges: PRIVILEGES },
  { scheme: 'cover', privileges: PRIVILEGES },
];

/**
 * Registers the sample:// and cover:// schemes as privileged (spec §9.1). Electron's own hard
 * constraint — `registerSchemesAsPrivileged` "can only be used before the ready event... and can
 * be called only once" — is why this is split out from `registerProtocols` below: main.ts calls
 * this one at module scope (before `app.whenReady()`), and `registerProtocols` (which does the
 * actual `protocol.handle` wiring) from inside the `whenReady().then()` callback, alongside
 * everything else that needs a live app.
 */
export function registerProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged(PROTOCOL_SCHEMES);
}

// Containment check: `path.relative` + a `..`/absolute test, never a string-prefix test. A
// prefix test (`resolved.startsWith(root)`) wrongly accepts a SIBLING directory that merely
// starts with the same characters — root "/tmp/lib" against "/tmp/library-evil/x.wav" passes a
// naive prefix check (the literal characters do match) despite "library-evil" not being inside
// "lib" at all. Same idiom transform.ts's `toRelPath` uses for the identical reason, and the
// exact idiom named in the Task 11 brief.
function isContained(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

interface SampleAbsPathRow {
  relPath: string;
  missing: number;
}

/**
 * sampleId -> absolute file path, or null if there's no such row, the row is flagged
 * `missing`, or (hostile/corrupt DB content — see protocol.test.ts) the resolved path would
 * land outside `libraryRoot`. THE shared resolution core (owner's "one question, two gates"
 * rule): the sample:// branch of `resolveProtocolRequest` below, drag.ts's `resolvePath`
 * (re-pointed here at Task 11), and ipc.ts's `decodePreviewPcm` all answer "where is this
 * sample's file, if it's safe to hand out at all" through this one function rather than three
 * independently-maintained copies of the same containment logic.
 */
export function resolveSampleAbsPath(
  catalog: Catalog,
  libraryRoot: string,
  sampleId: number,
): string | null {
  const row = catalog.db
    .prepare<[number], SampleAbsPathRow>(
      'SELECT rel_path AS relPath, missing FROM samples WHERE id = ?',
    )
    .get(sampleId);
  if (!row || row.missing === 1) return null;

  const abs = relPathToAbs(libraryRoot, row.relPath);
  return isContained(libraryRoot, abs) ? abs : null;
}

interface CoverFileRow {
  coverFile: string | null;
}

// packId -> absolute cover path, or null if there's no such pack, no cover has been downloaded
// yet (`cover_file IS NULL`), or the joined path would land outside `coversDir`. `cover_file` is
// a bare filename (covers.ts writes `<splice_uuid>.jpg`, never a path) — `coversDir` supplies
// the directory, the same "root + stored-relative-leaf" split `resolveSampleAbsPath` uses.
function resolveCoverAbsPath(catalog: Catalog, coversDir: string, packId: number): string | null {
  const row = catalog.db
    .prepare<[number], CoverFileRow>('SELECT cover_file AS coverFile FROM packs WHERE id = ?')
    .get(packId);
  if (!row || row.coverFile === null) return null;

  const abs = join(coversDir, row.coverFile);
  return isContained(coversDir, abs) ? abs : null;
}

// Anchored to the full string (`^...$`) and digits-only in the id position on purpose: a
// traversal attempt like `sample://s/../etc` simply fails to match at all (never reaches the DB
// lookup), and there's nothing to case-normalize since digits are the whole of what's parsed —
// the one detail spec §4 flags about `standard: true` custom schemes ("case-normalizes the URL
// host; numeric ids are immune") doesn't apply here at all.
const SAMPLE_URL_RE = /^sample:\/\/s\/(\d+)$/;
const COVER_URL_RE = /^cover:\/\/p\/(\d+)$/;

/**
 * Pure URL -> absolute path resolver for the sample:// and cover:// custom protocols (spec §4:
 * "sample:// URLs are opaque catalog ids, never paths"). Parses `sample://s/<id>` /
 * `cover://p/<id>`, resolves through the catalog, and applies containment — never touches
 * `electron`'s `protocol`/`net` APIs itself, which is what makes it testable without a live app;
 * `registerProtocols` below is the thin Electron-wiring layer that calls this per-request.
 */
export function resolveProtocolRequest(
  catalog: Catalog,
  libraryRoot: string,
  coversDir: string,
  url: string,
): string | null {
  const sampleMatch = SAMPLE_URL_RE.exec(url);
  if (sampleMatch) {
    return resolveSampleAbsPath(catalog, libraryRoot, Number(sampleMatch[1]));
  }

  const coverMatch = COVER_URL_RE.exec(url);
  if (coverMatch) {
    return resolveCoverAbsPath(catalog, coversDir, Number(coverMatch[1]));
  }

  return null;
}

export interface RegisterProtocolsDeps {
  catalog: Catalog;
  // A getter, not a captured string: `libraryRoot` can change at runtime (NtwineApi's
  // `pickLibraryRoot`, spec §8 "library root moved"), and this is registered once at startup —
  // every request must re-read the CURRENT value rather than resolve against a stale snapshot
  // from whenever `registerProtocols` happened to run.
  getLibraryRoot: () => string;
  coversDir: string;
  e2eEmit?: E2EEmit | null;
}

/**
 * Wires the sample:// and cover:// schemes to `resolveProtocolRequest` + `net.fetch` (spec
 * §9.1). Must run after `app.whenReady()` (unlike `registerProtocolSchemes` above).
 *
 * electron#38749 (open, as of the spec's research pass): `protocol.handle` doesn't honor `Range`
 * requests, so seeking/scrubbing would snap to 0. v1 preview is play-from-start only, so this
 * doesn't block — but the TODO below is load-bearing for whoever builds scrub UI later.
 */
export function registerProtocols(deps: RegisterProtocolsDeps): void {
  const handler = async (request: Request): Promise<Response> => {
    const resolved = resolveProtocolRequest(
      deps.catalog,
      deps.getLibraryRoot(),
      deps.coversDir,
      request.url,
    );
    if (deps.e2eEmit) {
      const u = new URL(request.url);
      const idText = u.pathname.replace(/^\//, '');
      deps.e2eEmit('ntwine:e2e:protocol', {
        scheme: u.protocol.slice(0, -1),
        id: /^\d+$/.test(idText) ? Number(idText) : null,
        hit: resolved !== null,
      });
    }
    if (resolved === null) return new Response(null, { status: 404 });
    // TODO(#38749): manual Range support before any scrub UI.
    return net.fetch(pathToFileURL(resolved).toString());
  };

  protocol.handle('sample', handler);
  protocol.handle('cover', handler);
}
