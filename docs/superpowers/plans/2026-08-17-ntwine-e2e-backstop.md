# Ntwine e2e Backstop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Playwright end-to-end suite that pins every user-visible flow of Ntwine v1 (PR #1) against a generated Splice-shaped fixture library, gated by `yarn e2e` first-hand and CI-ready on dispatch — so feature PRs cannot silently regress what works today.

**Architecture:** The app gains a tiny env-gated E2E mode (`NTWINE_E2E=1`: redirected data dirs + library root, a boot guard, seam events on the `app` emitter, a renderer read-only snapshot). A fixture builder writes a 3-pack / 12-sample library + `sounds.db` into a temp dir per test. The Playwright runner executes under Electron's Node (the repo's existing `yarn test` idiom) so `better-sqlite3` loads in the runner; `launchNtwine` starts the production-built, unpackaged app with the E2E env (minus `ELECTRON_RUN_AS_NODE`) and yields a `Page` + a `seam` recorder. Specs drive the real DOM and assert what the user reads; seams and the snapshot cover what the DOM cannot show.

**Tech Stack:** `@playwright/test` 1.62.1 (exact pin), Electron 43.4.0 (`node_modules` binary), Electron Forge 7.11 (`package` = production build), better-sqlite3 (existing), Node 20+ host / Node 24 in Electron, GitHub Actions (`workflow_dispatch`).

**Spec:** `docs/superpowers/specs/2026-08-17-ntwine-e2e-backstop-design.md` (panel-applied). Parent: `docs/superpowers/specs/2026-08-16-ntwine-v1-design.md`.

## Global Constraints

- **Nothing outside E2E mode may change behaviour.** Every new code path is behind `readE2EConfig(process.env) !== null` (i.e. `NTWINE_E2E=1`); with it unset the app is byte-for-byte v1. Unit-pinned in `src/main/e2e.test.ts`.
- **E2E mode refuses to boot without `NTWINE_USER_DATA`** (absolute path). The suite never writes to `~/Splice`, `~/Library/Application Support/Ntwine`, `%APPDATA%\Ntwine`, or `.local/`. Fixture roots come from `fs.mkdtemp`.
- **Runner ABI:** `yarn e2e:only` = `cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/@playwright/test/cli.js test --project default`. `launchNtwine` **deletes** `ELECTRON_RUN_AS_NODE` from the child env. Task 2 proves this or switches the whole plan to the named fallback (helper CLI) — decided once, recorded in the ledger.
- **Launch target:** production build only — `.vite/build/main.js` + `.vite/renderer/main_window/index.html` produced by `electron-forge package`; the harness fails fast on a dev-mode build (`http://localhost:` inside `main.js`) or a missing renderer index.
- **Waits are conditions, never sleeps.** No `waitForTimeout`. Negatives are seam counters that stay flat while a sibling positive increments.
- **Locators:** roles / `aria-label`s / visible text first; `data-testid` only on the five elements §3.1 of the spec licenses (`detected-splice-db`, `result-count`, `missing-badge`, `settings-library-root`, `cover-fallback`). Filenames are matched on the row's `title` attribute (visible text is middle-truncated at 42 chars).
- **Every spec is falsifiable:** its task report names the falsifier run once by hand (comment out the guard/hook/branch under test → the spec fails).
- Cross-platform: `path.join`, `os.tmpdir()`, `pathToFileURL`, `fileURLToPath`; no `/` literals; binaries resolved per platform. macOS is the first-hand gate; Windows is the owner's gate (expected to find app defects — record them, don't fix them in this lane).
- Pins: `@playwright/test` **1.62.1** exact; MobX/React/TS pins unchanged; no `eslint-plugin-playwright`; no `playwright install`; CI env `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- Gates on every commit: `yarn test && yarn typecheck && yarn lint` green on the committed tree; from Task 2 on, also `yarn e2e:only` (after a `yarn package`) for the specs that exist. Commit author `AliasNess Studio <aliasness.studio@proton.me>`. Never stash/amend/rebase/force-push.
- Repo hygiene: `.gitignore` gains `playwright-report/`, `test-results/`; Vitest keeps `src/**/*.test.ts`; Playwright owns `tests/e2e/**/*.spec.ts`; `tsconfig.json` unchanged (no `include`, `allowJs: true`).

---

## File structure

```
src/main/e2e.ts                     readE2EConfig / makeE2EEmitter (pure; unit-tested)
src/main/e2e.test.ts
src/shared/e2eTypes.ts              E2ESnapshot type (shared by renderer + specs)
src/main.ts                         wiring only: setPath, emitter, additionalArguments, boot marker, denial seams
src/main/drag.ts                    + optional e2eEmit → emit + skip native startDrag
src/main/protocol.ts                + optional e2eEmit → protocol seam
src/main/ipc.ts                     + defaultLibraryRoot threading, preview-pcm seam
src/preload.ts                      + `--ntwine-e2e` → window.ntwineE2E = true
src/renderer.tsx                    + play counter wrapper + window.__ntwineE2E snapshot (armed only)
src/renderer/global.d.ts            + ntwineE2E / __ntwineE2E typings
src/renderer/components/*.tsx       + the five data-testids (attributes only)
tests/support/sineAudio.ts          writeSineWav / writeSineAiff (shared generator; replaces scripts/gen-fixture-audio.mjs + tests/fixtures/*)
src/main/waveforms/decode.test.ts   generates its inputs via tests/support/sineAudio.ts
tests/e2e/fixture/library.ts        buildFixtureLibrary(root) → FixtureLibrary
tests/e2e/harness/launch.ts         assertProductionArtifact, launchNtwine, REPO_ROOT
tests/e2e/harness/seam.ts           createSeam(app): arm / count / drain
tests/e2e/harness/fixtures.ts       Playwright test.extend: `ntwine`
tests/e2e/harness/actions.ts        importAndWait, readCount, search, clickPack, toggleType, pickKey, setBpm, toggleTag, rowByFilename, waitForWaveform, snapshot
tests/e2e/harness/packaged.ts       packagedExecutable()
tests/e2e/*.spec.ts                 runner-abi, boot, fixture, first-run, persistence, browse, rows, filters, search, waveforms, preview, drag, settings, security, packaged, real-library
playwright.config.ts
forge.config.ts                     + AutoUnpackNativesPlugin (F7)
package.json                        + @playwright/test 1.62.1, scripts e2e / e2e:only / e2e:real
.github/workflows/e2e.yml           workflow_dispatch, macos-latest + windows-latest
README.md                           Verification section
```

---

### Task 1: E2E mode contract in the app

**Files:**
- Create: `src/main/e2e.ts`, `src/main/e2e.test.ts`, `src/shared/e2eTypes.ts`
- Modify: `src/main.ts`, `src/main/drag.ts`, `src/main/protocol.ts`, `src/main/ipc.ts`, `src/preload.ts`, `src/renderer.tsx`, `src/renderer/global.d.ts`

**Interfaces:**
- Produces (`src/main/e2e.ts`):
  ```ts
  export interface E2EConfig { userData: string; appData: string | null; libraryRoot: string | null; bootMarker: string | null }
  export class E2EConfigError extends Error {}
  export function readE2EConfig(env: NodeJS.ProcessEnv): E2EConfig | null   // null unless env.NTWINE_E2E === '1'; throws E2EConfigError when armed without an absolute NTWINE_USER_DATA
  export type E2EEmit = (event: string, payload: unknown) => void
  export interface EmitterLike { emit(eventName: string, ...args: unknown[]): boolean }
  export function makeE2EEmitter(app: EmitterLike, cfg: E2EConfig | null): E2EEmit | null   // null when unarmed
  ```
  Seam event names (string literals, used verbatim by later tasks): `ntwine:e2e:drag` `{ sampleId: number; file: string | null }`, `ntwine:e2e:protocol` `{ scheme: 'sample' | 'cover'; id: number | null; hit: boolean }`, `ntwine:e2e:preview-pcm` `{ sampleId: number; ok: boolean }`, `ntwine:e2e:nav-denied` `{ url: string }`, `ntwine:e2e:window-open-denied` `{ url: string }`.
- Produces (`src/shared/e2eTypes.ts`):
  ```ts
  export interface E2ESnapshot { rows: number; resultCount: number; selectedId: number | null; volume: number; filters: Record<string, unknown>; importPhase: string | null; running: boolean; peaksCached: number; playCount: number; lastPlayedId: number | null }
  ```
  (`rows` is the row **count** — the array is not worth serializing across `evaluate`.)
- Produces (renderer): `window.ntwineE2E === true` when armed (preload); `window.__ntwineE2E: () => E2ESnapshot` when armed (renderer.tsx), attached synchronously at module execution.
- Modifies (`src/main/ipc.ts`): `currentLibraryRoot(catalog, defaultRoot: string = DEFAULT_LIBRARY_ROOT)`; `RegisterIpcDeps` gains `defaultLibraryRoot?: string` and `e2eEmit?: E2EEmit | null`. (`src/main/protocol.ts`): `RegisterProtocolsDeps` gains `e2eEmit?: E2EEmit | null`. (`src/main/drag.ts`): `registerDragHandler(resolvePath, e2eEmit: E2EEmit | null = null)`.

- [ ] **Step 1: Failing unit tests** — `src/main/e2e.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { E2EConfigError, makeE2EEmitter, readE2EConfig } from './e2e';

describe('readE2EConfig', () => {
  it('is null when NTWINE_E2E is unset (the app is v1)', () => {
    expect(readE2EConfig({})).toBeNull();
    expect(readE2EConfig({ NTWINE_USER_DATA: '/tmp/x' })).toBeNull(); // overrides alone do nothing
  });
  it('is null when NTWINE_E2E is any value but "1"', () => {
    expect(readE2EConfig({ NTWINE_E2E: 'true', NTWINE_USER_DATA: '/tmp/x' })).toBeNull();
  });
  it('refuses to arm without an absolute NTWINE_USER_DATA', () => {
    expect(() => readE2EConfig({ NTWINE_E2E: '1' })).toThrow(E2EConfigError);
    expect(() => readE2EConfig({ NTWINE_E2E: '1', NTWINE_USER_DATA: 'relative/dir' })).toThrow(/NTWINE_USER_DATA/);
  });
  it('reads the full contract when armed', () => {
    const cfg = readE2EConfig({
      NTWINE_E2E: '1', NTWINE_USER_DATA: '/tmp/ud', NTWINE_APP_DATA: '/tmp/ad',
      NTWINE_LIBRARY_ROOT: '/tmp/lib', NTWINE_E2E_BOOT_MARKER: '/tmp/marker',
    });
    expect(cfg).toStrictEqual({ userData: '/tmp/ud', appData: '/tmp/ad', libraryRoot: '/tmp/lib', bootMarker: '/tmp/marker' });
  });
  it('leaves optional overrides null when absent', () => {
    expect(readE2EConfig({ NTWINE_E2E: '1', NTWINE_USER_DATA: '/tmp/ud' })).toStrictEqual({ userData: '/tmp/ud', appData: null, libraryRoot: null, bootMarker: null });
  });
});

describe('makeE2EEmitter', () => {
  it('is null when unarmed — no hook can be installed', () => {
    const app = { emit: vi.fn() };
    expect(makeE2EEmitter(app, null)).toBeNull();
    expect(app.emit).not.toHaveBeenCalled();
  });
  it('forwards (event, payload) to app.emit when armed', () => {
    const app = { emit: vi.fn(() => true) };
    const emit = makeE2EEmitter(app, { userData: '/tmp/ud', appData: null, libraryRoot: null, bootMarker: null });
    emit!('ntwine:e2e:drag', { sampleId: 3, file: null });
    expect(app.emit).toHaveBeenCalledWith('ntwine:e2e:drag', { sampleId: 3, file: null });
  });
});
```

Use `path.win32`-safe absolutes on Windows: the test file's `/tmp/…` literals are absolute on POSIX only — write them as `path.resolve('tmp-e2e')` if the suite runs on Windows (it will: `isAbsolute` is what the implementation checks). Concretely: `const ABS = path.resolve('e2e-tmp');` and use `ABS` in place of every `/tmp/...` above.

- [ ] **Step 2: Run — FAIL** (`cd <repo> && yarn test src/main/e2e.test.ts` → module not found).

- [ ] **Step 3: Implement `src/main/e2e.ts`:**

```ts
import { isAbsolute } from 'node:path';

/**
 * The app's E2E-mode contract (e2e spec §3.1). Pure on purpose: main.ts is un-importable under
 * Vitest (module-scope Electron side effects), so every decision lives here and main.ts only
 * wires the result. NOTHING is honoured unless NTWINE_E2E === '1'.
 */
export interface E2EConfig {
  userData: string;
  appData: string | null;
  libraryRoot: string | null;
  bootMarker: string | null;
}

export class E2EConfigError extends Error {}

export function readE2EConfig(env: NodeJS.ProcessEnv): E2EConfig | null {
  if (env.NTWINE_E2E !== '1') return null;
  const userData = env.NTWINE_USER_DATA;
  // A missed override on the PACKAGED binary would otherwise land in the developer's real
  // <appData>/Ntwine/ntwine-data — refusing to boot is the structural guard.
  if (!userData || !isAbsolute(userData)) {
    throw new E2EConfigError('NTWINE_E2E=1 requires NTWINE_USER_DATA=<absolute dir>; refusing to boot against the real user-data directory');
  }
  return {
    userData,
    appData: env.NTWINE_APP_DATA ?? null,
    libraryRoot: env.NTWINE_LIBRARY_ROOT ?? null,
    bootMarker: env.NTWINE_E2E_BOOT_MARKER ?? null,
  };
}

export type E2EEmit = (event: string, payload: unknown) => void;
export interface EmitterLike {
  emit(eventName: string, ...args: unknown[]): boolean;
}

export function makeE2EEmitter(app: EmitterLike, cfg: E2EConfig | null): E2EEmit | null {
  if (cfg === null) return null;
  return (event, payload) => {
    app.emit(event, payload);
  };
}
```

`src/shared/e2eTypes.ts`:

```ts
// Read-only renderer snapshot for the e2e suite (e2e spec §3.1). Types only — no runtime code.
export interface E2ESnapshot {
  rows: number;
  resultCount: number;
  selectedId: number | null;
  volume: number;
  filters: Record<string, unknown>;
  importPhase: string | null;
  running: boolean;
  peaksCached: number;
  playCount: number;
  lastPlayedId: number | null;
}
```

- [ ] **Step 4: Run — PASS.** Commit: `feat(e2e): E2E-mode config + emitter (pure, unit-pinned)`.

- [ ] **Step 5: Wire main.ts** (module scope, directly under `registerProtocolSchemes();`):

```ts
import { mkdirSync, writeFileSync } from 'node:fs';           // mkdirSync already imported — extend
import { makeE2EEmitter, readE2EConfig, type E2EConfig } from './main/e2e';

// E2E mode (e2e spec §3.1). Read BEFORE whenReady: app.setPath must precede any getPath, and a
// config error must never reach Electron's "JavaScript error in main process" dialog (a modal
// that would hang a headless run) — log and exit instead.
let e2e: E2EConfig | null = null;
try {
  e2e = readE2EConfig(process.env);
} catch (err) {
  console.error(String(err));
  app.exit(2);
}
if (e2e) {
  // app.setPath throws when the directory does not exist (Electron docs) — create first.
  mkdirSync(e2e.userData, { recursive: true });
  app.setPath('userData', e2e.userData);
  if (e2e.appData) {
    mkdirSync(e2e.appData, { recursive: true });
    app.setPath('appData', e2e.appData);
  }
}
const e2eEmit = makeE2EEmitter(app, e2e);
```

In `createWindow`: `webPreferences: { preload: ..., additionalArguments: e2e ? ['--ntwine-e2e'] : [] }`; the window-open handler becomes
`win.webContents.setWindowOpenHandler(({ url }) => { e2eEmit?.('ntwine:e2e:window-open-denied', { url }); return { action: 'deny' }; });`;
inside `will-navigate`'s `if (!isAppOrigin) { event.preventDefault(); e2eEmit?.('ntwine:e2e:nav-denied', { url: event.url }); }`;
and after the load call:

```ts
  // Fuse-safe packaged boot probe (e2e spec §4 packaged.spec): the packaged binary's fuses disable
  // the Node inspector Playwright's driver needs, so the probe is "boot, load, write a marker, quit".
  if (e2e?.bootMarker) {
    const marker = e2e.bootMarker;
    win.webContents.once('did-finish-load', () => {
      writeFileSync(marker, app.getPath('userData'));
      app.quit();
    });
  }
```

In `whenReady`: `const getLibraryRoot = () => currentLibraryRoot(catalog, e2e?.libraryRoot ?? undefined);`, `registerProtocols({ catalog, getLibraryRoot, coversDir, e2eEmit });`, `registerDragHandler((sampleId) => resolveSampleAbsPath(catalog, getLibraryRoot(), sampleId), e2eEmit);`, and `registerIpc({ ..., defaultLibraryRoot: e2e?.libraryRoot ?? undefined, e2eEmit })`.

- [ ] **Step 6: Wire drag.ts** — signature `registerDragHandler(resolvePath: (sampleId: number) => string | null, e2eEmit: E2EEmit | null = null)`; body:

```ts
    const resolved = resolvePath(Number(sampleId));
    const file = resolved && existsSync(resolved) ? resolved : null;
    // E2E mode observes the exact startDrag decision and SKIPS the native drag: an OS drag session
    // blocks until mouse-up, which no headless run can deliver (e2e spec §3.1).
    if (e2eEmit) {
      e2eEmit('ntwine:e2e:drag', { sampleId: Number(sampleId), file });
      return;
    }
    if (file) event.sender.startDrag({ file, icon });
```

- [ ] **Step 7: Wire protocol.ts** — `RegisterProtocolsDeps` gains `e2eEmit?: E2EEmit | null`; in `handler`, after `resolved` is computed:

```ts
    if (deps.e2eEmit) {
      const u = new URL(request.url);
      const idText = u.pathname.replace(/^\//, '');
      deps.e2eEmit('ntwine:e2e:protocol', {
        scheme: u.protocol.slice(0, -1),
        id: /^\d+$/.test(idText) ? Number(idText) : null,
        hit: resolved !== null,
      });
    }
```

- [ ] **Step 8: Wire ipc.ts** — `export function currentLibraryRoot(catalog: Catalog, defaultRoot: string = DEFAULT_LIBRARY_ROOT): string { return catalog.getMeta('library_root') ?? defaultRoot; }`; `RegisterIpcDeps` gains `defaultLibraryRoot?: string; e2eEmit?: E2EEmit | null;`; every `currentLibraryRoot(catalog)` inside `registerIpc` becomes `currentLibraryRoot(catalog, deps.defaultLibraryRoot)` (three sites: `waveformDeps`, `runImport`'s `libraryRoot`, `decodePreviewPcm`'s `resolvePath`); the `decodePreviewPcm` handler becomes

```ts
  ipcMain.handle('ntwine:decodePreviewPcm', async (_event, sampleId: number) => {
    const result = await decodePreviewPcm(
      {
        resolvePath: (id) => resolveSampleAbsPath(catalog, currentLibraryRoot(catalog, deps.defaultLibraryRoot), id),
        forkWorker: () => utilityProcess.fork(WORKER_PATH),
      },
      sampleId,
    );
    deps.e2eEmit?.('ntwine:e2e:preview-pcm', { sampleId, ok: result !== null });
    return result;
  });
```

Add a unit case to the existing `src/main/ipc.test.ts` neighbourhood or a new `it` in `e2e.test.ts` is NOT possible for `currentLibraryRoot` (it needs a Catalog) — instead extend `src/main/catalog/queries.test.ts`'s style: in a new `src/main/ipc.libraryRoot.test.ts` (Vitest, real `openCatalog` in a temp dir): `currentLibraryRoot(catalog)` → `join(homedir(),'Splice')`; `currentLibraryRoot(catalog, '/x')` → `'/x'`; after `catalog.setMeta('library_root','/persisted')` both calls → `'/persisted'` (persisted wins — production precedence preserved). Write it failing first (the second-arg call fails to compile / returns the default), then implement.

- [ ] **Step 9: Wire preload.ts** — after `const api`, before `exposeInMainWorld('ntwine', api)`:

```ts
// E2E flag (e2e spec §3.1): main appends `--ntwine-e2e` to webPreferences.additionalArguments
// only when armed; a sandboxed preload sees it in process.argv. The production `ntwine` bridge
// is untouched — this is a second, boolean-only exposure.
if (process.argv.includes('--ntwine-e2e')) {
  contextBridge.exposeInMainWorld('ntwineE2E', true);
}
```

- [ ] **Step 10: Wire renderer.tsx + global.d.ts** — `global.d.ts` adds to `Window`: `ntwineE2E?: true; __ntwineE2E?: () => E2ESnapshot;` (import the type from `../shared/e2eTypes`). In `renderer.tsx`, replace the `playPort` construction and add the snapshot:

```ts
import { toJS } from 'mobx';
import type { E2ESnapshot } from './shared/e2eTypes';
import type { PlayPort } from './renderer/stores/PlayerStore';

const basePort = createPreviewPlayer({ fetchBytes, decodeFallback: api.decodePreviewPcm, sampleUrl: api.sampleUrl });

// E2E mode (armed by preload when main passed --ntwine-e2e): count plays before delegating, so a
// replay served from previewPlayer's buffer cache — no fetch, no protocol seam — is still
// observable. Explicit delegation, not a spread: createPreviewPlayer returns a class instance.
const e2eArmed = window.ntwineE2E === true;
let playCount = 0;
let lastPlayedId: number | null = null;
const playPort: PlayPort = e2eArmed
  ? {
      play: (id) => { playCount++; lastPlayedId = id; basePort.play(id); },
      stop: () => basePort.stop(),
      setVolume: (v) => basePort.setVolume(v),
    }
  : basePort;

const stores: Stores = { library: new LibraryStore(api), player: new PlayerStore(playPort), importStore: new ImportStore(api) };

if (e2eArmed) {
  // Attached synchronously, before any async work — the harness waits on typeof === 'function'.
  window.__ntwineE2E = (): E2ESnapshot => ({
    rows: stores.library.rows.length,
    resultCount: stores.library.resultCount,
    selectedId: stores.player.selectedId,
    volume: stores.player.volume,
    filters: toJS(stores.library.filters) as Record<string, unknown>,
    importPhase: stores.importStore.phase,
    running: stores.importStore.running,
    peaksCached: stores.library.peaksCache.size,
    playCount,
    lastPlayedId,
  });
}
```

Every field read above exists at HEAD with exactly these names: `ImportStore.phase: ImportProgress['phase'] | null` and `.running`; `LibraryStore.rows`, `.filters: QueryFilters`, `.peaksCache: Map<number, ArrayBuffer>`, `get resultCount()`; `PlayerStore.selectedId: number | null`, `.volume = 1`; `PlayPort { play(id); stop(); setVolume(v) }` in `src/renderer/stores/PlayerStore.ts`.

- [ ] **Step 11: Gates + unarmed boot check.** `yarn test && yarn typecheck && yarn lint` green. Then `yarn start` (unarmed) — app boots to the library exactly as before, DevTools opens (dev), no `window.__ntwineE2E` (`typeof window.__ntwineE2E` in the DevTools console is `'undefined'`; verify via a temporary `executeJavaScript` log if DevTools is not driveable, revert before commit). Kill the app by process tree.

- [ ] **Step 12: Commit** — `feat(e2e): app honours the E2E-mode contract (data dirs, library root, seams, snapshot, boot probe)`.

---

### Task 2: Runner + harness spike (risk-first) — proves the ABI strategy

**Files:**
- Modify: `package.json` (devDependency + scripts), `.gitignore`
- Create: `playwright.config.ts`, `tests/e2e/harness/launch.ts`, `tests/e2e/harness/seam.ts`, `tests/e2e/runner-abi.spec.ts`, `tests/e2e/boot.spec.ts`

**Interfaces:**
- Produces (`launch.ts`): `export const REPO_ROOT: string`; `export function assertProductionArtifact(): void`; `export interface LaunchOptions { userData: string; appData?: string; libraryRoot?: string; extraEnv?: Record<string, string> }`; `export interface Launched { app: ElectronApplication; page: Page; seam: Seam; close(): Promise<void> }`; `export async function launchNtwine(opts: LaunchOptions): Promise<Launched>`.
- Produces (`seam.ts`): `export interface Seam { arm(name: string): Promise<void>; count(name: string): Promise<number>; drain<T = unknown>(name: string): Promise<T[]> }`; `export function createSeam(app: ElectronApplication): Seam`.
- Produces (scripts): `yarn e2e` (`electron-forge package && yarn e2e:only`), `yarn e2e:only`, `yarn e2e:real`.

- [ ] **Step 1: Deps + scripts.** `cd <repo> && yarn add -D --exact @playwright/test@1.62.1` (add `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to the command's env; then confirm no browsers were pulled: `ls ~/Library/Caches/ms-playwright 2>/dev/null` shows nothing new). Scripts:

```json
"e2e": "electron-forge package && yarn e2e:only",
"e2e:only": "cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/@playwright/test/cli.js test --project default",
"e2e:real": "cross-env NTWINE_E2E_REAL=1 ELECTRON_RUN_AS_NODE=1 electron ./node_modules/@playwright/test/cli.js test --project real"
```

`.gitignore` += `playwright-report/`, `test-results/`.

- [ ] **Step 2: `playwright.config.ts`:**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1, // one Electron instance at a time
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'default', grepInvert: /@real/ },
    { name: 'real', grep: /@real/, timeout: 15 * 60_000 }, // ~612 sequential live cover fetches
  ],
});
```

- [ ] **Step 3: `tests/e2e/harness/seam.ts`:**

```ts
import type { ElectronApplication } from '@playwright/test';

/**
 * Records main-process seam events (e2e spec §3.1). `arm` installs a recorder in main and RESOLVES
 * ONLY AFTER it is installed — always `await seam.arm(...)` before the action under test, then
 * assert with `expect.poll(() => seam.count(...))`. Negatives are counters that stay flat while a
 * sibling positive increments — never "no event within a timeout".
 */
export interface Seam {
  arm(name: string): Promise<void>;
  count(name: string): Promise<number>;
  drain<T = unknown>(name: string): Promise<T[]>;
}

type Slot = { count: number; payloads: unknown[] };
type G = typeof globalThis & { __ntwineSeam?: Record<string, Slot> };

export function createSeam(app: ElectronApplication): Seam {
  return {
    arm: (name) =>
      app.evaluate(({ app }, name) => {
        const g = globalThis as G;
        g.__ntwineSeam ??= {};
        if (g.__ntwineSeam[name]) return;
        const slot: Slot = { count: 0, payloads: [] };
        g.__ntwineSeam[name] = slot;
        app.on(name, (payload: unknown) => {
          slot.count++;
          slot.payloads.push(payload);
        });
      }, name),
    count: (name) =>
      app.evaluate((_electron, name) => (globalThis as G).__ntwineSeam?.[name]?.count ?? 0, name),
    drain: <T,>(name: string) =>
      app.evaluate((_electron, name) => {
        const slot = (globalThis as G).__ntwineSeam?.[name];
        return (slot ? slot.payloads.splice(0) : []) as T[];
      }, name),
  };
}
```

(The `type Slot`/`type G` declarations are re-declared inside the evaluate callbacks if the transpiler complains that they are not serializable — they are types only and erase; if `tsc` complains about `G` inside the callback, inline the cast.)

- [ ] **Step 4: `tests/e2e/harness/launch.ts`:**

```ts
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSeam, type Seam } from './seam';

export const REPO_ROOT = join(__dirname, '..', '..', '..');
const MAIN_JS = join(REPO_ROOT, '.vite', 'build', 'main.js');
const RENDERER_INDEX = join(REPO_ROOT, '.vite', 'renderer', 'main_window', 'index.html');

/** `.vite/build/main.js` is written by BOTH `yarn start` (dev) and `electron-forge package` (prod);
 * only the production build is a valid launch target (e2e spec §3.3). */
export function assertProductionArtifact(): void {
  if (!existsSync(MAIN_JS) || !existsSync(RENDERER_INDEX)) {
    throw new Error('e2e: no production build found — run `yarn e2e` (or `yarn package`) first');
  }
  if (readFileSync(MAIN_JS, 'utf8').includes('http://localhost:')) {
    throw new Error('e2e: .vite/build/main.js is a DEV build (yarn start) — run `yarn package` first');
  }
}

export interface LaunchOptions {
  userData: string;
  appData?: string;
  libraryRoot?: string;
  extraEnv?: Record<string, string>;
}
export interface Launched {
  app: ElectronApplication;
  page: Page;
  seam: Seam;
  close(): Promise<void>;
}

export async function launchNtwine(opts: LaunchOptions): Promise<Launched> {
  assertProductionArtifact();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NTWINE_E2E: '1',
    NTWINE_USER_DATA: opts.userData,
    ELECTRON_ENABLE_LOGGING: '1',
    ...(opts.appData ? { NTWINE_APP_DATA: opts.appData } : {}),
    ...(opts.libraryRoot ? { NTWINE_LIBRARY_ROOT: opts.libraryRoot } : {}),
    ...opts.extraEnv,
  };
  // The RUNNER is Electron-as-Node (yarn e2e:only); the APP must not be.
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [MAIN_JS], env, cwd: REPO_ROOT });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__ntwineE2E === 'function');
  return { app, page, seam: createSeam(app), close: () => app.close() };
}
```

- [ ] **Step 5: The two spike specs.** `tests/e2e/runner-abi.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';

// Proves the runner process itself is on Electron's ABI (e2e spec §3.3 primary strategy): the
// fixture builder (Task 3) and the real-library smoke import better-sqlite3 in THIS process.
test('better-sqlite3 loads in the Playwright runner process', () => {
  const db = new Database(':memory:');
  expect(db.prepare('select sqlite_version() as v').get()).toMatchObject({ v: expect.any(String) });
  db.close();
});
```

`tests/e2e/boot.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchNtwine } from './harness/launch';

test('the production build boots in E2E mode against empty temp dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-boot-'));
  const launched = await launchNtwine({ userData: join(root, 'userData'), appData: join(root, 'appData') });
  try {
    const { page } = launched;
    await expect(page.getByText('Splice database')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import library' })).toBeVisible();
    // Empty appData → the real detection glob finds nothing.
    await expect(page.getByText('not found')).toBeVisible();
    // The snapshot is live and the app is unimported.
    const snap = await page.evaluate(() => window.__ntwineE2E!());
    expect(snap.running).toBe(false);
    expect(snap.rows).toBe(0);
    // userData landed in OUR temp dir, not the developer's.
    const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
    expect(userData).toBe(join(root, 'userData'));
  } finally {
    await launched.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run the spike.** `cd <repo> && yarn package` (first ever — takes a minute; F7 is not needed for `.vite/` to be produced), then `yarn e2e:only`. **Expected: 2 passed.** Record in the report: Playwright version, that `runner-abi` passed (ABI proven), that the app window appeared and `app.getPath('userData')` was the temp dir (env replaced, `ELECTRON_RUN_AS_NODE` stripped).
  **If `runner-abi` fails with an ABI/`NODE_MODULE_VERSION` error, or `boot` fails because the launched process ran as Node (no window / `firstWindow` timeout):** STOP the primary strategy and switch to the fallback, in this task: (a) `e2e:only` becomes plain `playwright test --project default`; (b) `tests/e2e/fixture/cli.ts` (Task 3) becomes the SQLite owner, built by `vite.e2e.config.ts` (a copy of `vite.main.config.ts` with `input: { fixtureCli: 'tests/e2e/fixture/cli.ts' }`, `outDir: '.vite/e2e'`, `external: ['better-sqlite3']`) and executed by the harness via `execFileSync(require('electron'), ['.vite/e2e/fixtureCli.js', ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })`; (c) `runner-abi.spec.ts` is deleted and replaced by a spec that spawns the helper; (d) `.gitignore` += `.vite/e2e/`. Record which branch was taken as the FIRST line of the report — every later task's dispatch carries it.

- [ ] **Step 7: Gates** — `yarn test && yarn typecheck && yarn lint` (the specs are typed by `tsc` and linted by `eslint .`; fix any lint on the new files, never by disabling rules).

- [ ] **Step 8: Commit** — `feat(e2e): Playwright harness — runner under Electron's Node, production-artifact launch, seam recorder; boot + ABI spikes green`.

---

### Task 3: Shared audio generator + fixture library builder

**Files:**
- Create: `tests/support/sineAudio.ts`, `tests/e2e/fixture/library.ts`, `tests/e2e/fixture.spec.ts`
- Modify: `src/main/waveforms/decode.test.ts` (generate inputs), delete `scripts/gen-fixture-audio.mjs`, delete `tests/fixtures/sine.wav`, `tests/fixtures/sine.aiff`

**Interfaces:**
- Produces (`tests/support/sineAudio.ts`): `export function sinePcm16(ms: number, hz = 440, rate = 44100): Int16Array`; `export function writeSineWav(path: string, ms: number, hz?: number): void`; `export function writeSineAiff(path: string, ms: number, hz?: number): void` — 44100 Hz mono 16-bit, byte-for-byte the algorithm of the deleted script (RIFF/WAVE 44-byte header; FORM/AIFF with COMM 80-bit extended rate `40 0E AC 44 00×6` and SSND).
- Produces (`tests/e2e/fixture/library.ts`):
  ```ts
  export interface FixtureLibrary {
    root: string; userData: string; appData: string; libraryRoot: string;
    totalSamples: number;                                  // 12
    packs: string[];                                       // ['Alpha Drums', 'Beta Keys', 'Gamma FX'] (rail order = name asc)
    coveredPacks: string[];                                // ['Alpha Drums', 'Beta Keys']
    uncoveredPack: string;                                 // 'Gamma FX'
    perPack: Record<string, number>;                       // { 'Alpha Drums': 6, 'Beta Keys': 3, 'Gamma FX': 3 }
    counts: { oneshot: number; loop: number; keyCSharp: number; keyA: number; keyNull: number; bpm100to140: number; tagKick: number; tagSnare: number; tagDrums: number; kickAndSnare: number };
    missingFilename: string; aiffFilenames: string[]; nfdFilename: string;
    keyBpmRow: { filename: string; pack: string; keyText: string; bpmText: string };   // AD_Loop_128_kick.wav · 'C♯ min' · '128'
    durationRow: { filename: string; durationText: string; tags: string[] };          // AD_Kick_02.wav · '1.4s' · ['drums','kick','punchy']
  }
  export function buildFixtureLibrary(root: string): FixtureLibrary
  ```
  Every number is computed from the `SAMPLES` table by `filter(...).length` — never typed twice.

- [ ] **Step 1: Failing test — `decode.test.ts` on generated inputs.** Change the two hardcoded `tests/fixtures/...` paths to files generated in `beforeAll` into `mkdtempSync(join(tmpdir(), 'ntwine-decode-'))` via `writeSineWav(join(dir, 'sine.wav'), 100)` / `writeSineAiff(join(dir, 'sine.aiff'), 100)`; add one assertion that both decode to `sampleRate === 44100` and `channels[0].length === 4410`. Run `yarn test src/main/waveforms/decode.test.ts` — **FAIL** (module `tests/support/sineAudio` missing).
- [ ] **Step 2: Implement `tests/support/sineAudio.ts`** — port the deleted script verbatim into the three functions (keep the comments about the AIFF extended-float rate). Run — **PASS**. Delete `scripts/gen-fixture-audio.mjs` and `tests/fixtures/sine.*` (`git rm`); `grep -rn "gen-fixture-audio\|tests/fixtures" src scripts package.json` must be empty. Commit: `refactor(fixtures): shared sine WAV/AIFF generator; decode test generates its inputs`.
- [ ] **Step 3: Failing test — `tests/e2e/fixture.spec.ts`** (runs in the runner, no app):

```ts
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureLibrary } from './fixture/library';

test('buildFixtureLibrary writes a Splice-shaped tree + sounds.db with the documented counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-fixture-'));
  try {
    const f = buildFixtureLibrary(root);
    expect(existsSync(f.userData)).toBe(true);
    const dbPath = join(f.appData, 'com.splice.Splice', 'users', 'default', 'e2e', 'sounds.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('select local_path, sample_type, bpm, audio_key, tags from samples').all() as {
      local_path: string; sample_type: string; bpm: number; audio_key: string | null; tags: string;
    }[];
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.sample_type === 'oneshot')).toHaveLength(8);
    expect(rows.filter((r) => r.audio_key === 'c#')).toHaveLength(3);
    expect(rows.filter((r) => r.audio_key === null)).toHaveLength(4);        // real NULL, not ''
    expect(rows.filter((r) => r.bpm >= 100 && r.bpm <= 140)).toHaveLength(4);
    expect(rows.filter((r) => /(^|,)\s*kick\s*(,|$)/i.test(r.tags))).toHaveLength(3);
    // 11 files exist, exactly one row's file is absent, all under libraryRoot
    const present = rows.filter((r) => existsSync(r.local_path));
    expect(present).toHaveLength(11);
    expect(rows.every((r) => r.local_path.startsWith(f.libraryRoot))).toBe(true);
    expect(rows.find((r) => !existsSync(r.local_path))!.local_path.endsWith(f.missingFilename)).toBe(true);
    // covers: 2 PNGs on disk, addressed by file URLs
    expect(readdirSync(join(root, 'covers-src'))).toHaveLength(2);
    const packs = db.prepare('select name, cover_url from packs').all() as { name: string; cover_url: string | null }[];
    expect(packs.filter((p) => p.cover_url?.startsWith('file:'))).toHaveLength(2);
    expect(packs.filter((p) => p.cover_url === null)).toHaveLength(1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Run `yarn e2e:only` — **FAIL** (module missing).

- [ ] **Step 4: Implement `tests/e2e/fixture/library.ts`.** Shape:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { buildFixtureSpliceDb, type FixtureRow } from '../../../src/main/importer/fixtureSpliceDb';
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
// tags: kick ×3, snare ×2, drums ×6 (case/space variants exercise parseTags: trim+lowercase+dedupe)
// ms is the DB `duration` value formatDuration renders (ms) — unrelated to the generated audio length.
// The builder stores `duration ?? 0` (fixtureSpliceDb.ts:138), so a NULL duration is not producible — none here.
const SAMPLES: Array<{ file: string; pack: 0 | 1 | 2; type: 'oneshot' | 'loop'; bpm: number; key: string | null; chord: 'major' | 'minor' | null; ms: number; tags: string; audioMs: number; kind: 'wav' | 'aiff' | 'missing' }> = [
  { file: 'AD_Kick_01.wav',        pack: 0, type: 'oneshot', bpm: 0,   key: null, chord: null,    ms: 412,  tags: 'Drums, kick',            audioMs: 400,  kind: 'wav' },
  { file: 'AD_Kick_02.wav',        pack: 0, type: 'oneshot', bpm: 0,   key: 'c#', chord: 'minor', ms: 1395, tags: 'drums,Kick ,punchy',     audioMs: 1400, kind: 'wav' },  // durationRow: 1.4s · tags drums,kick,punchy
  { file: 'AD_Snare_01.wav',       pack: 0, type: 'oneshot', bpm: 0,   key: null, chord: null,    ms: 300,  tags: 'drums, snare',            audioMs: 300,  kind: 'wav' },
  { file: 'AD_Snare_02.wav',       pack: 0, type: 'oneshot', bpm: 0,   key: 'a',  chord: null,    ms: 350,  tags: 'Drums,SNARE,tight',       audioMs: 350,  kind: 'wav' },
  { file: 'AD_Loop_128_kick.wav',  pack: 0, type: 'loop',    bpm: 128, key: 'c#', chord: 'minor', ms: 1875, tags: 'drums, loop, kick',       audioMs: 1800, kind: 'wav' },  // keyBpmRow: C♯ min · 128
  { file: 'AD_Loop_128_b.wav',     pack: 0, type: 'loop',    bpm: 128, key: 'a',  chord: 'major', ms: 1875, tags: 'drums, loop',             audioMs: 1800, kind: 'wav' },
  { file: 'BK_Chord_90.aiff',      pack: 1, type: 'loop',    bpm: 90,  key: 'a',  chord: 'major', ms: 2500, tags: 'keys, chord',             audioMs: 2500, kind: 'aiff' },
  { file: 'BK_Pluck.aiff',         pack: 1, type: 'oneshot', bpm: 0,   key: 'a',  chord: null,    ms: 800,  tags: 'keys, pluck',             audioMs: 800,  kind: 'aiff' },
  { file: 'BK_Pad_128.wav',        pack: 1, type: 'loop',    bpm: 128, key: 'c#', chord: 'major', ms: 2200, tags: 'keys, pad',               audioMs: 2200, kind: 'wav' },
  { file: 'GF_Riser_90.wav',       pack: 2, type: 'oneshot', bpm: 90,  key: null, chord: null,    ms: 2000, tags: 'fx, riser',               audioMs: 2000, kind: 'wav' },
  { file: 'GF_Impact_128.wav',     pack: 2, type: 'oneshot', bpm: 128, key: 'a',  chord: null,    ms: 900,  tags: 'fx, impact',              audioMs: 900,  kind: 'wav' },
  { file: 'GF_Café_Hit_90.wav', pack: 2, type: 'oneshot', bpm: 90, key: null, chord: null,  ms: 1500, tags: 'fx, hit',                 audioMs: 100,  kind: 'missing' }, // NFD é; the missing row
];
```

`buildFixtureLibrary(root)`: `mkdirSync` `userData/`, `appData/com.splice.Splice/users/default/e2e/`, `library/sounds/packs/<Pack>/vendor/`, `covers-src/`; write a tiny valid PNG (1×1 RGBA via `deflateSync` — a 67-byte file: signature, IHDR, IDAT, IEND with CRCs; implement `writePng1x1(path)` locally, ~25 lines) for the two covered packs; write each `wav`/`aiff` sample with the shared generator (`kind === 'missing'` writes nothing); build the DB rows: packs `{ table: 'packs', uuid, name, cover_url: covered ? pathToFileURL(png).toString() : null }`, samples `{ table: 'samples', file_hash: <unique>, local_path: <abs path>, filename, pack_uuid, sample_type, bpm, audio_key: key, chord_type: chord, duration: ms, tags }` — **pass `audio_key: null` / `chord_type: null` explicitly for the "none" rows**: `buildFixtureSpliceDb` maps `undefined` to `''` and only an explicit `null` to a real SQL NULL (`fixtureSpliceDb.ts:135-137`), and real Splice rows are NULL (v1's first real import crashed on exactly this shape); call `buildFixtureSpliceDb(dbPath, rows)`; return the `FixtureLibrary` with every count computed **from `SAMPLES`** (`filter(...).length`; `perPack` keyed by pack name; `kickAndSnare` = rows whose parsed tags include both), `keyBpmRow` = `AD_Loop_128_kick.wav` (`keyText: 'C♯ min'`, `bpmText: '128'` — what `formatKey('c#','minor')` renders), `durationRow` = `AD_Kick_02.wav` (`durationText: '1.4s'`, `tags: ['drums','kick','punchy']` — `parseTags` order), `missingFilename`, `aiffFilenames`, `nfdFilename`, `packs` (name-ascending, the rail's order), `coveredPacks`, `uncoveredPack`.

Run — **PASS**. Then hand-verify the fixture imports through the REAL app once (temporary spec or a `boot.spec` variant launched with this fixture's dirs, click Import, count reads `12 samples`) — this is the moment the whole strategy is proven end to end; keep that as `first-run.spec` in Task 4, but do the check now and note the outcome in the report.

- [ ] **Step 5: Gates** (`yarn test && yarn typecheck && yarn lint`, `yarn e2e:only`). **Step 6: Commit** — `feat(e2e): synthetic Splice-shaped fixture library with derived expectations`.

---

### Task 4: Playwright fixture, action helpers, `first-run` + `persistence` specs, test handles

**Files:**
- Create: `tests/e2e/harness/fixtures.ts`, `tests/e2e/harness/actions.ts`, `tests/e2e/first-run.spec.ts`, `tests/e2e/persistence.spec.ts`
- Modify: `src/renderer/components/FirstRun.tsx`, `TopBar.tsx`, `SampleRow.tsx`, `SettingsSheet.tsx`, `PackRail.tsx` (add exactly: `data-testid="detected-splice-db"` on the Splice-database `DetectedValue`, `data-testid="result-count"` on `ResultCount`, `data-testid="missing-badge"` on `MissingBadge`, `data-testid="settings-library-root"` on the Library-folder `FieldValue`, `data-testid="cover-fallback"` on `CoverFallback`); delete `tests/e2e/boot.spec.ts` (superseded by `first-run`).

**Interfaces:**
- Produces (`fixtures.ts`): `export const test = base.extend<{ ntwine: Launched & { fixture: FixtureLibrary; root: string } }>(...)`; `export { expect } from '@playwright/test'`. Every later spec imports `{ test, expect }` from `./harness/fixtures`.
- Produces (`actions.ts`): `importAndWait(page): Promise<void>` (click `Import library`, wait for `getByRole('listbox', { name: 'Sample list' })`), `readCount(page): Promise<number>` (parses `[data-testid=result-count]` text `/^(\d+) samples$/`), `snapshot(page): Promise<E2ESnapshot>` (`page.evaluate(() => window.__ntwineE2E!())`), `search(page, text)` (fill `Search samples`), `clickPack(page, name)` — the rail option's accessible name is `"<name> <count>"` (`PackRail.tsx`: `<Name>` + `<Count>`), so match `page.getByRole('listbox', { name: 'Packs' }).getByRole('option', { name: new RegExp('^' + escapeRegExp(name) + ' \\d+$') })`, `toggleType(page, 'One-shot' | 'Loop')` (`getByRole('button', { name, exact: true })`), `pickKey(page, key | '')` (`selectOption` on `Key filter`), `setBpm(page, min | '', max | '')` (fill `Minimum BPM`/`Maximum BPM`), `toggleTag(page, tag)` — the chip is a `<button>` whose accessible name is `"<tag> <count>"`, so `getByRole('button', { name: new RegExp('^' + escapeRegExp(tag) + ' \\d+$') })`, `rowByFilename(page, filename): Locator` — the `title` attribute lives on the `Filename` span inside the row, so `page.getByRole('listbox', { name: 'Sample list' }).getByRole('option').filter({ has: page.locator(`[title="${filename}"]`) })`, `openSettings(page)` (`getByRole('button', { name: 'Settings' })` — `App.tsx` gear), plus a local `escapeRegExp`. `waitForWaveform`/`isRealWaveform` are added to this file by Task 7.
- Consumes: `launchNtwine`, `buildFixtureLibrary`.

- [ ] **Step 1: `harness/fixtures.ts`:**

```ts
import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureLibrary, type FixtureLibrary } from '../fixture/library';
import { launchNtwine, type Launched } from './launch';

export type Ntwine = Launched & { fixture: FixtureLibrary; root: string };

export const test = base.extend<{ ntwine: Ntwine }>({
  ntwine: async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-'));
    const fixture = buildFixtureLibrary(root);
    const launched = await launchNtwine({ userData: fixture.userData, appData: fixture.appData, libraryRoot: fixture.libraryRoot });
    await use({ ...launched, fixture, root });
    await launched.close();
    // Windows: SQLite WAL handles can outlive app.close() briefly — retry, then tolerate.
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  },
});
export { expect };
```

- [ ] **Step 2: `first-run.spec.ts`** (failing first — the `data-testid`s don't exist yet):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAndWait, readCount } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

test('first run detects the fixture DB, imports, and lands on the library with every sample', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await expect(page.getByTestId('detected-splice-db')).toHaveText('found');
  await importAndWait(page);
  expect(await readCount(page)).toBe(fixture.totalSamples);            // 12
  await expect(page.getByTestId('result-count')).toHaveText(`${fixture.totalSamples} samples`);
});

test('the same detection reads "not found" against an empty appData (the glob is live)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-nodb-'));
  const l = await launchNtwine({ userData: join(root, 'ud'), appData: join(root, 'empty-appdata') });
  try {
    await expect(l.page.getByTestId('detected-splice-db')).toHaveText('not found');
  } finally {
    await l.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

`persistence.spec.ts`: import via `ntwine`, `close()`, `launchNtwine` again with the same three dirs → `getByRole('listbox', { name: 'Sample list' })` visible without any FirstRun (`getByRole('button', { name: 'Import library' })` count 0), `readCount === 12`; open settings → `getByTestId('settings-library-root')` has text `fixture.libraryRoot`.

- [ ] **Step 3: Run — FAIL** (test ids). **Step 4: add the five `data-testid`s + write `actions.ts`.** **Step 5: Run — PASS** (`yarn e2e:only`). Falsifier for the report: temporarily point `NTWINE_APP_DATA` at the empty dir in the first spec → `found` assertion fails; revert.
- [ ] **Step 6: Gates + commit** — `feat(e2e): Playwright fixture + action helpers; first-run and persistence pinned`.

---

### Task 5: `browse` + `rows` specs

**Files:** Create `tests/e2e/browse.spec.ts`, `tests/e2e/rows.spec.ts`.

- [ ] **Step 1: `browse.spec.ts`** — after `importAndWait`: the `Packs` listbox has 4 options whose names (regex-stripped of the trailing count) are `['All Samples', ...fixture.packs]` in that order; for each of `fixture.coveredPacks` the option contains an `img` with `naturalWidth > 0` (`await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0)`) whose `src` starts with `cover://p/`; the `fixture.uncoveredPack` option shows `[data-testid=cover-fallback]` visible; `clickPack(fixture.packs[0])` → `expect.poll(readCount)` equals `fixture.perPack[fixture.packs[0]]` (6); `clickPack('All Samples')` → `fixture.totalSamples`; the `All Samples` option's own count text equals `fixture.totalSamples` (the rail count is a second reading of the same number as the top bar — pin both).
- [ ] **Step 2: `rows.spec.ts`** — `rowByFilename(fixture.keyBpmRow.filename)` contains the texts `fixture.keyBpmRow.pack`, `fixture.keyBpmRow.keyText` (`C♯ min`) and `fixture.keyBpmRow.bpmText` (`128`); `rowByFilename(fixture.durationRow.filename)` contains `fixture.durationRow.durationText` (`1.4s`) and each of `fixture.durationRow.tags` (`drums`, `kick`, `punchy` — the first three in `parseTags` order; `MAX_INLINE_TAGS = 3`); a bpm-0 row (`AD_Kick_01.wav`) renders `—` for bpm and its key column renders `—` (both NULL sentinels — one row, two dashes; assert on the row's cell texts, not a bare `—` anywhere); the missing row (`fixture.missingFilename`) shows `[data-testid=missing-badge]` visible and has `toHaveCSS('opacity', '0.4')`; both `fixture.aiffFilenames` rows are present with no missing badge and no `couldn't decode` badge.
- [ ] **Step 3: Run — FAIL first** (write both files before any helper exists that they need; then implement/adjust helpers), **PASS**, falsifiers noted (e.g. change the expected `perPack` count → fails). **Step 4: Gates + commit** — `test(e2e): browse (rail, covers, scoping) and row rendering pinned`.

---

### Task 6: `filters` + `search` specs

**Files:** Create `tests/e2e/filters.spec.ts`, `tests/e2e/search.spec.ts`.

- [ ] **Step 1: `filters.spec.ts`** — sequence with `expect.poll(() => readCount(page))`: `toggleType('One-shot')` → `counts.oneshot` (8); `toggleType('One-shot')` again (off) → 12; `toggleType('Loop')` → 4; off → 12; `pickKey('c#')` → 3; `pickKey('')` → 12; `setBpm('100','140')` → 4; `setBpm('','')` → 12; `toggleTag('kick')` → 3; `toggleTag('snare')` (AND) → `counts.kickAndSnare`; toggle both off → 12; the tag-list text filter (`Filter tag list`) typed `sna` → only chips containing `sna` remain (assert the `snare` chip visible, the `kick` chip count 0); after all clears: `snapshot(page).filters` is `{}` (`toEqual({})` — `LibraryStore.patchFilters` deletes cleared keys rather than leaving them `undefined`; `toEqual` is right either way).
- [ ] **Step 2: `search.spec.ts`** — `search('kick')` → poll count 3; `search('kic')` → 3; `search('zzzqqq')` → 0 and `result-count` reads `0 samples`; `search('')` → 12; NFD pin: `search('Caf')` — measure once during implementation what the app returns for the ASCII prefix, and pin **that** with a comment `// pinned as-is (time capsule): FTS5 unicode61 folding on the NFD filename` and the number; also pin `search(fixture.nfdFilename.slice(0, 7))` similarly.
- [ ] **Step 3: FAIL → PASS**, falsifiers (e.g. break `toggleTag` AND semantics expectation), gates, commit — `test(e2e): every filter and search behaviour pinned to fixture-derived counts`.

---

### Task 7: `waveforms` + `preview` specs

**Files:** Create `tests/e2e/waveforms.spec.ts`, `tests/e2e/preview.spec.ts`; extend `harness/actions.ts` with `waitForWaveform`.

- [ ] **Step 1: canvas classifier in `actions.ts`:**

```ts
/** Real peaks draw accent-coloured bars away from the centre line; the null placeholder draws only a
 * thin centre line. Count non-background pixels in the top and bottom thirds (WaveformThumb.tsx). */
export async function isRealWaveform(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    const { width, height } = c;
    const d = ctx.getImageData(0, 0, width, height).data;
    const bg = [d[0], d[1], d[2], d[3]];
    let hits = 0;
    const third = Math.floor(height / 3);
    for (let y = 0; y < height; y++) {
      if (y >= third && y < height - third) continue;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (d[i] !== bg[0] || d[i + 1] !== bg[1] || d[i + 2] !== bg[2] || d[i + 3] !== bg[3]) hits++;
      }
    }
    return hits > 20;
  });
}
export const waitForWaveform = (canvas: Locator, real: boolean) =>
  expect.poll(() => isRealWaveform(canvas), { timeout: 30_000 }).toBe(real);
```

- [ ] **Step 2: `waveforms.spec.ts`** — after import: for every visible non-missing row (`page.getByRole('option')` within `Sample list`, filter out the missing one), `waitForWaveform(row.locator('canvas'), true)`; the missing row's canvas → `waitForWaveform(..., false)` (poll immediately resolves false and stays false — assert once after the others are real); `snapshot(page).peaksCached >= visibleNonMissing`.
- [ ] **Step 3: `preview.spec.ts`** — `await seam.arm('ntwine:e2e:protocol'); await seam.arm('ntwine:e2e:preview-pcm');` click `rowByFilename('AD_Kick_01.wav')` → `expect.poll(() => seam.count('ntwine:e2e:protocol'))` ≥ 1 and `drain` contains `{ scheme: 'sample', id, hit: true }` where `id` is the clicked row's sample id (get it from the option's `data-` attribute if present, else via `snapshot().selectedId`); `snapshot().selectedId === id`, `playCount === 1`; focus the list (`getByRole('listbox', { name: 'Sample list' }).focus()`), `keyboard.press('ArrowDown')` → `selectedId` changes to the next visible row's id, `playCount === 2`, a protocol hit for the new id; `keyboard.press('Space')` → `playCount === 3`, `lastPlayedId` unchanged, and the protocol counter did **not** increase (cache hit — assert equality of the counter before/after); click `rowByFilename('BK_Pluck.aiff')` → `expect.poll(() => seam.count('ntwine:e2e:preview-pcm'))` ≥ 1 with `{ ok: true }`; volume: `getByRole('slider', { name: 'Volume' }).fill('0.3')` (or `evaluate` a value + `input` event if `fill` on a range is refused) → `snapshot().volume` ≈ 0.3.
- [ ] **Step 4: FAIL → PASS**, falsifiers (comment out the `preview-pcm` emit → spec fails; comment out `playCount++` → fails), gates, commit — `test(e2e): waveform fill, preview via protocol/pcm seams, keyboard walk, replay from cache pinned`.

---

### Task 8: `drag` + `settings` + `security` specs

**Files:** Create `tests/e2e/drag.spec.ts`, `tests/e2e/settings.spec.ts`, `tests/e2e/security.spec.ts`.

- [ ] **Step 1: `drag.spec.ts`** — `await seam.arm('ntwine:e2e:drag')`; `rowByFilename('AD_Kick_01.wav').dispatchEvent('dragstart')` → poll count 1; `drain()[0]` is `{ sampleId: <number>, file: <string> }` with `file` absolute, `startsWith(fixture.libraryRoot)`, `existsSync(file)`; missing row: `toHaveAttribute('draggable', 'false')`, `dispatchEvent('dragstart')` on it, then a second real-row `dragstart` → poll count **2** (the missing dispatch contributed nothing — the counter went 1 → 2, not 3); bypass: `page.evaluate((id) => window.ntwine.startDrag(id), missingId)` → poll count 3 and the drained payload is `{ sampleId: missingId, file: null }` (get `missingId` from `window.ntwine.querySamples({ search: ... })` in `page.evaluate`, or from `snapshot()`-adjacent data — simplest: `page.evaluate(async () => (await window.ntwine.querySamples({})).find(r => r.missing)!.id)`).
- [ ] **Step 2: `settings.spec.ts`** — `openSettings(page)`; `getByTestId('settings-library-root')` has text `fixture.libraryRoot`; `getByRole('button', { name: 'Re-run import' })` click → poll until enabled again → close settings → `readCount === 12` (idempotent); re-pick: `await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog; }, fixture.libraryRoot)`; open settings, `Re-pick folder` → root text unchanged (same root) and `snapshot().running === false`; if the stub does not take effect (dialog captured by reference), implement the spec's fallback: E2E-armed `NTWINE_E2E_PICK_ROOT` read in `ipc.ts`'s handler (`deps.e2ePickRoot ?? await dialog.showOpenDialog(...)`), threaded from `readE2EConfig` (add `pickRoot: string | null`) — with a unit case in `e2e.test.ts`.
- [ ] **Step 3: `security.spec.ts`** — arm `ntwine:e2e:window-open-denied` and `ntwine:e2e:nav-denied`; `page.evaluate(() => { window.open('https://example.com'); })` → poll window-open counter 1, `app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1`; `const before = page.url(); page.evaluate(() => { location.href = 'https://example.com'; })` → poll nav counter 1, `page.url() === before`; `page.evaluate(() => typeof (window as unknown as { require?: unknown }).require) === 'undefined'`; `page.evaluate(() => Object.keys(window.ntwine).sort())` equals the sorted 12-method list (`coverUrl, decodePreviewPcm, getPeaks, getState, listPacks, listTags, onImportProgress, pickLibraryRoot, querySamples, runImport, sampleUrl, startDrag`); `page.evaluate(() => typeof window.__ntwineE2E) === 'function'`.
- [ ] **Step 4: FAIL → PASS**, falsifiers (drop the `nav-denied` emit → fails; make the missing row `draggable` → count 3 → fails), gates, commit — `test(e2e): drag chain both layers, settings re-import/re-pick, security fences pinned`.

---

### Task 9: Packaged boot probe (+ F7)

**Files:** Create `tests/e2e/harness/packaged.ts`, `tests/e2e/packaged.spec.ts`; Modify `forge.config.ts`.

- [ ] **Step 1: `packaged.ts`:**

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './launch';

export function packagedExecutable(): string {
  const dir = join(REPO_ROOT, 'out', `Ntwine-${process.platform}-${process.arch}`);
  const exe = process.platform === 'darwin' ? join(dir, 'Ntwine.app', 'Contents', 'MacOS', 'Ntwine')
    : process.platform === 'win32' ? join(dir, 'Ntwine.exe')
    : null;
  if (!exe) throw new Error(`packaged probe: unsupported platform ${process.platform}`);
  if (!existsSync(exe)) throw new Error(`packaged probe: ${exe} not found — run yarn package`);
  return exe;
}
```

- [ ] **Step 2: `packaged.spec.ts`:**

```ts
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagedExecutable } from './harness/packaged';

function run(exe: string, env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr }); });
  });
}
const baseEnv = (): Record<string, string> => { const e = { ...(process.env as Record<string, string>) }; delete e.ELECTRON_RUN_AS_NODE; return e; };

test('the packaged app boots, loads the renderer, and quits on the boot marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-pkg-'));
  const marker = join(root, 'booted.txt');
  try {
    const { code } = await run(packagedExecutable(), { ...baseEnv(), NTWINE_E2E: '1', NTWINE_USER_DATA: join(root, 'ud'), NTWINE_E2E_BOOT_MARKER: marker });
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(realpathSync(readFileSync(marker, 'utf8'))).toBe(realpathSync(join(root, 'ud')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the packaged app refuses E2E mode without NTWINE_USER_DATA', async () => {
  const { code, stderr } = await run(packagedExecutable(), { ...baseEnv(), NTWINE_E2E: '1' });
  expect(code).toBe(2);
  expect(stderr).toMatch(/NTWINE_USER_DATA/);
});
```

- [ ] **Step 3: Run against the CURRENT `out/` (no F7 yet)** — `yarn package && yarn e2e:only tests/e2e/packaged.spec.ts`. **Record the result honestly**: if the boot probe FAILS with a native-module load error, F7 was a real defect; if it PASSES, Electron's asar dlopen fallback carried it. Either way, **Step 4:** register the plugin (`import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'; … plugins: [new AutoUnpackNativesPlugin({}), new VitePlugin(...), new FusesPlugin(...)]` — Forge docs order: auto-unpack before the packaging plugins), `yarn package` again, both probes **PASS**, and `ls out/Ntwine-*/Ntwine.app/Contents/Resources/app.asar.unpacked` (macOS) shows `better-sqlite3`. Report which case occurred.
- [ ] **Step 5: Gates + commit** — `feat(e2e): packaged boot probe (fuse-safe marker) + auto-unpack natives (F7)`.

---

### Task 10: Real-library smoke (`@real`)

**Files:** Create `tests/e2e/real-library.spec.ts`.

- [ ] **Step 1:**

```ts
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSpliceDbCandidates } from '../../src/main/paths';
import { importAndWait, readCount } from './harness/actions';
import { launchNtwine } from './harness/launch';

const realAppData = (): string | null =>
  process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? (process.env.APPDATA ?? null)
  : null;

test('@real the real Splice library imports completely', async () => {
  test.skip(process.env.NTWINE_E2E_REAL !== '1', 'set NTWINE_E2E_REAL=1');
  const appData = realAppData();
  const db = appData ? resolveSpliceDbCandidates(appData)[0] : undefined;
  test.skip(!db, 'no Splice sounds.db detected on this machine');
  const expected = (new Database(db!, { readonly: true }).prepare('select count(*) as c from samples').get() as { c: number }).c;
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-real-'));
  const l = await launchNtwine({ userData: join(root, 'ud'), appData: appData!, libraryRoot: process.env.NTWINE_E2E_REAL_LIBRARY_ROOT ?? join(homedir(), 'Splice') });
  try {
    await importAndWait(l.page);            // network-bound: ~612 sequential cover fetches
    expect(await readCount(l.page)).toBe(expected);
  } finally { await l.close(); rmSync(root, { recursive: true, force: true }); }
});
```

`src/main/paths.ts` imports `app` from `electron` — under the runner (Electron-as-Node) that import yields a string and `app` is only touched inside `dataDir()`, which this spec never calls (same as `paths.test.ts` under Vitest). If the fallback runner strategy was taken in Task 2, read the count through the helper CLI instead.

- [ ] **Step 2:** `yarn e2e:real` on the owner's Mac (the only place it can run) — **PASS** with the real count (4,197 today; the assertion reads it live). Skip path verified by unsetting the env. Gates, commit — `test(e2e): opt-in real-library import smoke (@real)`.

---

### Task 11: CI workflow, README, DoD sweep

**Files:** Create `.github/workflows/e2e.yml`; Modify `README.md`.

- [ ] **Step 1: workflow:**

```yaml
name: e2e
on:
  workflow_dispatch:   # deliberately manual (spec D2) — flip to pull_request when the owner decides
jobs:
  e2e:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    env:
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
      CI: 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22        # host Node runs yarn/Forge/Vite only; app + tests run under Electron's Node
          cache: yarn
      - run: yarn --frozen-lockfile
      # ORDER IS LOAD-BEARING: `yarn e2e` runs `electron-forge package`, whose rebuild puts
      # better-sqlite3 on Electron's ABI; `yarn test` (Vitest under Electron's Node) fails
      # on the ABI mismatch if it runs before that.
      - run: yarn e2e
      - run: yarn test
      - run: yarn typecheck
      - run: yarn lint
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report-${{ matrix.os }}
          path: |
            playwright-report/
            test-results/
```

Validate: `node -e "require('js-yaml')"` is not available — use `yarn dlx yaml`? Simplest: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/e2e.yml'))"` (macOS has python3 + PyYAML? if not, `ruby -ryaml -e 'YAML.load_file(".github/workflows/e2e.yml")'`).

- [ ] **Step 2: README "Verification" section** (after the existing test/typecheck lines): the four gates (`yarn test`, `yarn typecheck`, `yarn lint`, `yarn e2e`), what `yarn e2e` does (packages, then Playwright under Electron's Node against the production build), `yarn e2e:only` (valid only right after a `package`; a `yarn start` in between makes the harness refuse), `yarn e2e:real` (opt-in, needs the real library, network-bound), the fresh-clone note (`yarn e2e` or `yarn start` once before `yarn test`), and that the workflow is dispatch-only.
- [ ] **Step 3: DoD sweep** on the committed tree: `yarn e2e` (full, from `package`) green; `yarn test && yarn typecheck && yarn lint` green; `git status --porcelain` empty; every spec in spec §4 present (`ls tests/e2e/*.spec.ts` = first-run, persistence, browse, rows, filters, search, waveforms, preview, drag, settings, security, packaged, real-library, runner-abi, fixture); the report lists each spec's falsifier line (collected from Tasks 4–10 reports).
- [ ] **Step 4: Commit** — `ci(e2e): dispatch-only workflow (macOS + Windows), README verification section`. Then push the branch (`git push -u origin feat/e2e-backstop`) — the PR is opened by the controller after the final review.

---

## Self-review checklist (run after writing, before execution)

- **Spec coverage:** §3.1 contract → Task 1 (env, guard, seams, additionalArguments, snapshot, boot marker, library root); §3.2 fixture → Task 3; §3.3 harness/runner/launch guard/config → Task 2 + 4; §3.4 waiting discipline → seam counters (Task 2) + `expect.poll` everywhere; §4 capsule rows → Tasks 4 (first-run, persistence), 5 (browse, rows), 6 (filters, search), 7 (waveforms, preview), 8 (drag, settings, security), 9 (packaged), 10 (@real); §5 gate/CI/README → Task 11; §6 pins/hygiene → Task 2 (deps, scripts, .gitignore) + Task 3 (fixture generator, deleted script); C1 F7 → Task 9; unit pins (e2e.test.ts, libraryRoot precedence, decode on generated audio) → Tasks 1, 3.
- **Placeholder scan:** none — the one "measure once and pin" item (NFD search prefix, Task 6) is an explicit time-capsule instruction with a named recording spot, not a deferral.
- **Type consistency:** `E2EConfig`/`E2EEmit`/`makeE2EEmitter` (Task 1) consumed by main/drag/protocol/ipc verbatim; `Launched`/`launchNtwine`/`Seam` (Task 2) consumed by fixtures (Task 4) and specs; `FixtureLibrary` fields (`perPack`, `keyBpmRow`, `durationRow`, `uncoveredPack`, `counts.*`) defined in Task 3 and read by name in Tasks 5–6; `E2ESnapshot` (Task 1) read by `snapshot()`; seam event names identical in Task 1's emitters and Tasks 7–8's specs.
- **Known judgment points the plan itself pins:** runner ABI (Task 2 spike, fallback named); F7 red/green recorded honestly (Task 9); dialog stub vs `NTWINE_E2E_PICK_ROOT` (Task 8, test either way).
