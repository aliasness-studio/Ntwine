import { describe, expect, it, vi, type Mock } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dialog, ipcMain } from 'electron';
import { openCatalog, type Catalog } from './catalog/db';
import { openUserDb } from './user/userDb';
import {
  currentLibraryRoot,
  decodePreviewPcm,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_SECONDS,
  registerIpc,
  resolveSpliceDb,
  runWaveformsInBackground,
  type DecodePreviewPcmDeps,
  type RunWaveformsInBackgroundDeps,
} from './ipc';
import type { WorkerLike } from './waveforms/queue';
import { buildFixtureSpliceDb } from './importer/fixtureSpliceDb';

// registerIpc (and drag.ts, transitively through main.ts in production) reaches for `electron`'s
// main-process singletons at call time. Under this test file's runner (`ELECTRON_RUN_AS_NODE=1`),
// `require('electron')` resolves to the path of the Electron binary — a plain string — rather than
// the real API object, so a bare `ipcMain.handle(...)` call throws (`.handle` on a string is
// undefined). Mocking the module gives `registerIpc` something real to call. The existing
// `decodePreviewPcm`/`runWaveformsInBackground`/`currentLibraryRoot` tests below never reference
// `electron` themselves (they operate entirely on injected deps), so this mock is transparent to
// them — one file, two harness styles.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') },
  dialog: { showOpenDialog: vi.fn() },
  net: { fetch: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-ipc-'));

// A one-shot WorkerLike fake: `on('message', cb)` registers the callback, then `postMessage`
// replies asynchronously (a microtask, not synchronously — matching queue.test.ts's own fake
// worker precedent) with whatever canned `reply` this fake was built with.
function makeFakeWorker(reply: unknown): {
  worker: WorkerLike;
  kill: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
} {
  let onMessage: ((m: unknown) => void) | null = null;
  const kill = vi.fn();
  const postMessage = vi.fn(() => {
    queueMicrotask(() => onMessage?.(reply));
  });
  const worker: WorkerLike = {
    postMessage,
    on: (_ev: 'message', cb: (m: unknown) => void) => {
      onMessage = cb;
    },
    kill,
  };
  return { worker, kill, postMessage };
}

describe('decodePreviewPcm', () => {
  it('refuses a file over PREVIEW_MAX_BYTES via statSync BEFORE forking a decode worker', async () => {
    const forkWorker = vi.fn<() => WorkerLike>();
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/huge-file.wav',
      forkWorker,
      statFn: () => ({ size: PREVIEW_MAX_BYTES + 1 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('returns null without forking when the resolver finds no safe file for the sample id', async () => {
    // Mirrors resolveSampleAbsPath's own null cases (no row / missing=1 / outside root) without
    // needing a real catalog here — decodePreviewPcm treats "resolver said no" as one outcome
    // regardless of which of those three reasons produced it.
    const forkWorker = vi.fn<() => WorkerLike>();
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => null,
      forkWorker,
      statFn: () => ({ size: 0 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('decodes through the one-shot worker, reassembles Float32Array channels, and kills the worker after the reply', async () => {
    const channelA = new Float32Array([0.1, 0.2, 0.3]);
    const channelB = new Float32Array([-0.1, -0.2, -0.3]);
    const { worker, kill, postMessage } = makeFakeWorker({
      sampleId: 42,
      ok: true,
      sampleRate: 44100,
      channels: [channelA.buffer, channelB.buffer],
    });
    const forkWorker = vi.fn(() => worker);
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/small-file.wav',
      forkWorker,
      statFn: () => ({ size: 1024 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(forkWorker).toHaveBeenCalledTimes(1);
    // The `kind: 'pcm'` discriminant is what tells peaksWorker.ts to take the PCM branch
    // instead of its default peaks-computation path.
    expect(postMessage).toHaveBeenCalledWith({
      sampleId: 42,
      absPath: '/fake/small-file.wav',
      kind: 'pcm',
    });
    expect(result).not.toBeNull();
    expect(result?.sampleRate).toBe(44100);
    expect(result?.channels).toHaveLength(2);
    // Compared against values round-tripped through Float32Array too (not the raw float64
    // literals) — 0.1 etc. aren't exactly representable in either width, and the two widths
    // round differently, so this is what an exact (not fuzzy) equality check requires.
    expect(result?.channels[0]).toEqual(channelA);
    expect(result?.channels[1]).toEqual(channelB);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('refuses decoded audio over PREVIEW_MAX_SECONDS (checked AFTER decode, using the real sampleRate)', async () => {
    // sampleRate=1 makes "seconds" and "sample count" the same number — PREVIEW_MAX_SECONDS + 1
    // samples crosses the threshold without allocating a real-audio-sized buffer in a test.
    const tooLong = new Float32Array(PREVIEW_MAX_SECONDS + 1);
    const { worker, kill } = makeFakeWorker({
      sampleId: 42,
      ok: true,
      sampleRate: 1,
      channels: [tooLong.buffer],
    });
    const forkWorker = vi.fn(() => worker);
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/long-file.wav',
      forkWorker,
      statFn: () => ({ size: 1024 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    // The worker still ran — this cap can only be checked after decode, unlike the byte cap —
    // and is still cleaned up even though the result is refused.
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('returns null (and still kills the worker) when the worker reports a decode failure', async () => {
    const { worker, kill } = makeFakeWorker({ sampleId: 42, ok: false, error: 'boom' });
    const forkWorker = vi.fn(() => worker);
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/corrupt-file.wav',
      forkWorker,
      statFn: () => ({ size: 1024 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('runWaveformsInBackground', () => {
  it('a synchronously-throwing forkWorker never escapes as an unhandled rejection (or a synchronous throw) — logs and leaves the pass a no-op', async () => {
    // Reproduces queue.ts's own documented rejection path (runPeaksQueue's promise "only
    // rejects if forkWorker itself throws synchronously while priming the pool") — a real,
    // acknowledged path (a broken install missing peaksWorker.js beside main.js, or resource
    // exhaustion), not a hypothetical one. Both real call sites (the runImport handler, the
    // startup-resume block in registerIpc) invoke this fire-and-forget with no try/catch of
    // their own — the startup-resume one runs unconditionally on every cold launch once
    // imported=1 — so a rejection here must degrade to "placeholders stay pending", never reach
    // process-level as an unhandled rejection.
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    const sendProgress = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const deps: RunWaveformsInBackgroundDeps = {
      catalog,
      libraryRoot: tmp(),
      sendProgress,
      forkWorker: () => {
        throw new Error('simulated: peaksWorker.js missing beside main.js');
      },
    };

    // The call itself — synchronous, fire-and-forget — must never throw.
    expect(() => runWaveformsInBackground(deps, [1])).not.toThrow();

    // forkWorker throws inside runPeaksQueue's own `new Promise(...)` executor, so the
    // constructor converts it into a rejection rather than a synchronous throw escaping
    // runPeaksQueue itself — flush pending microtasks so the .catch() handler has actually run
    // before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalled();
    // No 'done' event: the queue rejected, it never resolved — a no-op resume, not a false
    // "finished" signal to the renderer.
    expect(sendProgress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'done' }));

    consoleErrorSpy.mockRestore();
  });

  it('the happy path still forwards waveforms progress and announces done (the error handling wrap does not change normal behavior)', async () => {
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    const sendProgress = vi.fn();

    let onMessage: ((m: unknown) => void) | null = null;
    const kill = vi.fn();
    const worker: WorkerLike = {
      postMessage: (m: unknown) => {
        const { sampleId } = m as { sampleId: number };
        queueMicrotask(() => onMessage?.({ sampleId, ok: true, peaks: new ArrayBuffer(400) }));
      },
      on: (_ev: 'message', cb: (m: unknown) => void) => {
        onMessage = cb;
      },
      kill,
    };

    const deps: RunWaveformsInBackgroundDeps = {
      catalog,
      libraryRoot: tmp(),
      sendProgress,
      forkWorker: () => worker,
    };

    // sampleId 1 has no real `samples` row (empty catalog) — writePeaks would throw on the FK
    // constraint, which queue.ts's own settle() already catches and treats like a decode
    // failure (queue.test.ts pins this precedent directly); either way the queue still drains
    // and calls onProgress/resolves, which is all this test needs.
    runWaveformsInBackground(deps, [1]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendProgress).toHaveBeenCalledWith({ phase: 'waveforms', done: 1, total: 1 });
    expect(sendProgress).toHaveBeenCalledWith({ phase: 'done', done: 1, total: 1 });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('currentLibraryRoot', () => {
  // Precedence pin:
  // persisted > E2E override > Splice's reported folder > platform stock location.
  //
  // A persisted `library_root` must keep winning over an E2E `defaultLibraryRoot` override —
  // getting this backwards would mean an E2E run's NTWINE_LIBRARY_ROOT silently overrides a
  // library the user already picked via pickLibraryRoot in that same E2E userData dir. And the
  // E2E override must keep winning over detection, or a suite run on a machine with a real
  // Splice install would import against THAT library instead of its fixture.
  const HOME = join('/home', 'someone');
  const DOCS = join('/home', 'someone', 'Documents');
  const platformDefault = process.platform === 'win32' ? join(DOCS, 'Splice') : join(HOME, 'Splice');

  // Where THIS host's detection glob looks (mirrors resolveSpliceDb's own layout below), plus the
  // settings.json a real install keeps beside sounds.db.
  function plantDetectableSplice(appData: string, spliceFolder: string): void {
    const dir =
      process.platform === 'win32'
        ? join(appData, '..', 'Local', 'SpliceSettings', 'users', 'default', 'someuser')
        : join(appData, 'com.splice.Splice', 'users', 'default', 'someuser');
    mkdirSync(dir, { recursive: true });
    mkdirSync(spliceFolder, { recursive: true });
    writeFileSync(join(dir, 'sounds.db'), '');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ splice_folder: spliceFolder }));
  }

  it("falls back to the platform's stock Splice location when nothing is persisted and nothing is detectable", () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    expect(
      currentLibraryRoot(catalog, {
        appDataDir: join(dir, 'empty-appdata'),
        documentsDir: DOCS,
        homeDir: HOME,
      }),
    ).toBe(platformDefault);
  });

  it("uses Splice's own reported splice_folder over the platform default", () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    const appData = join(dir, 'appdata');
    const reported = join(dir, 'Splice-reported');
    plantDetectableSplice(appData, reported);
    expect(
      currentLibraryRoot(catalog, { appDataDir: appData, documentsDir: DOCS, homeDir: HOME }),
    ).toBe(reported);
  });

  it('the E2E override wins over a detectable real install', () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    const appData = join(dir, 'appdata');
    plantDetectableSplice(appData, join(dir, 'Splice-reported'));
    expect(
      currentLibraryRoot(catalog, {
        appDataDir: appData,
        documentsDir: DOCS,
        homeDir: HOME,
        e2eDefault: '/x',
      }),
    ).toBe('/x');
  });

  it('a persisted library_root wins over the E2E override, detection, and the platform default', () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    const appData = join(dir, 'appdata');
    plantDetectableSplice(appData, join(dir, 'Splice-reported'));
    catalog.setMeta('library_root', '/persisted');
    const deps = { appDataDir: appData, documentsDir: DOCS, homeDir: HOME };
    expect(currentLibraryRoot(catalog, deps)).toBe('/persisted');
    expect(currentLibraryRoot(catalog, { ...deps, e2eDefault: '/x' })).toBe('/persisted');
  });
});

// The 11 user-layer handlers registerIpc wires onto `deps.userDb`. `IpcHandler` mirrors
// what every `ipcMain.handle` listener in this codebase actually is — `async (event, ...args) =>
// ...` — so the harness below can `await`/`.resolves`/`.rejects` a captured handler exactly like
// Electron itself would invoke it.
type IpcHandler = (event: unknown, ...args: any[]) => Promise<unknown>;

function insertSample(catalog: Catalog, fileHash: string): number {
  const r = catalog.db
    .prepare(
      `INSERT INTO samples (file_hash, rel_path, filename, sample_type, missing) VALUES (?, ?, ?, 'oneshot', 0)`,
    )
    .run(fileHash, `p/${fileHash}.wav`, `${fileHash}.wav`);
  return Number(r.lastInsertRowid);
}

// Collects every `ipcMain.handle(channel, listener)` call registerIpc just made into a
// `Map<channel, handler>` — a `Map` (not the raw call array) is what lets a test address one
// channel by name without caring about registration order.
function registeredHandlers(): Map<string, IpcHandler> {
  const calls = (ipcMain.handle as unknown as Mock).mock.calls as [string, IpcHandler][];
  return new Map(calls);
}

function handlerFor(handlers: Map<string, IpcHandler>, channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`test setup: no handler registered for ${channel}`);
  return handler;
}

// Fresh catalog + userDb + a real registerIpc call per invocation — `mockClear()` first so a
// test's `registeredHandlers()` reflects only THIS call's registrations, not every prior test's
// in this same describe block (the mocked `ipcMain` singleton is shared module-wide).
function setUpUserIpc(): { catalog: Catalog; handlers: Map<string, IpcHandler> } {
  (ipcMain.handle as unknown as Mock).mockClear();
  const dir = tmp();
  const catalog = openCatalog(join(dir, 'catalog.db'));
  const userDb = openUserDb(catalog, join(dir, 'user.db'));
  registerIpc({
    catalog,
    snapshotDir: join(dir, 'splice-snapshot'),
    coversDir: join(dir, 'covers'),
    userDb,
    sendProgress: vi.fn(),
  });
  return { catalog, handlers: registeredHandlers() };
}

describe('registerIpc — user-layer handlers', () => {
  const NEW_CHANNELS = [
    'ntwine:setFavorite',
    'ntwine:setNickname',
    'ntwine:listUserTags',
    'ntwine:addUserTag',
    'ntwine:removeUserTag',
    'ntwine:listLibraryRail',
    'ntwine:createCollection',
    'ntwine:renameCollection',
    'ntwine:deleteCollection',
    'ntwine:addToCollection',
    'ntwine:removeFromCollection',
  ];

  it('registers all 11 new ntwine: channels', () => {
    const { handlers } = setUpUserIpc();
    for (const channel of NEW_CHANNELS) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('ntwine:setFavorite resolves sampleId -> file_hash through a real catalog row, then writes user.db state', async () => {
    const { catalog, handlers } = setUpUserIpc();
    const id = insertSample(catalog, 'hash-a');

    await handlerFor(handlers, 'ntwine:setFavorite')({}, id, true);

    const row = catalog.db
      .prepare(`SELECT favorite FROM user.sample_state WHERE sample_file_hash = 'hash-a'`)
      .get() as { favorite: number } | undefined;
    expect(row).toEqual({ favorite: 1 });
  });

  it('an unknown sampleId resolves without writing — never throws for a stale renderer id', async () => {
    const { catalog, handlers } = setUpUserIpc();

    await expect(handlerFor(handlers, 'ntwine:setFavorite')({}, 999999, true)).resolves.toBeUndefined();

    const count = catalog.db.prepare(`SELECT COUNT(*) AS n FROM user.sample_state`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('ntwine:createCollection rejects with a message carrying the UserNameError reason on a name collision', async () => {
    const { handlers } = setUpUserIpc();
    const createCollection = handlerFor(handlers, 'ntwine:createCollection');

    await createCollection({}, 'Drums');

    await expect(createCollection({}, ' drums ')).rejects.toThrow(/already exists/);
  });

  it('ntwine:listLibraryRail returns the { favorites, collections } shape', async () => {
    const { handlers } = setUpUserIpc();

    const rail = await handlerFor(handlers, 'ntwine:listLibraryRail')({});

    expect(rail).toEqual({ favorites: 0, collections: [] });
  });
});

// The Splice-DB picker fallback: detection's win32 glob is a
// best-guess — when it misses, the user must be able to point at sounds.db by hand, and that
// choice must persist and keep winning until it goes stale.
describe('resolveSpliceDb — manual override precedence', () => {
  // Mirrors the per-platform layout paths.ts actually globs (win32's verified real install keeps
  // the DB under ..\Local\SpliceSettings relative to the Roaming dir the resolver is handed).
  function plantCandidate(appData: string): string {
    const dir =
      process.platform === 'win32'
        ? join(appData, '..', 'Local', 'SpliceSettings', 'users', 'default', 'someuser')
        : join(appData, 'com.splice.Splice', 'users', 'default', 'someuser');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'sounds.db');
    writeFileSync(p, '');
    return p;
  }

  it('a persisted splice_db_path wins over a live glob candidate while the file exists', () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    const appData = join(dir, 'appdata');
    const globbed = plantCandidate(appData);
    const picked = join(dir, 'hand-picked-sounds.db');
    writeFileSync(picked, '');
    catalog.setMeta('splice_db_path', picked);
    expect(resolveSpliceDb(catalog, appData)).toBe(picked);
    expect(resolveSpliceDb(catalog, appData)).not.toBe(globbed);
  });

  it('a STALE override (file deleted) falls back to glob detection instead of failing', () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    const appData = join(dir, 'appdata');
    const globbed = plantCandidate(appData);
    catalog.setMeta('splice_db_path', join(dir, 'gone.db')); // never created
    expect(resolveSpliceDb(catalog, appData)).toBe(globbed);
  });

  it('no override and no candidates → null (getState reads this as "not found")', () => {
    const dir = tmp();
    const catalog = openCatalog(join(dir, 'catalog.db'));
    expect(resolveSpliceDb(catalog, join(dir, 'empty-appdata'))).toBeNull();
  });
});

describe('registerIpc — ntwine:pickSpliceDb', () => {
  const pickDialog = () => dialog.showOpenDialog as unknown as Mock;

  it('cancel → null, and nothing is persisted', async () => {
    const { catalog, handlers } = setUpUserIpc();
    pickDialog().mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(handlerFor(handlers, 'ntwine:pickSpliceDb')({})).resolves.toBeNull();
    expect(catalog.getMeta('splice_db_path')).toBeNull();
  });

  it('an invalid file rejects with a clear error and persists nothing', async () => {
    const { catalog, handlers } = setUpUserIpc();
    const bad = join(tmp(), 'random.txt');
    writeFileSync(bad, 'not a database');
    pickDialog().mockResolvedValueOnce({ canceled: false, filePaths: [bad] });
    await expect(handlerFor(handlers, 'ntwine:pickSpliceDb')({})).rejects.toThrow(/SQLite|database/i);
    expect(catalog.getMeta('splice_db_path')).toBeNull();
  });

  it('a valid sounds.db is persisted to splice_db_path and returned', async () => {
    const { catalog, handlers } = setUpUserIpc();
    const good = join(tmp(), 'sounds.db');
    buildFixtureSpliceDb(good, []);
    pickDialog().mockResolvedValueOnce({ canceled: false, filePaths: [good] });
    await expect(handlerFor(handlers, 'ntwine:pickSpliceDb')({})).resolves.toBe(good);
    expect(catalog.getMeta('splice_db_path')).toBe(good);
  });
});
